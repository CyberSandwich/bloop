#!/usr/bin/env python3
"""render-hero-desktop: the landing hero, public/img/hero-viewer-{750,1100,1600,2200}.avif and {750,1100,1600}.webp (docs/design.md section 6, Hero stage).

Use: python3 -I tools/render-hero-desktop.py SOURCE.png [AVIF_Q WEBP_Q]
SOURCE is the viewer at 1440 x 828 and 2x (2880 x 1656), Dog.jpg selected: HERO_CAPTURE=1 npx playwright test hero-capture --project=preview.
Needs ImageMagick, avifenc and cwebp. Metadata stripped; the qualities, the widths and why: design.md, Hero stage.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'img'
AVIF_WIDTHS = (750, 1100, 1600, 2200)
WEBP_WIDTHS = (750, 1100, 1600)


def main():
    source = sys.argv[1]
    avif_q, webp_q = (sys.argv[2], sys.argv[3]) if len(sys.argv) == 4 else ('50', '70')
    with tempfile.TemporaryDirectory() as tmp:
        for width in AVIF_WIDTHS:
            png = Path(tmp) / f'{width}.png'
            subprocess.run(['magick', source, '-filter', 'Lanczos', '-resize', f'{width}x', '-strip', str(png)], check=True)
            subprocess.run(['avifenc', '-q', avif_q, '-s', '4', '--ignore-exif', '--ignore-xmp', '--ignore-icc',
                            str(png), str(OUT / f'hero-viewer-{width}.avif')], check=True)
            if width in WEBP_WIDTHS:
                subprocess.run(['cwebp', '-q', webp_q, '-m', '6', '-metadata', 'none', str(png),
                                '-o', str(OUT / f'hero-viewer-{width}.webp')], check=True)


if __name__ == '__main__':
    main()
