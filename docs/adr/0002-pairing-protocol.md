# ADR 0002: pairing protocol and code design

Status: proposed. The `Directory` object is accepted as is.

## Context
A screen with no account must be paired with one phone in seconds, by scan or by typing. The code is visible to the whole room. The model is RFC 8628 (device authorization grant), without Microsoft's device-code flow. That flow would put a Microsoft token on the screen, and Microsoft's own guidance warns that it invites remote phishing.

## Decision
- **Mapping to RFC 8628:**
  - the screen's `sid` plays `device_code` (secret, held by the screen);
  - the 6-character code plays `user_code`;
  - `/code` plays `verification_uri`, and the QR URL `https://<host>/a?c=<code>` plays `verification_uri_complete`;
  - the WebSocket push replaces `interval` polling, and polling remains the fallback;
  - `waiting` maps to `authorization_pending`, `rate_limited` to `slow_down`, `canceled` to `access_denied`, and `code_expired` to `expired_token`.
- **Departures from RFC 8628:**
  - the user code lives 60 s plus a 10 s grace, not about 15 min, and is single use;
  - it locks to the first phone that claims it, which gets a 256-bit pairing secret;
  - nothing is issued to the screen but a link to the one approved file.
- **Code:** 6 symbols from a 30-symbol alphabet with no `0 O 1 I L U` (about 29.4 bits), drawn by rejection sampling from `crypto.getRandomValues`. It is shown as `K7M Q9X`, and the input accepts lowercase, spaces and dashes. `CODE_LENGTH=7` is the escalation if guessing pressure appears (RFC 8628 section 5.1). Codes are random, not `HMAC(secret, window)`. A directory write per code is needed anyway (below), so derivation saves nothing.
- **Rotation is driven by the screen:** the page asks for `code.next` every 60 s and when it becomes visible again. The server enforces expiry. A hidden or closed tab stops costing requests, and no per-minute alarm runs.
- **Two Durable Object classes:**
  - `Screen`, one per screen, is the single serialization point for single use, the pairing and timers;
  - `Directory`, one instance, maps a typed code to its screen and counts misses exactly per hashed IP.
  - A per-screen object cannot count misses for codes that route nowhere, so exact guess limits need the directory. At MVP scale one instance is far below the per-object limit of about 1,000 requests per second. Splitting it by the code's first symbol is the scale-out.
- **Handles:**
  - `screenRef` is 128-bit, routes through `idFromName` on the `eu` namespace, and is not a secret;
  - `sid` is `screenRef.secret` and `pid` is `screenRef.secret`, each with a 256-bit secret stored as a SHA-256 hash;
  - these travel in `Authorization`, never in URLs.
- **Match code:** 2 digits, fresh per claim, shown on both sides. It is a human check for the right screen, not a secret (threat model PAIR-04).
- **Claim timeout:** 5 min unapproved (15 min while uploading), then back to `waiting`. The screen gets "Start Over" to drop a claim at once (decided, OD-6).

## Implementation notes
- Both objects have SQLite storage. A drop back to `waiting` (cancel, Start Over, timeout) wipes the codes, and the Screen object issues a fresh one at once, so the screen needs no extra round trip. This issue counts toward the 6 per minute.
- A screen with no socket polls `GET /api/screen/state`, which doubles as the rotation clock and keeps the screen from closing. A socket's upgrade URL carries the non-secret `screenRef` (`?ref=`), since the credential is the first frame and the Worker must know which object to route to.
- Concurrency: the Screen object does async work (hashing, drawing) before a synchronous check-and-commit of one machine step, because awaiting a subrequest lets other events in. The first-phone lock rests on that.
- The Directory keeps claimed and expired codes for 5 min, so a replay answers `code_taken` and a late phone `code_expired`, and neither counts as a guess.
- Local runs have no `eu` jurisdiction (workerd does not implement it), so the stubs skip it for a local `PUBLIC_ORIGIN`.

## Consequences
- The QR holds about 37 characters (version 3), the shortest possible, which helps scanning at distance.
- One extra hop per claim (Worker, then Directory, then Screen). Typed and scanned codes share one path, so they behave the same.
- Directory writes: one per code per screen, so an always-on screen costs about 480 writes per 8-hour day. That fits the free tier for about 200 always-on screens. Beyond that, the paid plan applies.
- Exit path: both classes become maps in one Node process.

## Rejected
- **Microsoft device-code flow:** a token on the screen, and a known phishing vector.
- **A long unguessable code only in the QR:** it still needs a typed short code, which is the weak point anyway, and a longer QR scans worse.
- **Codes in D1:** the same write count, and no exact single-threaded counters.
