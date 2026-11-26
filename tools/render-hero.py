#!/usr/bin/env python3
"""render-hero: the landing hero, public/img/hero-viewer-{750,1100,1600,2200}.HASH.avif and {750,1100,1600}.HASH.webp from
the desktop capture (docs/design.md section 6, Hero stage).

Use: python3 -I tools/render-hero.py DESKTOP.png [AVIF_Q WEBP_Q]
DESKTOP is the room screen presenting at 1440 x 828 and 2x (2880 x 1656):
HERO_CAPTURE=1 npx playwright test hero-capture --project=preview.
Needs ImageMagick, avifenc and cwebp. Metadata stripped; the qualities, the widths and why: design.md, Hero stage.
HASH is the first 8 hex digits of the file's sha256: /img is cached for days, so a changed picture needs a new name.
Old files of each width are deleted and the references in public/index.html and tools/size/core.json are rewritten;
run `node tools/build-pages-cli.mjs` and the golden update after.
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
STEM = 'hero-viewer'
AVIF_WIDTHS = (750, 1100, 1600, 2200)
WEBP_WIDTHS = (750, 1100, 1600)


def publish(encoded, width, ext):
    """Move the encoded file to its hashed name and return (old name pattern, new name)."""
    name = f'{STEM}-{width}.{hashlib.sha256(encoded.read_bytes()).hexdigest()[:8]}.{ext}'
    pattern = rf'{STEM}-{width}(?:[-.][0-9a-f]{{8}})?\.{ext}'
    for old in OUT.glob(f'{STEM}-{width}*.{ext}'):
        if re.fullmatch(pattern, old.name):
            old.unlink()
    (OUT / name).write_bytes(encoded.read_bytes())
    return pattern, name


def main():
    if len(sys.argv) not in (2, 4):
        sys.exit(__doc__.split('\n\n')[1])
    source = sys.argv[1]
    avif_q, webp_q = (sys.argv[2], sys.argv[3]) if len(sys.argv) == 4 else ('49', '60')
    renamed = []
    with tempfile.TemporaryDirectory() as tmp:
        for width in AVIF_WIDTHS:
            png = Path(tmp) / f'{STEM}-{width}.png'
            subprocess.run(['magick', source, '-filter', 'Lanczos', '-resize', f'{width}x', '-strip', str(png)], check=True)
            avif = Path(tmp) / f'{STEM}-{width}.avif'
            subprocess.run(['avifenc', '-q', avif_q, '-s', '4', '--ignore-exif', '--ignore-xmp', '--ignore-icc',
                            str(png), str(avif)], check=True)
            renamed.append(publish(avif, width, 'avif'))
            if width in WEBP_WIDTHS:
                webp = Path(tmp) / f'{STEM}-{width}.webp'
                subprocess.run(['cwebp', '-q', webp_q, '-m', '6', '-metadata', 'none', str(png), '-o', str(webp)], check=True)
                renamed.append(publish(webp, width, 'webp'))
    for path in REFERENCES:
        text = path.read_text()
        for pattern, name in renamed:
            text = re.sub(pattern, name, text)
        path.write_text(text)
    for _, name in renamed:
        print(name)


if __name__ == '__main__':
    main()
