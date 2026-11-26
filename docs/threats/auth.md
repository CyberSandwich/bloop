# Threats: sign-in and invites

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: A (accounts and admin).

## Auth
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| AUTH-08 | S | Session fixation: an attacker plants a session id before sign-in and uses it after | med | high | Rotate the session cookie on every authentication (code, passkey, reauth) | `AUTH-08 rotate` | mitigated |
| AUTH-09 | S, D | Brute force of the 6-digit email code | med | high | The code is stored as an HMAC with a pepper; 5 attempts, then the challenge dies; 10 minute life; per-email and per-IP limits | `AUTH-09 attempts`, `AUTH-09 mac` | mitigated |
| AUTH-10 | I | Enumeration of which addresses have accounts | med | med | The code request always answers 202 with the same body and writes a code row either way; whether mail goes out (only to an active or deleting member the mode and the block list admit) is decided after the response, so a slow or hung mailer never shows in it | `AUTH-10 uniform` | mitigated |
| AUTH-11 | E | A rogue passkey added to an account from a stolen session | low | high | Adding a passkey needs a session plus a recent reauth; a notice email goes to the owner | `AUTH-11 reauth` | planned |
| AUTH-12 | S, R | WebAuthn replay, or an assertion for another origin | low | high | Single-use challenge, the binder cookie, and rpID and origin checks on every verify | `AUTH-12 challenge`, `AUTH-12 origin` | planned |
| AUTH-13 | E | A revoked or suspended user keeps working | med | high | Sign out everywhere ends every session; suspension is checked when a session resolves | `AUTH-13 signout-all` | mitigated |
| AUTH-14 | S, E | Account takeover through an email change | low | high | The change needs a session plus a recent reauth, and a code sent to the new address; the old address gets a notice | `AUTH-14 change` | planned |
| AUTH-15 | T | CSRF on the new write routes | med | high | Every write passes the shared guard: Origin, fetch metadata, JSON content type, strict body | `AUTH-15 csrf` | planned |
| AUTH-16 | E | Admin escalation | low | high | The admin role comes from the `ADMIN_EMAILS` secret and is checked on every request, never stored on the user. Residual: whoever can write D1 directly can set a member's `email_norm` to an admin address no row holds (an admin not yet signed up, or one who changed address) and gain the role; the unique index stops it only while the admin's row holds the address. Residual: the admin paths and the member routes share the per-IP `RL_MEMBER_IP` bucket and an unknown path spends none, so a caller who exhausts it through an admin path and then sees a member route refused learns that the admin path exists; it learns nothing about who is an admin | `AUTH-16 admin`, `AUTH-16 passkey` | planned |
| AUTH-17 | S | Mailbox compromise: whoever reads the mailbox can sign in by code | med | high | Residual, stated plainly: the email code is the fallback and recovery path; a passkey avoids it | none | planned |
| AUTH-18 | S | A copied or old known-device cookie outlives sign out everywhere, so a former device keeps the member's trusted code bucket | low | med | The member's device epoch is in the cookie's MAC; sign out everywhere, ending one session, a passkey removal and a deletion request move it in one batch with the change, refusing every earlier value on every device | `AUTH-18 epoch` | mitigated |
| AUTH-19 | D | Unmetered D1 reads through member and admin routes: a flood of requests reads D1 with no limit spent | med | med | Every member and admin route, and the member page gate (a malformed cookie reads nothing; over the limit the page renders signed out), spends the per-IP `RL_MEMBER_IP` before its first session read, then the member-keyed limit where one applies (the architecture rate-limit table). Residual: the shared-bucket existence oracle, stated in AUTH-16 | `AUTH-19 meter` | mitigated |

## Invites
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| INV-01 | I | An invite token leaks | low | med | 256 bits, stored hashed, carried in the URL fragment, `no-referrer` | `INV-01 hash` | mitigated |
| INV-02 | S | A forwarded invite is used by someone else | med | med | The code goes to the email the invite is bound to, so a forwarded link alone signs nobody in | `INV-02 bound` | mitigated |
| INV-03 | T | A link scanner consumes the invite before its owner | high | low | Opening the link (peek) never consumes it; only the verified code does | `INV-03 peek` | mitigated |
| INV-04 | S | Replay after accept, revoke or expiry | low | med | A dead token is refused in the same way as an unknown one | `INV-04 dead` | mitigated |
| INV-05 | S | An old link works after a resend | low | med | A resend issues a new token and kills the old one, and the codes already mailed for it | `INV-05 resend` | mitigated |
