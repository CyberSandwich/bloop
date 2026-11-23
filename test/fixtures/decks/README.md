# Sample decks

The demo account's files, served by `MockFileSource` (`src/worker/seams/file-source/demo.ts` bundles them as raw bytes through the `rules` entry in `wrangler.jsonc`).

| File | What it is |
| --- | --- |
| `sample-deck.pptx` | 3 slides of plain text |
| `quarterly-review.pptx` | 2 slides of plain text |
| `sample-handout.pdf` | 2 pages of plain text; also the PDF rendition both decks fall back to |

All three are under 8 KB and contain only made-up sample text.

## Regenerating

`node tools/make-fixtures.mjs` rewrites them. The script uses nothing beyond Node: the `.pptx` files are minimal Office Open XML parts (one slide master, one layout, one theme, one part per slide) zipped with `node:zlib`, and the PDF is written object by object with a computed cross-reference table. Output is byte-for-byte reproducible (fixed zip timestamps, no random ids), so a change in git means the script changed. `test/unit/mock-source.test.ts` reads every file back: it inflates each zip entry, checks that every relationship target and content type exists, and checks the PDF's cross-reference offsets.

They were checked with `unzip -t` and `qpdf --check`. They have not been opened in PowerPoint or a desktop PDF viewer from this environment, so open each once by hand after changing the script.
