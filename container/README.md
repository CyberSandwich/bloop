# Conversion container

The image that turns an uploaded file into what bloop shows: a PDF, slide images, notes, a web-safe video, a JPEG from a HEIC, a thumbnail. One job per container lifetime, no network (`--network none` in CI, `enableInternet: false` in production), no macros, outputs validated before they leave.

This file owns the job contract. `container.yml` builds, tests and publishes the image.

## Image

- Base `debian:trixie-slim` (pinned by digest in `Dockerfile`), installed with `--no-install-recommends`, so no Java runtime.
- LibreOffice Impress, Writer and Calc; poppler-utils; libvips-tools with libheif and the libde265 plugin; ffmpeg.
- Fonts: Carlito (Calibri), Caladea (Cambria), Liberation 2 (Arial, Times New Roman, Courier New), Noto core.
- `bloopconv`, a static Go binary, built in a multi-stage build. `docker build --target test container` runs `go vet` and `go test -race`.
- User `conv` (uid 10001). Setuid and setgid bits are stripped. Only `/work` and `/tmp` need to be writable; the corpus runs with `--read-only --tmpfs /work --tmpfs /tmp`, which the deployed platform does not offer (see Security model).
- `lo-registry.xcu` is copied into every job's fresh LibreOffice profile before `soffice` starts: macro security level 3, macro execution disabled, VBA neither loaded nor executable, links never updated on load, update checks off. A job whose profile cannot be seeded fails with `internal` and never starts `soffice`.

## Job server (`:8080`)

One job per container lifetime. Once a job starts, whatever its outcome, every further chunk or start is `409`. Every response carries a body, errors included (`{"error":"<code>"}`): a bodyless response breaks the next request on a pooled connection in workerd (workerd#7597).

| endpoint | behavior |
|---|---|
| `GET /healthz` | `200 ok` |
| `PUT /job/input/<n>` | One chunk of the original, at most 64 MiB (`BLOOP_MAX_CHUNK`), `n` from 0, streamed to disk. May be sent again until the job starts, but not while the same `n` is still arriving (`409 chunk_in_progress`). Each chunk may use at most what is left of `BLOOP_MAX_INPUT` after the stored chunks and the room granted to chunks in flight, so parallel uploads cannot pass the cap together. `200 {"n","size"}`; `413 chunk_too_large`; `413 too_large` when the chunks together pass the input cap (the job fails); `409` after start. |
| `POST /job/start` | JSON `{"jobId" ([A-Za-z0-9_-]{1,64}), "ext", "size", "sha256", "chunks"}`. `size` over `BLOOP_MAX_INPUT` is `413 too_large` and `chunks` over 100000 is `400`, before any chunk is read. The chunks must be 0 to `chunks - 1`, total `size`, and hash to `sha256`; otherwise `422 chunks_mismatch` or `422 sha256_mismatch` and the container is not spent, so the caller can resend. `202 {"state":"running"}` once assembled. `400` bad body, `415` extension not supported, `409` already started or a chunk still arriving. |
| `GET /job/status` | `{"state","stage","pct","error","pages","ready"}`. `state` is `idle`, `running`, `done` or `failed`. `stage` is `inspect`, `convert`, `rasterize`, `video`, `heic` or `done`. `pct` only rises, 0 to 100. `error` is `null` or a code below. `pages` is `null` or `{"done","total"}`, the pages rendered so far out of those that will be (documents only). `ready` lists output paths fetchable before `done`: page 1's images (`s/1/<width>.webp`) and `t.webp`. A job that fails withdraws them: `ready` is empty and every `/out/` path answers `409`. |
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
| convert | office to PDF with `soffice --headless --convert-to pdf` and a fresh profile per call; every `doc.pdf`, uploaded or made by `soffice`, is rewritten with `pdftocairo -pdf`, which drops scripts, launch actions and attachments; `ppt`, `pps` and `odp` are also converted to a pptx so their notes, fonts and motion are read by the same code | 180 s |
| rasterize | `pdfinfo` (page count, page sizes), then per page one `pdftoppm` render at the widest width, uncompressed (PPM), and `vips` to WebP (Q 80, effort 2) at each width from that one render (`BLOOP_WIDTHS`, default 3840, 1920, 480); page 1 first, published at once, then the rest with as many workers as the CPU quota allows, at most four (`BLOOP_WORKERS`) | 500 s |
| video | `ffprobe`, then one of two paths, both with the input restricted to `-protocol_whitelist file` and the demuxer forced from the magic bytes (`-f mov` or `-f matroska`, never probed), metadata dropped, `+faststart`. **Copy** (`-c copy`, no decode, no duration cap): the first video stream is H.264 in Baseline, Main or High (8-bit 4:2:0, level 5.2 or lower, no wider or taller than `BLOOP_VIDEO_WIDTH`), the first audio stream is AAC (LC, HE or HEv2) or absent, the input is mp4 or mov with one unfragmented `moov` of at most 64 MiB. **Encode** for everything else (High 10, 4:2:2 and 4:4:4, HEVC, other audio, matroska, a missing, oversized or fragmented index, a wider picture): H.264 high profile (CRF 23, `veryfast`), AAC stereo 128k, yuv420p, at most `BLOOP_VIDEO_WIDTH` wide (1920), cut at `BLOOP_MAX_VIDEO_SECONDS` with `-t`. Then `ffprobe` of the result must say h264 in an mp4 whose `moov` comes before its `mdat`; then a thumbnail. A copy stops at the input's size plus a tenth and 16 MiB and at the probed length plus 10 s, and a copy that reaches either fails the job; it drops SEI units from the video (`-bsf:v filter_units=remove_types=6`) and is otherwise the sender's stream, not sanitized. A copy that fails is retried as an encode when the clip is within the encode cap | ceiling 1440 s; budgets below |
| heic | `vips thumbnail` to a 1920 JPEG (Q 85, orientation applied, all metadata dropped) and a 480 WebP | 60 s |

Rasterize time is linear in pages. The page cap is 300 (`BLOOP_MAX_PAGES`). Measured on the CI runner, seconds a page in the rasterize stage, for text decks of 100 and 300 slides (`--cpus` is the container's CPU quota):

| | one PNG render, effort 4, four workers (before) | one PPM render, effort 2, workers = quota (after) |
|---|---|---|
| `--cpus 1`, 100 pages | 205 s (2.05 s a page; 177 s in a second run) | 54.6 s (0.55 s; 47 s in a second run) |
| `--cpus 1`, 300 pages | 614 s (2.05 s) | 167 s to 210 s (0.56 to 0.70 s) |
| `--cpus 2`, 100 pages | 91 s (0.91 s) | 23 s (0.23 s) |

Where the time went, per page at one CPU: the PNG render cost 0.30 s against 0.12 s for PPM (deflate cost more than the render), the 3840 px WebP encode 0.42 s against 0.17 s at effort 2 (1.5 percent larger), and four workers on a one-CPU quota ran slower than one (1.77 against 1.19 s a page). `GOMAXPROCS` follows the quota where `NumCPU` counts the host, so workers now equal the quota.

The rasterize default is 500 s: about 2.4 times the slowest measurement (300 pages, one CPU), which ranged from 167 s to 210 s between two CI runners running the same code. The corpus runs those decks under the default timeouts and requires only that the job finishes and validates; stage times are recorded in the job summary and never asserted, because a shared runner's speed varies by 25 percent or more (`runJob` returns a result with no timing in it, which `container/test/guard.test.mjs` checks, so a `check()` cannot see elapsed time). The measured decks are plain text slides, so the convert, video and heic defaults stay as set: they are caps against a hang, and a real deck with large pictures takes much longer than the 3 s these decks need. The planned instance is `standard-2` (plan-v4), taken to be one vCPU (unverified against Cloudflare's docs): a 300-page deck then takes 167 to 210 s to rasterize. A deployment below one CPU must scale `BLOOP_TIMEOUT_RASTERIZE` by the quota and keep its own deadline above the sum of the stage timeouts.

Always H.264 on output, even for an H.264 input: re-encoding is the sanitizer.

## Caps

| cap | value | env | code |
|---|---|---|---|
| upload, all chunks | 2 GiB | `BLOOP_MAX_INPUT` | `too_large` (413) |
| one chunk | 64 MiB | `BLOOP_MAX_CHUNK` | `chunk_too_large` (413) |
| `BLOOP_WIDTHS` entries | 1 to 6, widest at most 4095 | `BLOOP_WIDTHS` | none: anything else is the default |
| unpacked zip, declared and actual | 2 GiB | `BLOOP_MAX_UNPACKED` | `bomb` |
| zip entries | 20000 | `BLOOP_MAX_ENTRIES` | `bomb` |
| pages rendered | 300 | `BLOOP_MAX_PAGES` | none: later pages are not rendered and `pages` in the manifest says `{total, rendered}` |
| page aspect (width over height) | 0.25 to 8 | none | `bad_page_size` |
| video duration to encode, dimensions | 190 s, 8192 px | `BLOOP_MAX_VIDEO_SECONDS`, `BLOOP_VIDEO_RATE`, `BLOOP_TIMEOUT_VIDEO` | `bad_media` |
| image pixels | 100 million | `BLOOP_MAX_IMAGE_PIXELS` | `bad_media` |

A video that is copied has no duration cap: the input size quota bounds it, and its budget is 30 s plus twice the file size at 10 MiB/s. A video that is encoded runs under a budget of 30 s plus twice its probed length divided by the measured encode rate (`BLOOP_VIDEO_RATE`, default 0.27 seconds of video per second at one CPU), never over the video stage timeout (the ceiling, 1440 s, `BLOOP_TIMEOUT_VIDEO`); a budget that runs out fails the job with `timeout`. The encode cap follows from the ceiling: (1440 - 30) x 0.27 / 2 = 190 s. The ceiling is what is left of the conversion lease (`CAP_LEASE_CONVERT_SECONDS`, 1800 s) after the 30 s inspect stage and 300 s for the transfers, rounded down; `container/test/lease.test.mjs` keeps every kind of job's stage timeouts, summed, plus that allowance under the lease. The default rate is the slowest measurement taken on a CI runner; the rates are recorded on every corpus run, never asserted (CI run 45794592474, `--cpus` limits on a 4-vCPU runner, 30 s of 1080p30 with grain as 4:2:2, which is never copied):

| setting | wall time | seconds of video per second |
|---|---|---|
| 1 CPU, 1920 wide | 94.1 s | 0.32 |
| 2 CPU, 1920 wide | 47.2 s | 0.64 |
| 4 CPU, 1920 wide | 25.3 s | 1.19 |
| 1 CPU, `BLOOP_VIDEO_WIDTH=1280` (a 720p target) | 41.5 s | 0.72 |

The earlier run (45780852714) gave 0.27 at one CPU for the same kind of clip, so a runner varies by about 20 percent and the default keeps the lower figure. A 5-minute 720p H.264 clip (330 MB) was copied in 1.0 s at one CPU, and the output matched the input's size within 2 percent, so nothing was encoded.

What an hour of video needs: a copy is seconds, at any length. An encode of 3600 s inside the 1440 s ceiling needs a rate of 3600 x 2 / (1440 - 30) = 5.1, which is about 17 CPUs at 1080p or 8 at a 720p target on these numbers (assuming the rate scales with the CPUs, as 1, 2 and 4 do). On one vCPU the ceiling allows 190 s at 1080p at the default rate and 507 s ((1440 - 30) x 0.72 / 2) at a 720p target; a longer encode needs a higher ceiling (`BLOOP_TIMEOUT_VIDEO`, bounded by the conversion lease) or more CPUs. The Cloudflare instance type is not measured here: its vCPU count decides which row applies.

An entry that inflates past its declared size is refused (`bad_archive`).

## Outputs

For `deck`, `doc`, `sheet` and `pdf`:

- `doc.pdf`
- `s/<n>/<width>.webp` for every rendered page `n` from 1 and every width (default 3840, 1920, 480; `BLOOP_WIDTHS` is 1 to 6 strictly descending widths of at most 4095 (WebP stops at 16383 px a side, and a page may be four times taller than wide) whose smallest is at most 480, else the default)
- `t.webp`, the first page at the smallest width
- `slides.json` `{"v":1,"widths":[...],"pages":[{"n","w","h"}],"motion":bool,"media":bool}`: `w` and `h` are the widest rendition; `motion` is any animation or transition (OOXML and, through the converted pptx, ppt, pps, odp); `media` is any embedded audio or video. Notes are never in this file.
- `notes.json` `{"v":1,"notes":[{"n","text"}]}`: only slides that have notes, `n` the page number in `doc.pdf` (a hidden slide is not a page and takes no number; notes past the last rendered page are dropped), text at most 4000 characters, paragraphs joined by `\n`, every other control character removed. Phone only. Empty for anything but decks.
- `meta.json` `{"v":1,"sha256","kind","fontsMissing":[...]}`: `sha256` is of the original upload. `fontsMissing` lists typefaces a deck, docx or xlsx names that are neither installed nor covered by a metric-compatible alias (Calibri to Carlito, Cambria to Caladea, Arial and Helvetica to Liberation Sans, Times New Roman to Liberation Serif, Courier New to Liberation Mono), sorted, control characters removed, each name cut to 100 characters, at most 50 names. If `fc-list` fails the list is empty (logged), never every font. Fonts in `doc`, `xls`, `ods`, `odt` and `rtf` are not read, so it is empty for them.

For `video`: `m/0.mp4`, `t.webp` (a frame at 1 s or half the duration, at most 480 wide), `meta.json` with `video {w,h,durationMs}`.

For `image`: `i/1920.jpg`, `t.webp` (480), `meta.json` with `image {w,h}`.

Nothing else may exist in the output tree.

## Output validation

Before the manifest exists, every file is checked by its path: regular files only (no symlinks), known names only, WebP magic with the RIFF size matching the file and the exact width, JPEG start and end markers and size, `%PDF-` with no `/JavaScript`, `/Launch` or `/EmbeddedFile` (a byte scan, and only a backstop: a name written with `#xx` escapes passes it, and `pdftocairo`, which regenerates every `doc.pdf` without such objects, is the control), `ftyp` for mp4, JSON shape with unknown fields refused, every page present at every width, `slides.json` widths and dimensions equal to the images, notes in range and in order. Size caps: webp and jpeg 40 MiB each, pdf 1 GiB, mp4 4 GiB, json 5 MiB, 8 GiB in total.

Outputs are judged by group: `slides` (page images, `slides.json`, and `t.webp`), `pdf`, `notes`, `media`, `image`. A failing group is `{"ok":false,"error":"output_invalid"}` in the manifest and its files are withheld; the others publish. The job is `done` when at least one group passes. It fails with `output_invalid`, publishing nothing, when every group fails, `meta.json` is missing or malformed, or the tree holds a symlink, an unknown file or more than 8 GiB.

## Error codes

`bad_magic`, `bad_archive`, `bomb`, `too_large`, `bad_page_size`, `bad_media`, `convert_failed`, `output_invalid`, `timeout`, `upload_failed`, `internal`. Detail goes to the container log, never to the status.

## Security model

- Production isolation (CONV-01) is the platform's: a VM per instance, no internet, no DNS, one job per instance, destroyed at the deadline, and every output revalidated by the Durable Object. In a deployed container every process has root's capabilities and `start()` offers no read-only root filesystem, so non-root and read-only hold only in the corpus run, which uses `docker run --network none --read-only` as a stricter proxy.
- No network: `--network none` in CI, `enableInternet: false` in production; the image itself makes no claim. Links in documents are not followed: the registry sets update-on-load to never (`Content/Update/Link`: Writer 0 is never; Calc 1 is never and 2, its default, is on request) and `BlockUntrustedRefererLinks` on.
  - File links, proved with a firing control: a linked picture (`linked-image.odt`, target `file:///tmp/bloop-link-image.png`, a real PNG made in the container) is opened by `soffice` and lands in the PDF when `BlockUntrustedRefererLinks` is off, seen by `strace` on `openat` in a control-only image (the converter image plus `strace`, built in the corpus run; the image under test is unchanged) and by `pdfimages`. Under the production registry it is never opened and the PDF holds no image, and a real job on the same file produces a `doc.pdf` with no image. `BlockUntrustedRefererLinks` is the setting that decides; the `Link` value (0, 1 or 2) made no difference.
  - Section and field links (`linked.odt`, `linked.docx`, `linked.rtf`, a `file://` marker): `soffice` did not follow them under any of `Link` 0, 1 or 2 with `BlockUntrustedRefererLinks` off, so the control cannot fire and "the marker is absent from `doc.pdf`" is unverified for them; the corpus still asserts it.
  - Network links: the image does have an http provider (LibreOffice 25.2 ships `libucpdav1.so` and libcurl), so the absence of a provider is not a barrier. No fixture (`external.pptx`, `external.docx`, a linked picture or section on `http://127.0.0.1`) made `soffice` call `connect`, under the production registry or any relaxed one (`strace -e connect`), and `soffice --convert-to pdf http://127.0.0.1:8099/x.odt` made none either, with no listener on `none` networking and with a real HTTP server up on host networking, and wrote no PDF (it exits within about a second, the cause unknown). The detector itself works in the same container under the same command: `bash -c 'exec 3<>/dev/tcp/127.0.0.1/8099'` under `strace -f -e trace=connect` logs one `connect` (`ECONNREFUSED`). So `strace` sees connects and `soffice` made none: we never got `soffice` to connect, with the network on or off, so no control for a link-triggered connection fires. The only network barriers are `--network none` in CI and the platform's no-internet setting (`enableInternet: false`) in production; a silent canary (`external.pptx`, `external.docx`) is a check, not proof.
- Macros never run: level 3 plus the master switch off, VBA not loaded, every conversion in a fresh profile. The corpus proves it with fixtures whose macro would write `/tmp/bloop-macro-ran`, and proves the fixtures are live with a positive control: the same file under a relaxed registry (level 0, execution allowed) and under the production registry.
  - ODF Basic (`.odp`, `.odt`, `.ods`): the control fires when LibreOffice opens the document with security off and stays silent under the production registry. It does not fire under `--convert-to` even with security off (it apparently skips document-open events), so the job path is silent for a second reason; the open-path result is the one that tests the registry.
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
| `hidden.pptx` | a hidden slide takes no page number; the note on the third slide is `n` 2, with its tab removed |
| `notes-late.pptx` | with `BLOOP_MAX_PAGES=3`: 3 of 5 pages rendered, and the note on slide 5 is dropped |
| `deck-20.pptx`, `deck-100.pptx`, `deck-300.pptx` | timings at 20, 100 and 300 slides; on the 100-slide deck page 1 is fetched while the job runs; the 100 and 300 slide decks also run with `--cpus 1` under the default timeouts, and must finish and validate (times recorded, not asserted) |
| `linked-image.odt` | a picture linked to a `file://` PNG: the control (links allowed) opens it, production never does |
| `linked.odt`, `linked.docx`, `linked.rtf` | a link to a `file://` marker (an ODF linked section, `INCLUDETEXT` in docx and rtf): the marker is absent from `doc.pdf`; control unverified |
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

The corpus (`container/test/`: `corpus.mjs` lists the cases, `cases.mjs` and `macros.mjs` hold them, `lib.mjs` the harness) starts one container per case, drives it from the host with curl entered into the container's network namespace (a `--network none` container publishes no port), downloads every output, checks it against the manifest, and also checks the container itself: uid 10001, read-only root, only a loopback interface, no route out, no setuid binary, no Java, the fonts present. A 1 s convert timeout and a 1 s rasterize timeout must each fail the job with `timeout` and leave no `soffice`, `pdftoppm` or `vips` running. It prints deck timings, by stage, to the job summary.

## CI and publishing

`.github/workflows/container.yml` runs on changes under `container/` (except `digest.txt`, so pinning a digest does not rebuild) and on the workflow file, on pull requests, monthly (`0 5 1 * *`) and by hand. Runs on `main` queue; other refs cancel the older run.

- `image` job, every ref: prune-script tests, Go tests in the Docker build, build, generate fixtures, corpus, image size. On `main` it keeps the tested image as an artifact.
- `publish` job, `environment: production` (where `CLOUDFLARE_API_TOKEN`, with Containers edit, and `CLOUDFLARE_ACCOUNT_ID` live; only the push and prune steps see them). The fence that keeps those secrets from any other ref is the environment's deployment branch policy, "Selected branches: main", which is the owner's setting (`repo-settings check` verifies it); the job's `if` on `main` is a convenience, not the fence: installs the repo's pinned `wrangler` with `npm ci --ignore-scripts` (no restored npm cache), loads the tested image, tags it `sha-<12 chars of the commit>-<run id>-<attempt>` (unique per build, so a tag never moves), runs `containers push` through `tools/pinned-wrangler.mjs` (the only way a token job runs wrangler; `containers` is on its never-builds list, so no `wrangler.jsonc` build command runs), reads the pushed digest and writes the tag and digest to the job summary, with nothing else pushed: the job has no write permission and opens no pull request ("Actions create or approve PRs" stays off). Missing secrets or a failed push make the run red with the reason. The digest is pinned by a normal commit that writes it to `container/digest.txt` and whose message starts `Converter image <tag>: bump digest to <digest>` (prune reads the tag from that message); the `main` run that built the image is its test.
- Pruning, last step of `publish`, runs whether or not the digest is pinned yet: `container/prune-images.mjs` reads `container/digest.txt` from `origin/main` (never the working tree), takes the tag each pinning commit's message names (the registry lists tags, not digests; a message that names a digest the file does not hold stops the run), and keeps the live image, the one before it and the one just pushed. It deletes the other `sha-` tags of exactly `bloop-converter` with `containers images delete` (also through `tools/pinned-wrangler.mjs`), deletes nothing and fails if the live image is not in the registry, and fails if more than 4 images remain (the account cap is 50 GB). Pin the digest before the next publish: an unpinned push is pruned by it.
- The `publish` job is a SITE-05 token job: `test/unit/token-jobs.test.ts` pins it byte for byte, so changing it means updating that pin on purpose.
- The first `main` run pushed to the live registry; the prune has not yet run against it, and its wrangler calls are checked against a fake in `container/test/prune.test.mjs` only.

Dependabot raises weekly PRs for the base image digests and `go.mod`; why, what it replaces and how to remove it: ADR 0001.

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
