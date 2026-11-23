#!/usr/bin/env python3
"""render-slides: the demo screen's slide images, from the demo deck's PDF export.

Use: python3 -I tools/render-slides.py   (needs poppler's pdftoppm, cwebp and avifenc on PATH)
Writes public/img/demo-slide-<n>.webp and .avif, 1920 px wide, one pair per PDF page. The page count must equal
SLIDES in public/js/screen-demo.js and the deck's slide count (test/unit/mock-source.test.ts checks both).
Re-run whenever demo-deck.pptx or demo-handout.pdf changes.
"""
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / 'src' / 'worker' / 'seams' / 'file-source' / 'demo-files' / 'demo-handout.pdf'
OUT = ROOT / 'public' / 'img'
WIDTH = 1920


def run(*args):
    subprocess.run([str(a) for a in args], check=True, capture_output=True)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        run('pdftoppm', '-png', '-scale-to-x', WIDTH, '-scale-to-y', -1, PDF, Path(tmp) / 'p')
        pages = sorted(Path(tmp).glob('p-*.png'), key=lambda p: int(p.stem.split('-')[1]))
        for n, png in enumerate(pages, start=1):
            base = OUT / f'demo-slide-{n}'
            run('cwebp', '-quiet', '-q', 80, '-metadata', 'none', png, '-o', base.with_suffix('.webp'))
            run('avifenc', '-q', 60, '-s', 4, png, base.with_suffix('.avif'))
            print(base.relative_to(ROOT), base.with_suffix('.webp').stat().st_size, base.with_suffix('.avif').stat().st_size)


if __name__ == '__main__':
    main()
