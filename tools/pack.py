#!/usr/bin/env python3
"""pack - turn a flat-shaded, palette-textured glTF (GLB) into bloop's compact mesh format.

Use: python3 -I pack.py IN.glb OUT.bin

The robin's GLB stores float32 positions, normals and UVs for every corner (non-indexed), but a
flat-shaded low-poly mesh needs none of that: normals come from the face, and the 1-pixel-per-
color palette texture collapses to one color index per face. Output layout, little-endian:
  'BLP1' | u16 nVerts | u16 nTris | u8 nColors | 3 pad | f32 min[3] | f32 max[3]
  | i16 pos[nVerts*3] (quantized to the bounding box) | u16 idx[nTris*3]
  | u8 faceColor[nTris] | u8 rgb[nColors*3]
"""
import gzip
import json
import struct
import sys
import zlib


def read_glb(path):
    data = open(path, 'rb').read()
    _, _, length = struct.unpack_from('<III', data, 0)
    off, chunks = 12, []
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        chunks.append(data[off + 8:off + 8 + clen])
        off += 8 + clen
    return json.loads(chunks[0]), chunks[1]


def accessor(gltf, binchunk, i):
    a = gltf['accessors'][i]
    bv = gltf['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[a['type']]
    fmt = {5126: 'f', 5123: 'H', 5125: 'I'}[a['componentType']]
    size = struct.calcsize(fmt)
    stride = bv.get('byteStride', n * size)
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return [struct.unpack_from('<' + fmt * n, binchunk, base + k * stride) for k in range(a['count'])]


def decode_png(raw):
    assert raw[:8] == b'\x89PNG\r\n\x1a\n'
    off, idat, w = 8, b'', 0
    while off < len(raw):
        ln, = struct.unpack_from('>I', raw, off)
        typ = raw[off + 4:off + 8]
        body = raw[off + 8:off + 8 + ln]
        if typ == b'IHDR':
            w, h, depth, ctype = struct.unpack_from('>IIBB', body, 0)
            assert depth == 8 and ctype in (2, 6), (depth, ctype)
            bpp = 3 if ctype == 2 else 4
        elif typ == b'IDAT':
            idat += body
        off += 12 + ln
    px = zlib.decompress(idat)
    rows, prev, stride, p = [], bytearray(w * bpp), w * bpp, 0
    for _ in range(h):
        f = px[p]
        line = bytearray(px[p + 1:p + 1 + stride])
        p += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line))
        prev = line
    return w, h, bpp, rows


def main(src, dst):
    gltf, binchunk = read_glb(src)
    prim = gltf['meshes'][0]['primitives'][0]
    pos = accessor(gltf, binchunk, prim['attributes']['POSITION'])
    uv = accessor(gltf, binchunk, prim['attributes']['TEXCOORD_0'])
    idx = [i[0] for i in accessor(gltf, binchunk, prim['indices'])] if 'indices' in prim else list(range(len(pos)))
    img = gltf['images'][gltf['textures'][0]['source']]
    bv = gltf['bufferViews'][img['bufferView']]
    w, h, bpp, rows = decode_png(binchunk[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']])

    def texel(u, v):
        x = min(w - 1, max(0, int(u * w)))
        y = min(h - 1, max(0, int(v * h)))
        return tuple(rows[y][x * bpp:x * bpp + 3])

    lo = [min(p[k] for p in pos) for k in range(3)]
    hi = [max(p[k] for p in pos) for k in range(3)]
    q = lambda v, k: round((v - lo[k]) / ((hi[k] - lo[k]) or 1) * 65534) - 32767
    uniq, remap = {}, []
    for p in pos:
        key = tuple(q(p[k], k) for k in range(3))
        remap.append(uniq.setdefault(key, len(uniq)))
    palette, faces, tris = {}, [], []
    for t in range(len(idx) // 3):
        a, b, c = idx[3 * t:3 * t + 3]
        tri = (remap[a], remap[b], remap[c])
        if len(set(tri)) < 3:
            continue
        u = (uv[a][0] + uv[b][0] + uv[c][0]) / 3
        v = (uv[a][1] + uv[b][1] + uv[c][1]) / 3
        faces.append(palette.setdefault(texel(u, v), len(palette)))
        tris.append(tri)
    assert len(uniq) < 65536 and len(palette) < 256
    verts = sorted(uniq.items(), key=lambda kv: kv[1])
    out = b'BLP1' + struct.pack('<HHB3x', len(verts), len(tris), len(palette))
    out += struct.pack('<6f', *lo, *hi)
    out += b''.join(struct.pack('<3h', *k) for k, _ in verts)
    out += b''.join(struct.pack('<3H', *t) for t in tris)
    out += bytes(faces)
    out += b''.join(bytes(c) for c, _ in sorted(palette.items(), key=lambda kv: kv[1]))
    open(dst, 'wb').write(out)
    gz = len(gzip.compress(out, 9))
    print(f'verts {len(verts)} tris {len(tris)} colors {len(palette)} bytes {len(out)} gzip {gz}')
    print('palette', ['#%02x%02x%02x' % c for c, _ in sorted(palette.items(), key=lambda kv: kv[1])])
    print('bbox', [round(v, 4) for v in lo], [round(v, 4) for v in hi])


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__.strip())
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
