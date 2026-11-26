#!/usr/bin/env python3
"""render-hero: the landing hero, public/img/hero-viewer-{750,1100,1600,2200}.HASH.avif and {750,1100,1600}.HASH.webp from
the desktop capture, public/img/hero-phone-{600,900}.HASH.{avif,webp} from the phone capture (docs/design.md section 6,
Hero stage).

Use: python3 -I tools/render-hero.py DESKTOP.png PHONE.png [AVIF_Q WEBP_Q]
DESKTOP is the room screen at 1440 x 904 and 2x (2880 x 1808), PHONE the same at 390 x 711 and 3x
(1170 x 2133): HERO_CAPTURE=1 npx playwright test hero-capture --project=preview.
Needs ImageMagick, avifenc and cwebp. Metadata stripped; the qualities, the widths and why: design.md, Hero stage.
HASH is the first 8 hex digits of the file's sha256: /img is cached for days, so a changed picture needs a new name.
Old files of each stem and width are deleted and the references in public/index.html and tools/size/core.json are
rewritten; run `node tools/build-pages-cli.mjs` and the golden update after.
"""
import hashlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'img'
REFERENCES = (ROOT / 'public' / 'index.html', ROOT / 'tools' / 'size' / 'core.json')
# (output stem, AVIF widths, WebP widths)
SETS = (
    ('hero-viewer', (750, 1100, 1600, 2200), (750, 1100, 1600)),
    ('hero-phone', (600, 900), (600, 900)),
)


def publish(encoded, stem, width, ext):
    """Move the encoded file to its hashed name and return (old name pattern, new name)."""
    name = f'{stem}-{width}.{hashlib.sha256(encoded.read_bytes()).hexdigest()[:8]}.{ext}'
    pattern = rf'{stem}-{width}(?:[-.][0-9a-f]{{8}})?\.{ext}'
    for old in OUT.glob(f'{stem}-{width}*.{ext}'):
        if re.fullmatch(pattern, old.name):
            old.unlink()
    (OUT / name).write_bytes(encoded.read_bytes())
    return pattern, name


def main():
    if len(sys.argv) not in (3, 5):
        sys.exit(__doc__.split('\n\n')[1])
    sources = sys.argv[1:3]
    avif_q, webp_q = (sys.argv[3], sys.argv[4]) if len(sys.argv) == 5 else ('49', '60')
    renamed = []
    with tempfile.TemporaryDirectory() as tmp:
        for source, (stem, avif_widths, webp_widths) in zip(sources, SETS):
            for width in avif_widths:
                png = Path(tmp) / f'{stem}-{width}.png'
                subprocess.run(['magick', source, '-filter', 'Lanczos', '-resize', f'{width}x', '-strip', str(png)], check=True)
                avif = Path(tmp) / f'{stem}-{width}.avif'
                subprocess.run(['avifenc', '-q', avif_q, '-s', '4', '--ignore-exif', '--ignore-xmp', '--ignore-icc',
                                str(png), str(avif)], check=True)
                renamed.append(publish(avif, stem, width, 'avif'))
                if width in webp_widths:
                    webp = Path(tmp) / f'{stem}-{width}.webp'
                    subprocess.run(['cwebp', '-q', webp_q, '-m', '6', '-metadata', 'none', str(png), '-o', str(webp)], check=True)
                    renamed.append(publish(webp, stem, width, 'webp'))
    for path in REFERENCES:
        text = path.read_text()
        for pattern, name in renamed:
            text = re.sub(pattern, name, text)
        path.write_text(text)
    for _, name in renamed:
        print(name)


if __name__ == '__main__':
    main()
