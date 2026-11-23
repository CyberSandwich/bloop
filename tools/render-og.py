#!/usr/bin/env python3
"""render-og: the social preview image and the touch icon (docs/design.md section 9), both from public/favicon.svg.

Use: python3 -I tools/render-og.py [--font PATH]   (needs ImageMagick; without --font, fonttools)
Writes tools/og.svg (the editable source, Inter by family name), public/og.png (1200 x 630) and
public/apple-touch-icon.png (180 x 180). --font takes a static Inter SemiBold file; without it the 600
instance is cut from src/fonts/InterVariable.woff2.
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / 'public' / 'favicon.svg'
SITE_NAME = 'bloop'
H1 = 'Present Anywhere'
SUB = 'Scan the code on the screen to present or download your files.'
W, H = 1200, 630
PAPER, INK, MUTED = '#F3F3F0', '#1E1E1C', '#6C6C66'
MARK = (80, 72, 72)  # x, y, size of the logo
NAME = (168, 126, 44)  # x, baseline, size of the wordmark
HEAD = (80, 372, 90)  # x, baseline, size: one line, as on the page
LEAD = (80, 440, 32)
ICON, ICON_MARK = 180, 132


def svg():
    mx, my, ms = MARK
    nx, nb, ns = NAME
    hx, hb, hs = HEAD
    lx, lb, ls = LEAD
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
            f'<title>{SITE_NAME}: {H1}</title><rect width="{W}" height="{H}" fill="{PAPER}"/>'
            f'<image href="../public/favicon.svg" x="{mx}" y="{my}" width="{ms}" height="{ms}"/>'
            f'<g font-family="Inter" font-weight="600" fill="{INK}">'
            f'<text x="{nx}" y="{nb}" font-size="{ns}" letter-spacing="{-0.03 * ns:.2f}">{SITE_NAME}</text>'
            f'<text x="{hx}" y="{hb}" font-size="{hs}" letter-spacing="{-0.05 * hs:.2f}">{H1}</text></g>'
            f'<text x="{lx}" y="{lb}" font-family="Inter" font-size="{ls}" fill="{MUTED}">{SUB}</text></svg>\n')


def semibold(tmp, font):
    if font:
        return font
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    ttf = Path(tmp) / 'inter-600.ttf'
    inst = instancer.instantiateVariableFont(TTFont(str(ROOT / 'src' / 'fonts' / 'InterVariable.woff2')),
                                             {'wght': 600, 'opsz': 32})
    inst.flavor = None
    inst.save(str(ttf))
    return str(ttf)


def logo(tmp, size):
    out = Path(tmp) / f'logo-{size}.png'
    subprocess.run(['magick', '-background', 'none', '-density', '600', f'MSVG:{LOGO}',
                    '-resize', f'{size}x{size}', str(out)], check=True)
    return str(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--font', help='a static Inter SemiBold file')
    args = parser.parse_args()
    (ROOT / 'tools' / 'og.svg').write_text(svg())
    with tempfile.TemporaryDirectory() as tmp:
        font = semibold(tmp, args.font)
        mx, my, ms = MARK
        nx, nb, ns = NAME
        hx, hb, hs = HEAD
        lx, lb, ls = LEAD
        subprocess.run([
            'magick', '-size', f'{W}x{H}', f'xc:{PAPER}',
            logo(tmp, ms), '-geometry', f'+{mx}+{my}', '-composite',
            '-font', font, '-fill', INK,
            '-pointsize', str(ns), '-kerning', f'{-0.03 * ns:.2f}', '-annotate', f'+{nx}+{nb}', SITE_NAME,
            '-pointsize', str(hs), '-kerning', f'{-0.05 * hs:.2f}', '-annotate', f'+{hx}+{hb}', H1,
            '-fill', MUTED, '-pointsize', str(ls), '-kerning', '0', '-annotate', f'+{lx}+{lb}', SUB,
            '-strip', '-colors', '256', f"PNG8:{ROOT / 'public' / 'og.png'}"], check=True)
        # iOS fills transparency with black: the mark sits on the page's paper.
        subprocess.run([
            'magick', '-size', f'{ICON}x{ICON}', f'xc:{PAPER}', logo(tmp, ICON_MARK), '-gravity', 'center',
            '-composite', '-strip', str(ROOT / 'public' / 'apple-touch-icon.png')], check=True)


if __name__ == '__main__':
    main()
