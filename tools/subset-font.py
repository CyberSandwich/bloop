#!/usr/bin/env python3
"""subset-font: cut the official Inter variable font down to the one file every page loads.

Use: python3 -I tools/subset-font.py [--no-opsz]
Needs fonttools and brotli (pip install fonttools brotli). Reads src/fonts/InterVariable.woff2,
rewrites the public/fonts/inter-latin-<hash>.woff2 already there (docs/design.md sections 4 and 11); then run
node tools/rehash-immutable.mjs, which gives it the name its bytes call for.

Steps: pin the weight axis to 400..600 (the only weights in use), keep the optical-size axis
unless the result passes the 55 KB budget, then keep only the Latin range that the @font-face
unicode-range in public/css/base.css declares. test/unit/font.test.ts checks every page string
falls inside that range, so a glyph a page needs can never be cut.
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src' / 'fonts' / 'InterVariable.woff2'
DST = next((ROOT / 'public' / 'fonts').glob('inter-latin-*.woff2'))
BUDGET = 55 * 1024
# Same list as the unicode-range in public/css/base.css and design.md section 4.
UNICODES = ('U+0000-00FF U+0131 U+0152-0153 U+02BB-02BC U+02C6 U+02DA U+02DC U+2000-206F U+2074 '
            'U+20AC U+2122 U+2191 U+2193 U+2212 U+2215 U+FEFF U+FFFD')
FEATURES = ['kern', 'liga', 'calt', 'ccmp', 'locl', 'mark', 'mkmk', 'tnum', 'case']


def build(keep_opsz):
    # Subset before instancing: the instancer leaves gvar lazily loaded, which the subsetter trips on.
    font = TTFont(str(SRC))
    opts = subset.Options()
    opts.layout_features = FEATURES
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES.replace(' ', ',')))
    sub.subset(font)
    limits = {'wght': (400, 600)}
    if not keep_opsz:
        limits['opsz'] = 14
    font = instancer.instantiateVariableFont(font, limits)
    font.flavor = 'woff2'
    font.save(str(DST))
    return DST.stat().st_size


def main():
    size = build(keep_opsz='--no-opsz' not in sys.argv)
    if size > BUDGET and '--no-opsz' not in sys.argv:
        print(f'with opsz: {size} bytes, over {BUDGET}; pinning opsz=14')
        size = build(keep_opsz=False)
    print(f'{DST.relative_to(ROOT)}: {size} bytes')
    if size > BUDGET:
        sys.exit(f'over the {BUDGET} byte budget')


if __name__ == '__main__':
    main()
