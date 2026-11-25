# Threats: file origin and Online Safety Act duties

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner streams: P1 (present server) for FO-01, A (accounts and admin) for the OSA rows.

| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| FO-01 | D | The workers.dev file origin is blocked on a network, so files do not load | med | med | `/s` probes `/fo/ping` with a short timeout and mints links on bloop.here when the probe fails. Residual: the fallback serves files from the main host | `FO-01 fallback` | planned |
| OSA-01 | T | Illegal content stored or shown | med | high | Report routes, and an admin disable that stops serving at fetch time | `OSA-01 disable` | planned |
| OSA-02 | R | Evidence lost when illegal content is removed | low | high | A hold copy under its own prefix, out of reach of an account purge | `OSA-02 hold` | planned |
| OSA-03 | R | An intimate-image report is not actioned in time | low | high | A written process with a 48 hour takedown target | none | planned |
| OSA-04 | E | Children use the service | low | high | Invite-only access and an 18+ acceptance on the invite page | none | planned |
| OSA-05 | R | Moderation actions are unaccountable | med | med | Every admin action writes a log row in the same batch as the change, and a refused change writes none | `OSA-05 log` | planned |
| OSA-06 | D | Report spam | med | low | Rate limit plus Turnstile on the report route | `OSA-06 limit` | planned |
