#!/usr/bin/env python3
"""subset-font: cut the official Inter variable font down to the one file every page loads.

Use: python3 -I tools/subset-font.py
Needs fonttools and brotli (a throwaway venv, docs/setup.md). Reads src/fonts/InterVariable.woff2,
writes public/fonts/inter-latin.woff2 (docs/design.md sections 4 and 11).

Steps: keep only the Latin range that the @font-face unicode-range in public/css/base.css
declares, pin the weight axis to 400..600 (the only weights in use) and the optical-size axis to
14 (its second axis costs a third of the file), and keep only the OpenType features the pages use
(kern, liga, calt for the time colon, tnum for the countdown, plus the shaping tables a Latin
name needs). test/unit/site-pages.test.ts checks every page string falls inside that range, so a
glyph a page needs can never be cut; a character outside it falls back to the system font.
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src' / 'fonts' / 'InterVariable.woff2'
DST = ROOT / 'public' / 'fonts' / 'inter-latin.woff2'
BUDGET = 29000 # package.json size-limit "font" (size-limit counts 1 kB as 1000 bytes)
# Same list as the unicode-range in public/css/base.css and design.md section 4.
UNICODES = ('U+0000-00FF U+0131 U+0152-0153 U+02BB-02BC U+02C6 U+02DA U+02DC U+2000-206F U+2074 '
            'U+20AC U+2122 U+2191 U+2193 U+2212 U+2215 U+FEFF U+FFFD')
FEATURES = ['kern', 'liga', 'calt', 'ccmp', 'locl', 'mark', 'mkmk', 'tnum']


def main():
    # Subset before instancing: the instancer leaves gvar lazily loaded, which the subsetter trips on.
    font = TTFont(str(SRC))
    opts = subset.Options()
    opts.layout_features = FEATURES
    opts.name_IDs = [0, 1, 2, 4, 6, 13, 14]  # copyright, names, license text and URL (OFL)
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES.replace(' ', ',')))
    sub.subset(font)
    font = instancer.instantiateVariableFont(font, {'wght': (400, 600), 'opsz': 14})
    font.flavor = 'woff2'
    font.save(str(DST))
    size = DST.stat().st_size
    print(f'{DST.relative_to(ROOT)}: {size} bytes')
    if size > BUDGET:
        sys.exit(f'over the {BUDGET} byte budget')


if __name__ == '__main__':
    main()
