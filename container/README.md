# Conversion container

The image that turns an uploaded file into what bloop shows: a PDF, slide images, notes, a web-safe video, a JPEG from a HEIC, a thumbnail. One job per container lifetime, no network, no macros, outputs validated before they leave.

This file owns the job contract. `container.yml` builds, tests and publishes the image.

## Image

- Base `debian:trixie-slim` (pinned by digest in `Dockerfile`), installed with `--no-install-recommends`, so no Java runtime.
- LibreOffice Impress, Writer and Calc; poppler-utils; libvips-tools with libheif and the libde265 plugin; ffmpeg.
- Fonts: Carlito (Calibri), Caladea (Cambria), Liberation 2 (Arial, Times New Roman, Courier New), Noto core.
- `bloopconv`, a static Go binary, built in a multi-stage build. `docker build --target test container` runs `go vet` and `go test -race`.
- User `conv` (uid 10001). Setuid and setgid bits are stripped. Only `/work` and `/tmp` need to be writable; run with `--read-only --tmpfs /work --tmpfs /tmp` where the platform allows (the corpus does).
- `lo-registry.xcu` is copied into every job's fresh LibreOffice profile before `soffice` starts: macro security level 3, macro execution disabled, VBA neither loaded nor executable, links never updated on load, update checks off. A job whose profile cannot be seeded fails with `internal` and never starts `soffice`.

## Job server (`:8080`)

One job per container lifetime. Once a job starts, whatever its outcome, every further chunk or start is `409`. Every response carries a body, errors included (`{"error":"<code>"}`): a bodyless response breaks the next request on a pooled connection in workerd (workerd#7597).

| endpoint | behavior |
|---|---|
| `GET /healthz` | `200 ok` |
| `PUT /job/input/<n>` | One chunk of the original, at most 64 MiB (`BLOOP_MAX_CHUNK`), `n` from 0, streamed to disk. May be sent again until the job starts. `200 {"n","size"}`; `413 chunk_too_large`; `413 too_large` when the chunks together pass the input cap (the job fails); `409` after start. |
| `POST /job/start` | JSON `{"jobId" ([A-Za-z0-9_-]{1,64}), "ext", "size", "sha256", "chunks"}`. The chunks must be 0 to `chunks - 1`, total `size`, and hash to `sha256`; otherwise `422 chunks_mismatch` or `422 sha256_mismatch` and the container is not spent, so the caller can resend. `202 {"state":"running"}` once assembled. `400` bad body, `415` extension not supported, `409` already started. |
| `GET /job/status` | `{"state","stage","pct","error","pages","ready"}`. `state` is `idle`, `running`, `done` or `failed`. `stage` is `inspect`, `convert`, `rasterize`, `video`, `heic` or `done`. `pct` only rises, 0 to 100. `error` is `null` or a code below. `pages` is `null` or `{"done","total"}`, the pages rendered so far out of those that will be (documents only). `ready` lists output paths fetchable before `done`: page 1's images and `t.webp`. |
| `GET /out/manifest.json` | `409 {"error":"not_ready"}` until `done`. Then `{"v":1,"jobId","kind","pages","groups","files":[{"path","size","sha256","type"}]}`, files sorted by path. `pages` is `{"total","rendered"}` for documents, else `null`. `groups` maps each output group to `{"ok"}` or `{"ok":false,"error"}`. |
| `GET /out/<path>` | One published file: a manifest entry, or before `done` one listed in `status.ready`. Anything else is `404`, or `409` before `done`; the URL is never joined to a directory. `Content-Type` from the manifest, `X-Content-SHA256`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; ranges are honored. |

The input is verified before it is consumed: the SHA-256 of the chunks in order is checked first, then they are joined into one file and each chunk is deleted. The Durable Object should pull every file, compare `sha256` and `size`, and validate again; this server validates first.

Extensions and kinds:

| kind | extensions |
|---|---|
| `deck` | `pptx ppsx ppt pps odp` |
| `doc` | `docx doc odt rtf` |
| `sheet` | `xlsx xls ods` |
| `pdf` | `pdf` |
| `video` | `mp4 mov m4v webm` |
| `image` | `heic heif` |

Each extension has a magic-byte rule (zip, CFB, `%PDF-`, `{\rtf`, EBML, an `ftyp` box, a HEIC brand); a mismatch fails the job with `bad_magic`.

## Stages and timeouts

Each stage has its own timeout. An overrun kills the tool's whole process group and fails the job with `timeout`. Env overrides: `BLOOP_TIMEOUT_<STAGE>` in seconds.

| stage | work | default |
|---|---|---|
| inspect | magic bytes; for zip packages, the unpack limits and a real inflate of every entry (CRC included); for OOXML, notes, fonts, motion, media | 30 s |
| convert | office to PDF with `soffice --headless --convert-to pdf` and a fresh profile per call; a PDF input is rewritten with `pdftocairo -pdf`, which drops scripts, launch actions and attachments; `ppt`, `pps` and `odp` are also converted to a pptx so their notes, fonts and motion are read by the same code | 180 s |
| rasterize | `pdfinfo` (page count, page sizes), then per page `pdftoppm` at the widest width and `vips` to WebP (Q 80) at each width (`BLOOP_WIDTHS`, default 3840, 1920, 480); page 1 first, published at once, then the rest with four workers by default | 240 s |
| video | `ffprobe`, then `ffmpeg` to H.264 high profile (CRF 23, `veryfast`), AAC stereo 128k, yuv420p, at most 1920 wide, `+faststart`, metadata dropped, input restricted to `-protocol_whitelist file`; then `ffprobe` of the result must say h264 in an mp4; then a thumbnail | 900 s |
| heic | `vips thumbnail` to a 1920 JPEG (Q 85, orientation applied, all metadata dropped) and a 480 WebP | 60 s |

Always H.264 on output, even for an H.264 input: re-encoding is the sanitizer.

## Caps

| cap | value | env | code |
|---|---|---|---|
| upload, all chunks | 2 GiB | `BLOOP_MAX_INPUT` | `too_large` (413) |
| one chunk | 64 MiB | `BLOOP_MAX_CHUNK` | `chunk_too_large` (413) |
| unpacked zip, declared and actual | 2 GiB | `BLOOP_MAX_UNPACKED` | `bomb` |
| zip entries | 20000 | `BLOOP_MAX_ENTRIES` | `bomb` |
| pages rendered | 300 | `BLOOP_MAX_PAGES` | none: later pages are not rendered and `pages` in the manifest says `{total, rendered}` |
| page aspect (width over height) | 0.25 to 8 | none | `bad_page_size` |
| video duration, dimensions | 4 h, 8192 px | `BLOOP_MAX_VIDEO_SECONDS` | `bad_media` |
| image pixels | 100 million | `BLOOP_MAX_IMAGE_PIXELS` | `bad_media` |

An entry that inflates past its declared size is refused (`bad_archive`).

## Outputs

For `deck`, `doc`, `sheet` and `pdf`:

- `doc.pdf`
- `s/<n>/<width>.webp` for every rendered page `n` from 1 and every width (default 3840, 1920, 480; `BLOOP_WIDTHS` is 1 to 6 strictly descending widths of at most 7680 whose smallest is at most 480, else the default)
- `t.webp`, the first page at the smallest width
- `slides.json` `{"v":1,"widths":[...],"pages":[{"n","w","h"}],"motion":bool,"media":bool}`: `w` and `h` are the widest rendition; `motion` is any animation or transition (OOXML and, through the converted pptx, ppt, pps, odp); `media` is any embedded audio or video. Notes are never in this file.
- `notes.json` `{"v":1,"notes":[{"n","text"}]}`: only slides that have notes, text at most 4000 characters, paragraphs joined by newlines. Phone only. Empty for anything but decks.
- `meta.json` `{"v":1,"sha256","kind","fontsMissing":[...]}`: `sha256` is of the original upload. `fontsMissing` lists typefaces a deck, docx or xlsx names that are neither installed nor covered by a metric-compatible alias (Calibri to Carlito, Cambria to Caladea, Arial and Helvetica to Liberation Sans, Times New Roman to Liberation Serif, Courier New to Liberation Mono). Fonts in `doc`, `xls`, `ods`, `odt` and `rtf` are not read, so it is empty for them.

For `video`: `m/0.mp4`, `t.webp` (a frame at 1 s or half the duration, at most 480 wide), `meta.json` with `video {w,h,durationMs}`.

For `image`: `i/1920.jpg`, `t.webp` (480), `meta.json` with `image {w,h}`.

Nothing else may exist in the output tree.

## Output validation

Before the manifest exists, every file is checked by its path: regular files only (no symlinks), known names only, WebP magic with the RIFF size matching the file and the exact width, JPEG start and end markers and size, `%PDF-` with no `/JavaScript`, `/Launch` or `/EmbeddedFile`, `ftyp` for mp4, JSON shape with unknown fields refused, every page present at every width, `slides.json` widths and dimensions equal to the images, notes in range and in order. Size caps: webp and jpeg 40 MiB each, pdf 1 GiB, mp4 4 GiB, json 5 MiB, 8 GiB in total.

Outputs are judged by group: `slides` (page images, `slides.json`, and `t.webp`), `pdf`, `notes`, `media`, `image`. A failing group is `{"ok":false,"error":"output_invalid"}` in the manifest and its files are withheld; the others publish. The job is `done` when at least one group passes. It fails with `output_invalid`, publishing nothing, when every group fails, `meta.json` is missing or malformed, or the tree holds a symlink, an unknown file or more than 8 GiB.

## Error codes

`bad_magic`, `bad_archive`, `bomb`, `too_large`, `bad_page_size`, `bad_media`, `convert_failed`, `output_invalid`, `timeout`, `upload_failed`, `internal`. Detail goes to the container log, never to the status.

## Security model

- No network: the image never opens a connection, and the corpus runs it with `--network none`. Links in documents are not fetched (the registry sets update-on-load to never); the corpus proves it with a listener in the container's network namespace.
- Macros never run: level 3 plus the master switch off, VBA not loaded, every conversion in a fresh profile. The corpus proves it with fixtures whose macro would write `/tmp/bloop-macro-ran`, and proves the fixtures are live with a positive control: the same file under a relaxed registry (level 0, execution allowed) and under the production registry.
  - ODF Basic (`.odp`, `.odt`, `.ods`): the control fires when LibreOffice opens the document with security off and stays silent under the production registry. It does not fire under `--convert-to` even with security off, (it apparently skips document-open events), so the job path is silent for a second reason; the open-path result is the one that tests the registry.
  - VBA (`.ppt`, `.doc`, `.xls`): LibreOffice cannot write a VBA project from ODF Basic, so CI converts the ODF fixtures to the legacy formats and `fixtures/inject-vba.mjs` adds the `_VBA_PROJECT_CUR` and `Macros/VBA` storages (a hand-written CFB writer, `fixtures/cfb.mjs`). Their control does not fire even with security off, so the "silent under production" half is unverified for VBA. The backstop is the Worker's refusal of macro-carrying CFB files at upload (DROP-12); the corpus still asserts the legacy files convert and leave no sentinel.
- Tools start with an empty environment of our own making (`PATH`, `HOME`, `LANG`, `TMPDIR`, `XDG_CACHE_HOME`); nothing is inherited from the server.
- A tool runs in its own process group; the deadline kills the group, so `soffice.bin` never outlives its stage.
- Policy lives in the Worker and the Durable Object (DROP-12 to 15 refuse macro CFB, PDF active content, external relationships and bad magic before the container sees a file). The container is the second line: it neutralizes whatever reaches it.

## Fixture corpus

`node container/fixtures/make.mjs` writes the generated fixtures to `container/fixtures/generated/` (gitignored); `container/fixtures/lib.mjs` holds the builders. Everything is reproducible byte for byte.

| fixture | proves |
|---|---|
| `plain.pptx` | the baseline: 2 pages, 3 widths each, no notes, no motion, no missing fonts; also run with `BLOOP_WIDTHS=1280,640,320` and uploaded in 1000 byte chunks |
| `animated.pptx` | `motion` is true |
| `notes.pptx` | notes by slide number, a 5000 character note cut to 4000, notes never in `slides.json` |
| `aptos.pptx` | `fontsMissing` lists Aptos and Aptos Display |
| `deck-20.pptx`, `deck-100.pptx` | timings at 20 and 100 slides; on the 100-slide deck page 1 is fetched while the job runs |
| `macro.odp`, `macro.odt`, `macro.ods` | a Basic macro bound to document open that writes `/tmp/bloop-macro-ran`: converted, and the file never appears (CONV-03); the control fires with security off |
| `legacy/macro.ppt`, `.doc`, `.xls` | made in CI from the ODF fixtures plus an injected VBA storage: converted, no sentinel; control unverified (see Security model) |
| `external.pptx`, `external.docx` | linked pictures, hyperlinks and an attached template pointing at `127.0.0.1:8099`: converted, and nothing connects (DROP-14) |
| `pdf-js.pdf` | a PDF with OpenAction JavaScript, a launch action and an attached file: `doc.pdf` is rewritten without them (DROP-13) |
| `bomb.pptx` | 3 GiB of zeros in 3 MB: refused as `bomb` (CONV-02) |
| `bad-magic.pptx` | text named .pptx: `bad_magic` (DROP-15) |
| `pages-301.pdf` | with `BLOOP_MAX_PAGES=40`: 40 pages rendered, manifest `pages` `{total: 301, rendered: 40}` |
| `big.pdf` | 110 MiB (an unreferenced padding stream): two chunks of the 64 MiB cap, assembled and converted with no network |

Committed binaries, because they cannot be made reproducibly without an encoder in CI. Both are small test patterns, made on a laptop:

| file | size | sha256 | made with |
|---|---|---|---|
| `fixtures/media/hevc.mov` | 14866 B | `39ffe8e18c2a8b5aaa9c20af2a6bebf334b9f730305062a361b2ca1dd41aca2a` | `ffmpeg -f lavfi -i testsrc2=size=320x180:rate=10:duration=1.5 -f lavfi -i sine=frequency=440:duration=1.5 -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -crf 42 -preset fast -c:a aac -b:a 24k -ac 1 -movflags +faststart -map_metadata -1` (ffmpeg 8.1) |
| `fixtures/media/photo.heic` | 6947 B | `d7422fc958b556c0313eded33aa5945eebf1085761c8c37ae4ca12b73aa242e0` | `heif-enc -q 30` (libheif 1.23.7) of a 640x480 `testsrc2` frame |

The corpus (`container/test/corpus.mjs`) starts one container per case, drives it from the host with curl entered into the container's network namespace (a `--network none` container publishes no port), downloads every output, checks it against the manifest, and also checks the container itself: uid 10001, read-only root, only a loopback interface, no route out, no setuid binary, no Java, the fonts present. It prints deck timings to the job summary.

## CI and publishing

`.github/workflows/container.yml` runs on changes under `container/`, on pull requests, monthly (`0 5 1 * *`) and by hand. Steps: Go tests in the Docker build, build, generate fixtures, corpus, image size. Except on pull requests, and only when the repository has the secrets `CLOUDFLARE_API_TOKEN` (Containers edit and registry push) and `CLOUDFLARE_ACCOUNT_ID`, it tags the image `sha-<12 chars of the commit>`, runs `wrangler containers push` and reads the pushed digest. A failed push is red on `main` and tolerated on other branches. On `main` it also opens a PR that writes the digest to `container/digest.txt`. Without the secrets, the test steps run and the push steps are skipped.

The deployed reference is `registry.cloudflare.com/<account>/bloop-converter@sha256:<digest>`; the digest comes from `container/digest.txt`.

## Run it by hand

```
docker build -t bloop-converter:dev container
node container/fixtures/make.mjs
docker run --rm --network none --read-only \
  --tmpfs /work:rw,mode=0700,uid=10001,gid=10001 --tmpfs /tmp:rw,mode=1777 \
  bloop-converter:dev
```

The corpus needs Linux, `sudo` and `nsenter`: `IMAGE=bloop-converter:dev node container/test/corpus.mjs`.
