#!/usr/bin/env python3
"""render-slides: the demo screen's page images, from the demo deck's PDF export.

The PDF is the deck exported, so one set of images shows both catalog items, Sample deck.pptx and Sample deck.pdf.

Use: python3 -I tools/render-slides.py   (needs poppler's pdftoppm, cwebp and avifenc on PATH)
Writes public/img/demo-slide-<n>.webp and .avif, 1920 px wide, one pair per PDF page, and demo-slide-1-thumb.webp,
120 px wide. The page count must equal SLIDES in public/js/core/demo.js and the deck's slide count
(test/unit/mock-source.test.ts checks both).
Re-run whenever demo-deck.pptx or demo-handout.pdf changes.
"""
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / 'src' / 'worker' / 'seams' / 'file-source' / 'demo-files' / 'demo-handout.pdf'
OUT = ROOT / 'public' / 'img'
WIDTH = 1920
THUMB = 120


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
        # The landing's Approve still draws page 1 in a 32 px tile: 120 wide covers a 3x screen.
        run('pdftoppm', '-png', '-f', 1, '-l', 1, '-scale-to-x', THUMB, '-scale-to-y', -1, PDF, Path(tmp) / 't')
        thumb = OUT / 'demo-slide-1-thumb.webp'
        run('cwebp', '-quiet', '-q', 80, '-metadata', 'none', next(Path(tmp).glob('t*.png')), '-o', thumb)
        print(thumb.relative_to(ROOT), thumb.stat().st_size)


if __name__ == '__main__':
    main()
