#!/usr/bin/env python3
"""render-hero: the landing hero, public/img/hero-viewer-{750,1100,1600,2200}.avif and {750,1100,1600}.webp from the
desktop capture, public/img/hero-phone-{600,900}.{avif,webp} from the phone capture (docs/design.md section 6, Hero stage).

Use: python3 -I tools/render-hero.py DESKTOP.png PHONE.png [AVIF_Q WEBP_Q]
DESKTOP is the room screen presenting at 1440 x 828 and 2x (2880 x 1656), PHONE the same at 390 x 844 and 3x
(1170 x 2532): HERO_CAPTURE=1 npx playwright test hero-capture --project=preview.
Needs ImageMagick, avifenc and cwebp. Metadata stripped; the qualities, the widths and why: design.md, Hero stage.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'img'
# (output stem, AVIF widths, WebP widths)
SETS = (
    ('hero-viewer', (750, 1100, 1600, 2200), (750, 1100, 1600)),
    ('hero-phone', (600, 900), (600, 900)),
)


def main():
    sources = sys.argv[1:3]
    avif_q, webp_q = (sys.argv[3], sys.argv[4]) if len(sys.argv) == 5 else ('49', '60')
    with tempfile.TemporaryDirectory() as tmp:
        for source, (stem, avif_widths, webp_widths) in zip(sources, SETS):
            for width in avif_widths:
                png = Path(tmp) / f'{stem}-{width}.png'
                subprocess.run(['magick', source, '-filter', 'Lanczos', '-resize', f'{width}x', '-strip', str(png)], check=True)
                subprocess.run(['avifenc', '-q', avif_q, '-s', '4', '--ignore-exif', '--ignore-xmp', '--ignore-icc',
                                str(png), str(OUT / f'{stem}-{width}.avif')], check=True)
                if width in webp_widths:
                    subprocess.run(['cwebp', '-q', webp_q, '-m', '6', '-metadata', 'none', str(png),
                                    '-o', str(OUT / f'{stem}-{width}.webp')], check=True)


if __name__ == '__main__':
    main()
