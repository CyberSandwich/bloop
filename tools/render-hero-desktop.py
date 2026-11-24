#!/usr/bin/env python3
"""render-hero-desktop: the desktop hero, public/img/hero-viewer-{1000,1440}.{avif,webp} (docs/design.md section 6, Hero stage).

Use: python3 -I tools/render-hero-desktop.py SOURCE.png   (the viewer at 1440 x 828, Dog.jpg selected)
Needs ImageMagick, avifenc and cwebp. Metadata stripped; AVIF quality 30 and WebP quality 30: the photo's grass is
dense detail, so the old 62 and 80 cost four times the hero budget.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'img'
WIDTHS = (1000, 1440)


def main():
    source = sys.argv[1]
    with tempfile.TemporaryDirectory() as tmp:
        for width in WIDTHS:
            png = Path(tmp) / f'{width}.png'
            subprocess.run(['magick', source, '-resize', f'{width}x', '-strip', str(png)], check=True)
            subprocess.run(['avifenc', '-q', '30', '-s', '4', '--ignore-exif', '--ignore-xmp', '--ignore-icc',
                            str(png), str(OUT / f'hero-viewer-{width}.avif')], check=True)
            subprocess.run(['cwebp', '-q', '30', '-m', '6', '-metadata', 'none', str(png),
                            '-o', str(OUT / f'hero-viewer-{width}.webp')], check=True)


if __name__ == '__main__':
    main()
