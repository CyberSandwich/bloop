# ADR 0007: demo mode isolation

Status: proposed

## Context
`/s?mode=demo`, entered from the landing, runs the full flow for anyone, with no account: a live QR (or this device as the phone), the phone approval, the open shown in the page, and a guest drop. The demo must never reach a real user's data, the token vault or Graph, and must not become a free file host or a way to exhaust the free tier.

## Decision
- **Mode is fixed at creation, server-side:** `POST /api/screens {mode: "demo"}` stores `mode` in the Screen object's `meta`. Every later decision reads it from there, never from the client.
- **No account path:** for a demo screen, `/api/files` and `/api/approve` never read the `__Host-bloop_sid` cookie, never construct `GraphFileSource`, and never import the vault. The demo uses `MockFileSource` with staged fixtures. A test asserts the demo route handlers have no reference to the vault module.
- **Same code, other limits:**
  - sessions that start at 1 hour, as live ones do, and that the phone can set up to 2 hours from approval (`DEMO_MAX_MINUTES`), so a visitor can try every catalog item and Revoke at leisure without one visitor holding a slot all day;
  - guest policy `open` with a 25 MB cap, and the same screen-side Open click;
  - the same validation and deletion as live;
  - per-IP rate limits of their own (`RL_DEMO_CREATE`, `RL_DEMO_CLAIM`), a global cap on concurrent demo screens (`DEMO_MAX_CONCURRENT`, held in the Directory) and a per-IP-hash cap (`DEMO_MAX_PER_IP`, same table; why: creates held for 15 minutes would otherwise fill the cap from one address; remove: delete the variable and the `ip_hash` check);
  - `DEMO_ENABLED=false` turns it off.
- **Records:** demo sessions and audit rows have no user. They are kept 7 days, and metrics are tagged `mode = demo` so they never mix into product numbers.
- **Visible:** the phone shows "Open Sample deck.pptx here?" with "This is a demo. You don't need an account."; the screen shows its demo room line, and after approval the file in the page with "On a room PC this opens in PowerPoint." (architecture.md 4.5).
- **Code space:** demo and live codes share the Directory. Scanning a demo code from a signed-in phone runs the demo, and the cookie is ignored.

## Consequences
- The demo exercises the real pairing, open path and guest drop, so it doubles as a smoke test in production.
- A demo slot is held until the screen closes or its hold lapses (a claim window plus one session), so one address can hold its per-IP share for about an hour. The live product does not share the cap, and the demo is optional (`DEMO_ENABLED`); this is the accepted residual (DEMO-02).
- The demo guest drop is a public upload endpoint. The caps, the type checks and deletion at session end (60 minutes at most) keep it from becoming file hosting.
