#!/usr/bin/env python3
"""render-og: the social preview image (docs/design.md section 9): perch still at right, h1 at left.

Use: python3 -I tools/render-og.py   (after tools/render-stills.py; needs fonttools and ImageMagick)
Writes tools/og.svg (the editable source, Inter by family name) and public/og.png (1200 x 630), both
from the constants below, so a name change (SITE_NAME) is one edit and one run.
"""
import subprocess
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SITE_NAME = 'bloop'
LINES = ('Your slides.', 'On any screen.')
W, H = 1200, 630
BG, INK = '#FAFAFA', '#1D1D1F'
ROBIN = ROOT / 'public' / 'img' / 'robin-perch-1120.webp'
ROBIN_BOX = (600, 15, 600)  # x, y, size
MARK = (80, 120, 40)  # x, baseline, size
HEAD = (80, 330, 76, 84)  # x, first baseline, size, line step


def svg():
    x, base, size, step = HEAD
    text = ''.join(
        f'<text x="{x}" y="{base + i * step}" font-size="{size}" letter-spacing="{-0.032 * size:.2f}">{line}</text>'
        for i, line in enumerate(LINES))
    rx, ry, rs = ROBIN_BOX
    mx, mb, ms = MARK
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
            f'<title>{SITE_NAME}: {" ".join(LINES)}</title><rect width="{W}" height="{H}" fill="{BG}"/>'
            f'<image href="../public/img/robin-perch-1120.webp" x="{rx}" y="{ry}" width="{rs}" height="{rs}"/>'
            f'<g fill="{INK}" font-family="Inter" font-weight="600">'
            f'<text x="{mx}" y="{mb}" font-size="{ms}" letter-spacing="{-0.02 * ms:.2f}">{SITE_NAME}</text>{text}</g></svg>\n')


def main():
    (ROOT / 'tools' / 'og.svg').write_text(svg())
    with tempfile.TemporaryDirectory() as tmp:
        ttf = Path(tmp) / 'inter-600.ttf'
        font = instancer.instantiateVariableFont(TTFont(str(ROOT / 'src' / 'fonts' / 'InterVariable.woff2')),
                                                 {'wght': 600, 'opsz': 32})
        font.flavor = None
        font.save(str(ttf))
        rx, ry, rs = ROBIN_BOX
        mx, mb, ms = MARK
        x, base, size, step = HEAD
        args = ['magick', '-size', f'{W}x{H}', f'xc:{BG}',
                '(', str(ROBIN), '-resize', f'{rs}x{rs}', ')', '-geometry', f'+{rx}+{ry}', '-composite',
                '-font', str(ttf), '-fill', INK,
                '-pointsize', str(ms), '-kerning', f'{-0.02 * ms:.2f}', '-annotate', f'+{mx}+{mb}', SITE_NAME,
                '-pointsize', str(size), '-kerning', f'{-0.032 * size:.2f}']
        for i, line in enumerate(LINES):
            args += ['-annotate', f'+{x}+{base + i * step}', line]
        # Flat shading has few colors: a 256-color palette is a tenth of the size with no visible change.
        args += ['-strip', '-colors', '256', f"PNG8:{ROOT / 'public' / 'og.png'}"]
        subprocess.run(args, check=True)


if __name__ == '__main__':
    main()
