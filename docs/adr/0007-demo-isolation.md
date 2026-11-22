# ADR 0007: demo mode isolation

Status: proposed

## Context
The landing page runs the full flow for anyone, with no account: a live QR, the phone approval, the open, and a guest drop. The demo must never reach a real user's data, the token vault or Graph, and must not become a free file host or a way to exhaust the free tier.

## Decision
- **Mode is fixed at creation, server-side:** `POST /api/screens {mode: "demo"}` stores `mode` in the Screen object's `meta`. Every later decision reads it from there, never from the client.
- **No account path:** for a demo screen, `/api/files` and `/api/approve` never read the `__Host-bloop_sid` cookie, never construct `GraphFileSource`, and never import the vault. The demo uses `MockFileSource` with staged fixtures. A test asserts the demo route handlers have no reference to the vault module.
- **Same code, other limits:**
  - 10-minute sessions;
  - guest policy `open` with a 10 MB cap, and the same screen-side Open click;
  - the same validation and deletion as live;
  - binding rate limits as live;
  - `DEMO_ENABLED=false` turns it off.
- **Records:** demo sessions and audit rows have no user. They are kept 7 days, and metrics are tagged `mode = demo` so they never mix into product numbers.
- **Visible:** the phone shows "Open the sample deck here?" with "This is a demo. You don't need an account."; the screen shows its demo room line.
- **Code space:** demo and live codes share the Directory. Scanning a demo code from a signed-in phone runs the demo, and the cookie is ignored.

## Consequences
- The demo exercises the real pairing, open path and guest drop, so it doubles as a smoke test in production.
- The demo guest drop is a public upload endpoint. The caps, the type checks and deletion at 10 minutes keep it from becoming file hosting.
