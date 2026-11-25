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

One job per container lifetime. After a job starts, whatever its outcome, every further `POST /job` is `409`.

| endpoint | behavior |
|---|---|
| `GET /healthz` | `200 ok` |
| `POST /job` | Headers `X-Job-Id` (`[A-Za-z0-9_-]{1,64}`) and `X-Job-Ext` (extension, with or without the dot). The body is the original file, streamed to disk and hashed as it arrives. `202 {"state":"running"}` once the whole body is received; the work continues in the background. `400` bad id or a failed upload, `413` over the input cap (status becomes `failed`, `too_large`), `415` extension not supported, `409` a job already started. |
| `GET /job/status` | `{"state","stage","pct","error"}`. `state` is `idle`, `running`, `done` or `failed`. `stage` is `upload`, `inspect`, `convert`, `rasterize`, `video`, `heic` or `done`. `pct` only rises, 0 to 100. `error` is `null` or one of the codes below. |
| `GET /out/manifest.json` | `409 {"error":"not_ready"}` until `done`. Then `{"v":1,"jobId","kind","files":[{"path","size","sha256","type"}]}`, files sorted by path. |
| `GET /out/<path>` | One manifest file. Only paths in the manifest exist (`404` otherwise; the URL is never joined to a directory). `Content-Type` from the manifest, `X-Content-SHA256`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; ranges are honored. `409` before `done`. |

The Durable Object should pull every file, compare `sha256` and `size`, and validate again; this server validates first.

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
| rasterize | `pdfinfo` (page count, page sizes), then per page `pdftoppm` at 3840 wide and `vips` to WebP (Q 80) at 3840, 1920 and 480; four workers by default | 240 s |
| video | `ffprobe`, then `ffmpeg` to H.264 high profile (CRF 23, `veryfast`), AAC stereo 128k, yuv420p, at most 1920 wide, `+faststart`, metadata dropped, input restricted to `-protocol_whitelist file`; then `ffprobe` of the result must say h264 in an mp4; then a thumbnail | 900 s |
| heic | `vips thumbnail` to a 1920 JPEG (Q 85, orientation applied, all metadata dropped) and a 480 WebP | 60 s |

Always H.264 on output, even for an H.264 input: re-encoding is the sanitizer.

## Caps

| cap | value | env | code |
|---|---|---|---|
| upload | 2 GiB | `BLOOP_MAX_INPUT` | `too_large` (413) |
| unpacked zip, declared and actual | 2 GiB | `BLOOP_MAX_UNPACKED` | `bomb` |
| zip entries | 20000 | `BLOOP_MAX_ENTRIES` | `bomb` |
| pages | 300 | `BLOOP_MAX_PAGES` | `too_many_pages` |
| page aspect (width over height) | 0.25 to 8 | none | `bad_page_size` |
| video duration, dimensions | 4 h, 8192 px | `BLOOP_MAX_VIDEO_SECONDS` | `bad_media` |
| image pixels | 100 million | `BLOOP_MAX_IMAGE_PIXELS` | `bad_media` |

An entry that inflates past its declared size is refused (`bad_archive`).

## Outputs

For `deck`, `doc`, `sheet` and `pdf`:

- `doc.pdf`
- `s/<n>/3840.webp`, `s/<n>/1920.webp`, `s/<n>/480.webp` for every page `n` from 1
- `t.webp`, the first page at 480
- `slides.json` `{"v":1,"pages":[{"n","w","h"}],"motion":bool,"media":bool}`: `w` and `h` are the 3840 rendition; `motion` is any animation or transition (OOXML and, through the converted pptx, ppt, pps, odp); `media` is any embedded audio or video. Notes are never in this file.
- `notes.json` `{"v":1,"notes":[{"n","text"}]}`: only slides that have notes, text at most 4000 characters, paragraphs joined by newlines. Phone only. Empty for anything but decks.
- `meta.json` `{"v":1,"sha256","kind","fontsMissing":[...]}`: `sha256` is of the original upload. `fontsMissing` lists typefaces a deck, docx or xlsx names that are neither installed nor covered by a metric-compatible alias (Calibri to Carlito, Cambria to Caladea, Arial and Helvetica to Liberation Sans, Times New Roman to Liberation Serif, Courier New to Liberation Mono). Fonts in `doc`, `xls`, `ods`, `odt` and `rtf` are not read, so it is empty for them.

For `video`: `m/0.mp4`, `t.webp` (a frame at 1 s or half the duration, at most 480 wide), `meta.json` with `video {w,h,durationMs}`.

For `image`: `i/1920.jpg`, `t.webp` (480), `meta.json` with `image {w,h}`.

Nothing else may exist in the output tree.

## Output validation

Before the manifest exists, every file is checked by its path: regular files only (no symlinks), known names only, WebP magic with the RIFF size matching the file and the exact width, JPEG start and end markers and size, `%PDF-` with no `/JavaScript`, `/Launch` or `/EmbeddedFile`, `ftyp` for mp4, JSON shape with unknown fields refused, every page present at all three widths, `slides.json` dimensions equal to the images, notes in range and in order. Size caps: webp and jpeg 40 MiB each, pdf 1 GiB, mp4 4 GiB, json 5 MiB, 8 GiB in total. A failure is `output_invalid` and no manifest is published.

## Error codes

`bad_magic`, `bad_archive`, `bomb`, `too_large`, `too_many_pages`, `bad_page_size`, `bad_media`, `convert_failed`, `output_invalid`, `timeout`, `upload_failed`, `internal`. Detail goes to the container log, never to the status.

## Security model

- No network: the image never opens a connection, and the corpus runs it with `--network none`. Links in documents are not fetched (the registry sets update-on-load to never); the corpus proves it with a listener in the container's network namespace.
- Macros never run: level 3 plus the master switch off, VBA not loaded, every conversion in a fresh profile. The corpus proves it with fixtures whose macro would write `/tmp/bloop-macro-ran`, and proves the fixtures are live by running them in a container with macro security off.
- Tools start with an empty environment of our own making (`PATH`, `HOME`, `LANG`, `TMPDIR`, `XDG_CACHE_HOME`); nothing is inherited from the server.
- A tool runs in its own process group; the deadline kills the group, so `soffice.bin` never outlives its stage.
- Policy lives in the Worker and the Durable Object (DROP-12 to 15 refuse macro CFB, PDF active content, external relationships and bad magic before the container sees a file). The container is the second line: it neutralizes whatever reaches it.

## Fixture corpus

`node container/fixtures/make.mjs` writes the generated fixtures to `container/fixtures/generated/` (gitignored); `container/fixtures/lib.mjs` holds the builders. Everything is reproducible byte for byte.

| fixture | proves |
|---|---|
| `plain.pptx` | the baseline: 2 pages, 3 widths each, no notes, no motion, no missing fonts |
| `animated.pptx` | `motion` is true |
| `notes.pptx` | notes by slide number, a 5000 character note cut to 4000, notes never in `slides.json` |
| `aptos.pptx` | `fontsMissing` lists Aptos and Aptos Display |
| `deck-20.pptx`, `deck-100.pptx` | timings at 20 and 100 slides |
| `macro.odp`, `macro.odt`, `macro.ods` | a Basic macro bound to document open that writes `/tmp/bloop-macro-ran`: converted, and the file never appears (CONV-03) |
| `external.pptx`, `external.docx` | linked pictures, hyperlinks and an attached template pointing at `127.0.0.1:8099`: converted, and nothing connects (DROP-14) |
| `pdf-js.pdf` | a PDF with OpenAction JavaScript, a launch action and an attached file: `doc.pdf` is rewritten without them (DROP-13) |
| `bomb.pptx` | 3 GiB of zeros in 3 MB: refused as `bomb` (CONV-02) |
| `bad-magic.pptx` | text named .pptx: `bad_magic` (DROP-15) |
| `pages-301.pdf` | `too_many_pages` |

Committed binaries, because they cannot be made reproducibly without an encoder in CI. Both are small test patterns, made on a laptop:

| file | size | sha256 | made with |
|---|---|---|---|
| `fixtures/media/hevc.mov` | 14866 B | `39ffe8e18c2a8b5aaa9c20af2a6bebf334b9f730305062a361b2ca1dd41aca2a` | `ffmpeg -f lavfi -i testsrc2=size=320x180:rate=10:duration=1.5 -f lavfi -i sine=frequency=440:duration=1.5 -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -crf 42 -preset fast -c:a aac -b:a 24k -ac 1 -movflags +faststart -map_metadata -1` (ffmpeg 8.1) |
| `fixtures/media/photo.heic` | 6947 B | `d7422fc958b556c0313eded33aa5945eebf1085761c8c37ae4ca12b73aa242e0` | `heif-enc -q 30` (libheif 1.23.7) of a 640x480 `testsrc2` frame |

The corpus (`container/test/corpus.mjs`) starts one container per case, drives it from the host with curl entered into the container's network namespace (a `--network none` container publishes no port), downloads every output, checks it against the manifest, and also checks the container itself: uid 10001, read-only root, only a loopback interface, no route out, no setuid binary, no Java, the fonts present. It prints deck timings to the job summary.

## CI and publishing

`.github/workflows/container.yml` runs on changes under `container/`, on pull requests, monthly (`0 5 1 * *`) and by hand. Steps: Go tests in the Docker build, build, generate fixtures, corpus, image size. On `main`, the monthly schedule or a manual run, and only when the repository has the secrets `CLOUDFLARE_API_TOKEN` (Containers edit and registry push) and `CLOUDFLARE_ACCOUNT_ID`, it runs `wrangler containers push`, reads the pushed digest, and on `main` opens a PR that writes it to `container/digest.txt`. Without the secrets, the test steps run and the push steps are skipped.

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
