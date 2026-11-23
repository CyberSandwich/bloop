#!/usr/bin/env python3
"""render-stills: draw the robin's still images with the live renderer's camera, light and poses.

Use: python3 -I tools/render-stills.py
Needs avifenc and cwebp on PATH (Homebrew: libavif, webp) and ImageMagick (`magick`) for resizing.
Reads public/robin.bin and tools/robin-poses.json; writes public/img/robin-{pose}-{w}.avif and .webp.

A plain-Python rasterizer, so no headless browser is needed. The math mirrors public/js/robin.js and
public/js/core/robin-pose.js (same projection, view distance, light and shading formula); the live
canvas and the still can still differ by antialiasing, which the poster-to-canvas fade hides.
"""
import json
import math
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MESH = ROOT / 'public' / 'robin.bin'
POSES = json.loads((ROOT / 'tools' / 'robin-poses.json').read_text())
OUT = ROOT / 'public' / 'img'
# design.md section 9, Stills: pose -> widths. Supersampled 2x, then downscaled.
STILLS = {'perch': [320, 640, 960, 1120], 'look': [560, 1120], 'turn': [560, 1120],
          'carry': [560, 1120], 'away': [192, 560, 1120]}
FOV_HALF = 0.32
DISTANCE = 1.7
LIGHT = (-0.4, 0.8, 0.6)
BASE_DROP = 0.06


def parse(buf):
    if buf[:4] != b'BLP1':
        sys.exit('not a BLP1 mesh')
    nv, nt, nc = struct.unpack_from('<HHB', buf, 4)
    lo = struct.unpack_from('<3f', buf, 12)
    hi = struct.unpack_from('<3f', buf, 24)
    pos = struct.unpack_from(f'<{nv * 3}h', buf, 36)
    idx = struct.unpack_from(f'<{nt * 3}H', buf, 36 + nv * 6)
    face = buf[36 + nv * 6 + nt * 6:36 + nv * 6 + nt * 7]
    pal = buf[36 + nv * 6 + nt * 7:36 + nv * 6 + nt * 7 + nc * 3]
    size = max(hi[k] - lo[k] for k in range(3))

    def at(i, k):
        return (((pos[3 * i + k] + 32767) / 65534) * (hi[k] - lo[k]) + lo[k] - (lo[k] + hi[k]) / 2) / size

    tris = []
    for t in range(nt):
        v = [[at(idx[3 * t + j], k) for k in range(3)] for j in range(3)]
        c = [pal[3 * face[t] + k] / 255 for k in range(3)]
        tris.append((v, c))
    return tris


def rotation(yaw, pitch, roll):
    """Row-major 3x3 for Rz(roll) * Rx(pitch) * Ry(yaw), the same product robin-pose.js builds."""
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)
    ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]]
    rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]]

    def mul(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]

    return mul(rz, mul(rx, ry))


def sub(a, b):
    return [a[k] - b[k] for k in range(3)]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def norm(a):
    n = math.sqrt(sum(x * x for x in a)) or 1
    return [x / n for x in a]


def render(tris, pose, px):
    r = rotation(pose['yaw'], pose['pitch'], pose['roll'])
    move = (pose['shift'], pose['lift'] - BASE_DROP, 0)
    f = 1 / math.tan(FOV_HALF)
    light = norm(LIGHT)
    depth = [math.inf] * (px * px)
    rgba = bytearray(px * px * 4)
    for v, c in tris:
        n = cross(sub(v[1], v[0]), sub(v[2], v[0]))
        nw = norm([sum(r[i][k] * n[k] for k in range(3)) for i in range(3)])
        d = max(sum(nw[k] * light[k] for k in range(3)), 0)
        shade = 0.58 + 0.42 * d + 0.06 * nw[1]
        col = bytes(max(0, min(255, round(ch * shade * 255))) for ch in c)
        screen = []
        for p in v:
            w = [sum(r[i][k] * p[k] for k in range(3)) + move[i] for i in range(3)]
            z = w[2] - DISTANCE
            sx = (f * w[0] / -z * 0.5 + 0.5) * px
            sy = (0.5 - f * w[1] / -z * 0.5) * px
            screen.append((sx, sy, -z))
        (x0, y0, z0), (x1, y1, z1), (x2, y2, z2) = screen
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if area == 0:
            continue
        minx, maxx = max(0, int(min(x0, x1, x2))), min(px - 1, int(max(x0, x1, x2)) + 1)
        miny, maxy = max(0, int(min(y0, y1, y2))), min(px - 1, int(max(y0, y1, y2)) + 1)
        for y in range(miny, maxy + 1):
            cy_ = y + 0.5
            for x in range(minx, maxx + 1):
                cx_ = x + 0.5
                w0 = ((x1 - cx_) * (y2 - cy_) - (x2 - cx_) * (y1 - cy_)) / area
                w1 = ((x2 - cx_) * (y0 - cy_) - (x0 - cx_) * (y2 - cy_)) / area
                w2 = 1 - w0 - w1
                if w0 < 0 or w1 < 0 or w2 < 0:
                    continue
                z = w0 * z0 + w1 * z1 + w2 * z2
                i = y * px + x
                if z < depth[i]:
                    depth[i] = z
                    rgba[4 * i:4 * i + 4] = col + b'\xff'
    return rgba


def png(path, rgba, px):
    raw = b''.join(b'\x00' + bytes(rgba[y * px * 4:(y + 1) * px * 4]) for y in range(px))

    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))

    head = struct.pack('>IIBBBBB', px, px, 8, 6, 0, 0, 0)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', head) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def run(*args):
    subprocess.run(args, check=True, capture_output=True)


def main():
    tris = parse(MESH.read_bytes())
    OUT.mkdir(exist_ok=True)
    only = sys.argv[1:] or list(STILLS)
    with tempfile.TemporaryDirectory() as tmp:
        for name in only:
            master = Path(tmp) / f'{name}.png'
            big = max(STILLS[name]) * 2
            png(master, render(tris, POSES[name], big), big)
            for w in STILLS[name]:
                sized = Path(tmp) / f'{name}-{w}.png'
                run('magick', str(master), '-filter', 'Lanczos', '-resize', f'{w}x{w}', '-strip', str(sized))
                run('avifenc', '-q', '60', '-s', '4', str(sized), str(OUT / f'robin-{name}-{w}.avif'))
                run('cwebp', '-q', '82', '-alpha_q', '90', '-m', '6', str(sized), '-o', str(OUT / f'robin-{name}-{w}.webp'))
                sizes = [(OUT / f'robin-{name}-{w}.{ext}').stat().st_size for ext in ('avif', 'webp')]
                print(f'robin-{name}-{w}: avif {sizes[0]} webp {sizes[1]}')


if __name__ == '__main__':
    main()
