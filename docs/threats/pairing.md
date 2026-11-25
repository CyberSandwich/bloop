# Threats: pairing with accounts and notes

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: P1 (present server); the pairing rules are in ADR 0015.

| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| PAIR-14 | S | Reverse QRLjacking: an attacker relays their own screen's QR so a signed-in victim approves onto it | med | high | The phone shows three 2-digit choices and the user taps the one on the screen in front of them; a wrong tap cancels the claim and the screen gets a new code | `PAIR-14 match` | planned |
| PAIR-15 | D | A stranger spends a live code, or probes whether a code exists, without an account | med | med | The claim checks the cookie before the Directory lookup, so a signed-out claim cannot spend a code | `PAIR-15 auth-first` | planned |
| PAIR-16 | I | The screen's view leaks a file id, user id or email | low | high | `ScreenView` carries only the display flags; a schema test rejects any other key | `PAIR-16 view` | planned |
| NOTES-01 | I | Speaker notes reach the screen | low | high | The notes route answers only a pairing's pid, live, and `no-store`; no frame, link or bundle carries notes | `NOTES-01 phone-only` | planned |
