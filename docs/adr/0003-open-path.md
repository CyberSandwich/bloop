# ADR 0003: open path, redirect or stream behind one interface

Status: proposed. Default `redirect`; M0 test T3 decides.

## Context
The screen must open the user's file in installed PowerPoint, with no account on the PC. Facts:
- Office URIs (`ms-powerpoint:ofv|u|<url>`) cap the length at 256 characters and bar `\ / : ? < > | " *` in names.
- Graph's `@microsoft.graph.downloadUrl` is pre-authenticated, long, and lives "minutes" to "1 hour", and bloop cannot revoke it.
- Some Office builds append `?OR=ProtocolHandler&CID=...` and write the full URL into a `.url` shortcut.
- Whether PowerPoint follows a 302 is undocumented.

## Decision
- **One link shape:** `https://<host>/f/<token>/<safe-name>.<ext>`, at most 200 characters.
  - `token` is `screenRef` (22) plus a secret (32), base64url, and only its hash is stored.
  - `safe-name` comes from `names.js`: unsafe characters removed, NFC, at most 60 characters.
  - The name segment and any query are ignored by the server.
- **One `OpenPath` interface, two implementations, chosen by `OPEN_PATH_MODE`:**
  - `RedirectOpenPath` (default): at fetch time, resolve the Graph URL, check its host against `GRAPH_DOWNLOAD_HOSTS`, and answer 302 with `no-store`. bloop never carries deck bytes.
  - `StreamOpenPath`: resolve, then stream the body with `Content-Disposition: attachment` and `no-store`. Guest files always stream from R2.
- **Resolve at fetch, not at approve:** download URLs can expire in minutes, and the edit made just before the tap is then the one that opens.
- **Link life:** a link dies at session end, 10 min after mint if never fetched, and 2 min after its first fetch. It allows at most 10 fetches. It is not single-use, because Office sends several requests (probe, HEAD, GET). T3 counts them and the limits follow.
- **Methods:** GET and HEAD only. OPTIONS, PROPFIND and every write method get 405 with `Allow: GET, HEAD`. `ofv` opens read-only.
- **Binding:** the screen's IP hash, compared per fetch. Modes `off`, `log` (default) or `enforce` per room (OD-4).
- **Fallback ladder (screen):**
  1. protocol launch;
  2. if no fetch is seen within 5 s, "PowerPoint didn't open." with Download (a fresh `download` link);
  3. a labeled PDF view in a new tab (a fresh `pdf` link; Graph converts with `format=pdf`, mock and guest PDFs are served as is).
  - At most 5 extra mints per session, all for the approved file.
- **"Open" is measured server-side:** the first accepted fetch moves the session to `open` and records `scan_to_open_ms`.

## Consequences
- In redirect mode, the Graph URL reaches PowerPoint and may outlive the session for up to an hour (threat model OPEN-03). `/it` says so.
- Stream mode closes that gap. Its costs: bloop carries the bytes (no egress fee; streaming uses little CPU), and the "bloop keeps no copy" wording must change to "passes through, not stored".
- If T3 shows PowerPoint does not follow the redirect, flip `OPEN_PATH_MODE` to `stream`. No other module changes.

## Revisit when
- T3 or T20 report a result.
- Microsoft documents a supported open-from-URL path with revocation.
