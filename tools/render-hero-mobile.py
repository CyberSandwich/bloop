#!/usr/bin/env python3
"""render-hero-mobile: the phone hero, public/img/hero-phone-{600,900}.{avif,webp} (docs/design.md section 6, Hero stage).

Use: python3 -I tools/render-hero-mobile.py SOURCE.png   (an iPhone mockup on a transparent ground)
Needs ImageMagick, avifenc and cwebp. Alpha is kept, metadata stripped; AVIF quality 62, WebP quality 80.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'img'
WIDTHS = (600, 900)


def main():
    source = sys.argv[1]
    with tempfile.TemporaryDirectory() as tmp:
        for width in WIDTHS:
            png = Path(tmp) / f'{width}.png'
            # The mockup's transparent margins are trimmed (the phone is 57 percent of its width), 12 px left for the edge.
            subprocess.run(['magick', source, '-trim', '+repage', '-bordercolor', 'none', '-border', '12',
                            '-resize', f'{width}x', '-strip', f'PNG32:{png}'], check=True)
            subprocess.run(['avifenc', '-q', '62', '--qalpha', '80', '-s', '4', '--ignore-exif', '--ignore-xmp',
                            '--ignore-icc', str(png), str(OUT / f'hero-phone-{width}.avif')], check=True)
            subprocess.run(['cwebp', '-q', '80', '-alpha_q', '90', '-m', '6', '-metadata', 'none', str(png),
                            '-o', str(OUT / f'hero-phone-{width}.webp')], check=True)


if __name__ == '__main__':
    main()
