# ADR 0021: email through Cloudflare Email Service

Status: accepted. Sign-in: ADR 0014. Spend: the spend guard's switches and meters.

## Context
- Sign-in codes, invites and account notices need mail from `bloop.here`, signed for that domain, with no new vendor and no API key in the Worker.
- A code request must not reveal by its status, body or timing whether the address belongs to a member (AUTH-10).
- Mail costs money and has a platform daily quota, so bloop's own caps must refuse before the platform does.

## Decision
- **Binding:** `send_email` binding `EMAIL`, sender locked to `hi@bloop.here` (`EMAIL_FROM`).
- **One sender:** `src/worker/auth/email.ts` `mail()`. Every message is text plus minimal HTML from `auth/templates.ts`: no images, no tracking, links only to `PUBLIC_ORIGIN`, subjects never hold a code or anything a user typed.
- **After the response:** the switch, the spend takes and the send all run inside `ctx.waitUntil`, so no response waits on mail (AUTH-10). `mail()` resolves to whether the message was admitted, never whether it was delivered.
- **Order:** the `email` switch (`off` sends nothing; `admin_only` sends only to `ADMIN_EMAILS`), then `take("email_code", ipHash)` for a code request, then `take("email")`.
- **Guard outage:** the two email meters live on the spend guard's public instance and fail open when it is unreachable, within its per-isolate daily caps (`docs/spend.md`), so code sign-in survives an outage; `mail()` sends only what a take admitted, and the switch still applies. This is the one exception to failing closed.
- **Send errors** are logged by code only, never with an address. `E_RECIPIENT_SUPPRESSED` logs `{"evt":"email_suppressed"}` and the caller sees the same answer as for any other address.
- **Breaker alerts** (`breakerNotify`) go through `EMAIL` to each `ADMIN_EMAILS` address and nobody else, under the `email` switch (`off` sends none). They skip the spend takes, which would call back into the guard the breaker is acting on. An alert holds its kind and numbers only; the Monday digest holds the report's numbers and fixed labels. The breaker claims each alert key once a UTC day (`alertOnce`) before it sends; when no address took the mail `breakerNotify` throws, the claim is released, and the next run sends again. The five-minute cron's `cronNotify` logs every alert line first, then mails, with the `email` switch read fresh; it parses `PUBLIC_ORIGIN`, `EMAIL_FROM`, `ADMIN_EMAILS` and `DEV_MAILBOX` alone, so the invalid-config alert still mails unless one of those four is what broke.
- **Addresses:** `mail()` admits only an address `normalizeEmail` accepts, under every switch.
- **Local:** `DEV_MAILBOX=1` (refused on a non-local origin, and its route answers only a local request) keeps the newest 50 messages in memory, read and cleared at `/api/dev/mailbox`. Email preview is off in the dashboard.

### Verified against the Email Service docs
- `env.EMAIL.send({to, from, subject, text, html})` resolves to `{messageId}`; `to` and `from` take a string or `{email, name}`; at most 50 recipients; 25 MiB per message.
- A failure throws an error with `code` and `message`; a malformed argument throws a `TypeError` with no code. The codes include `E_RECIPIENT_SUPPRESSED`, `E_RECIPIENT_NOT_ALLOWED`, `E_SENDER_NOT_VERIFIED`, `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED`.
- `allowed_sender_addresses` restricts the sender; wrangler 4.166's config schema has the key.

### Unverified
- The daily quota: the docs give no number for a new account (200 a day is recorded from the dashboard; `CAP_EMAIL_DAY` stays under it).

## Rejected
- **A third-party mail API:** a new vendor, an API key in the Worker and a second data processor.
- **Sending before the response:** the response time would show who is a member.
- **Failing closed on a guard outage:** a guard outage would stop every sign-in.
- **A second binding locked to one alert inbox:** a second binding and destination to onboard and keep in step with `ADMIN_EMAILS`, which already names who gets admin mail.

## Threats served
AUTH-10 (mail from `waitUntil`, uniform answer), AUTH-09 (a code reaches only the address it is bound to), and the spend caps.

## How to remove it
Remove the binding and `email.ts`. Invites keep the Copy Link path, and passkey sign-in keeps working; code sign-in stops.
