# ADR 0022: Turnstile on the code request and reports

Status: accepted. Sign-in: ADR 0014.

## Context
- `POST /api/auth/code/request` and `POST /api/reports` are unauthenticated and cost something: a code mail, a D1 row, an admin's attention.
- Rate-limit bindings bound the rate per IP but not a spread-out script.

## Decision
- **Where:** the code request (action `signin`) and the report form (action `report`). A managed widget, invisible until it needs a person, loaded on intent through the one Trusted Types policy (`tt.js` allowlists the exact `api.js?render=explicit` URL). Pre-clearance is off, so no `cf_clearance` cookie.
- **Check:** `src/worker/auth/turnstile.ts` `verifyTurnstile()` posts to siteverify with a 5 s timeout and an `idempotency_key`, then requires `success`, the expected `action` and `hostname` equal to `PUBLIC_ORIGIN`'s. A missing secret, a network error, a timeout or any other answer fails closed. Cloudflare's test keys answer hostname `example.com` and no action, so under `TEST_TIMING` the hostname check is skipped and a missing action is accepted; a different action never is.
- **Friction only:** a token is single use for 300 s, but duplicate detection is eventually consistent, so the RL bindings and the D1 buckets stay the limits.
- **Fallback if Trusted Types breaks it:** a static `<script async>` tag on `/signin` and `/report` only.

## Rejected
- **No challenge:** the code request would rest on per-IP limits alone.
- **Pre-clearance:** a cookie on every page for a check two forms need.

## Threats served
AUTH-09 (fewer scripted code requests), OSA-06 (report spam).

## How to remove it
Drop the check from both routes and the loader, and lean on the RL bindings plus invite-only sign-up.
