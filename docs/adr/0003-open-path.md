# ADR 0003: open path, redirect or stream behind one interface

Status: accepted as built. Default `redirect`; field test T3 decides (docs/setup.md, "Field test T3").

## Context
The screen must open the user's file in installed PowerPoint, with no account on the PC. Facts:
- Office URIs (`ms-powerpoint:ofv|u|<url>`) cap the length at 256 characters and bar `\ / : ? < > | " *` in names.
- Graph's `@microsoft.graph.downloadUrl` is pre-authenticated, long, and lives "minutes" to "1 hour", and bloop cannot revoke it.
- Some Office builds append `?OR=ProtocolHandler&CID=...` and write the full URL into a `.url` shortcut.
- Whether PowerPoint follows a 302 is undocumented.
- A browser may refuse an external-protocol launch that no user gesture caused (unverified for the lectern browsers, T3).

## Decision
- **One link shape:** `https://<host>/f/<token>/<safe-name>.<ext>`, at most 200 characters.
  - `token` is `screenRef` (22) plus 32 base64url characters of secret (192 bits), and only its hash is stored.
  - `safe-name` comes from `public/js/shared/names.js`: an ASCII slug (`[A-Za-z0-9-]`, accents folded, every other run of characters one hyphen, 60 characters at most, `file` when nothing is left). A strict slug rather than a removal list, so no banned character, `..` or percent-encoding can appear and the length is exactly what it looks like (fix F7). The name is cut further so the whole link fits 200 characters for the configured origin; `PUBLIC_ORIGIN` is capped at 120 characters so that is always at least 17. With the `ms-powerpoint:ofv|u|` prefix the URI stays at 220 or less, under Office's 256 (unit-tested on the longest name and the longest origin).
  - The name segment and any query are ignored by the server. Names with no Latin letters or digits become `file`.
- **One `OpenPath` interface, two implementations, chosen by `OPEN_PATH_MODE`.** Minting and the link rules are mode-independent functions, not part of the interface:
  - `RedirectOpenPath` (default): at fetch time the source resolves the file; the answer is a 302 to its pre-authenticated URL, after the host is checked against `GRAPH_DOWNLOAD_HOSTS` here as well as in the source (502 otherwise). Nothing from the request reaches the `Location`. bloop never carries deck bytes. A source with no URL (the mock, guest files) streams instead.
  - `StreamOpenPath`: resolves, then streams the body with the detected `Content-Type`, `Content-Length` when known, `Content-Disposition: attachment` and `no-store`. HEAD answers from the metadata without opening the stream. Guest files always stream from R2.
- **Resolve at fetch, not at approve:** download URLs can expire in minutes, and the edit made just before the tap is then the one that opens. The account that reads the file is the one the approving phone was signed in as; the Screen object keeps its id for the session (the machine's `approve` carries it).
- **Link life:** a link dies at session end, `LINK_FIRST_FETCH_SECONDS` (600) after mint if never fetched, and `LINK_FETCH_WINDOW_SECONDS` (120) after its first fetch. It allows at most `LINK_MAX_FETCHES` (10) fetches, GET and HEAD alike. It is not single-use, because Office sends several requests (probe, HEAD, GET). T3 counts them and the limits follow. The check and the count are one synchronous step in the Screen object, so concurrent requests cannot both take the last fetch. A `view` link (an image or a video on the screen page) is the exception: a video player reads in ranges and seeks, and may seek back at any point of a talk, so once fetched it has no fetch count and no window: it keeps answering until the session ends, bounded instead by its own read limit (`RL_FETCH` keyed by the link's hash, beside the per-IP one) (VID-02). Every other link spends the per-screen read limit (`RL_FETCH` keyed by the screen ref). Both are charged after the Screen object's check (`checkLink`) and before the fetch is counted (`useLink`), so a guessed token never spends them and a 429 never spends a fetch.
- **Refusals:** a token that is malformed, unknown, or belongs to a screen that has closed is `404 link_unknown`, the same body each time. At session end every record is marked revoked and kept until the Screen object closes: a holder of a real token then gets `410 link_revoked`, a guesser still gets 404, and neither can tell from the answer whether a token ever existed. Exhausted and expired links are `410`.
- **Methods:** GET and HEAD only. OPTIONS, PROPFIND and every write method get 405 with `Allow: GET, HEAD`, before any token is looked at. `ofv` opens read-only. Range requests are not supported.
- **Binding:** the IP hash of the screen that proved its sid (socket `hello` or poll) is read when each link is checked (the earliest-verified live screen socket, else the last proof kept), and each fetch's is compared. `LINK_BINDING_DEFAULT`: `off`, `log` (default, an audit flag) or `enforce` (403 `link_binding_failed`). Per room (OD-4) waits for rooms.
- **Audit:** the minted link and every fetch or refusal are written to the audit seam with the method, the class of client (`office`, `browser`, `other`; never the raw User-Agent) and the fetch count.
- **Fallback ladder (screen):**
  1. protocol launch (`location.assign`), reported once as `launched`. If the page had no user activation, an Open button also shows, and its click launches again;
  2. Download It Instead shows at once, as the secondary action beside the launch (it was held back 5 s; the wait hid the way out from the person who most needed it). It mints a `download` link, which the browser saves as an attachment. The fetch moves the session to `open` with open mode `download`, and both pages show "PowerPoint didn't open.";
  3. there, Show as PDF Instead mints a `pdf` link (the deck's PDF rendition, or a PDF file itself) and opens it in a named second window under the PDF CSP below. The control is an addition to design.md's open-fallback row: the design named the PDF state but no way into it.
  - Each approved file's first link is free, then at most 5 more (`LINK_MINTS_PER_ITEM`) (ADR 0009: a session holds a list, and a mint names its item); a full list of 12 allows 72 in all. An approved screen that never got its `open` frame (reload, dropped socket) asks for the protocol link again, which also counts.
- **A PDF file** is its own view: its first link is a `pdf` link, the screen opens it in a window (an Open click if the popup blocker refuses), and it shows the PDF-fallback text. That text says PowerPoint can't open it, which is wrong for a file that was a PDF to begin with; the design needs a string for it.
- **PDF CSP:** the PDF view's response has its own policy, `default-src 'none'; object-src 'self'; frame-ancestors 'none'`, with `Content-Disposition: inline`. The page cannot frame it (the screen's CSP has no `frame-src`), so it is a top-level window, which the screen's CSP does not restrict. `sandbox` is left out because Chromium does not render a PDF in a sandboxed document. `object-src 'self'` is the one allowance, because Chromium's viewer is an embedded plugin and the `default-src 'none'` fallback may block it. Both points are unverified until field check F-PDF; if the plain `default-src 'none'` renders, drop the allowance.
- **"Open" is measured server-side:** the first accepted fetch of any link moves the session to `open` and records `scan_to_open_ms`.
- **Residue on the page:** at `ended` and `closed` the screen drops its links and timers, closes the PDF window it opened, empties `sessionStorage` of `bloop.*` keys and rewrites the address bar. The screen's own End response also carries `Clear-Site-Data: "storage"`, which works even if the page script was tampered with. The page re-stores its credential when the screen waits again, so a reload resumes the screen.

## Consequences
- In redirect mode, the Graph URL reaches PowerPoint and may outlive the session for up to an hour (threat model OPEN-03). `/it` says so.
- Stream mode closes that gap. Its costs: bloop carries the bytes (no egress fee; streaming uses little CPU), and the "bloop keeps no copy" wording must change to "passes through, not stored".
- If T3 shows PowerPoint does not follow the redirect, flip `OPEN_PATH_MODE` to `stream`. No other module changes.
- Cloudflare's own request log (`wrangler tail`, Workers Logs if enabled) records the `/f/` URL, so a token sits in the platform's logs. It is dead once the session ends, which is what makes that tolerable; the Worker's own log lines (`open.fetch`: method, client class, query, Range, status) carry no token, IP or raw User-Agent.
- The mock source has no URL, so on a local run both modes stream; the redirect branch is covered by unit tests with a fake source and is first exercised end to end against Graph.

## Revisit when
- T3 or T20 report a result.
- F-PDF reports whether the PDF view renders, and under which CSP.
- Microsoft documents a supported open-from-URL path with revocation.
