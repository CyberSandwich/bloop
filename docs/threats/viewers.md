# Threats: viewers

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: P1 (present server) for the viewer pages; V (conversion) for the formats they read.

| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| VIEW-01 | E | A PDF viewer exploit through a crafted file | med | high | A pinned build with eval and wasm off, running in a self-hosted worker | `VIEW-01 config` | planned |
| VIEW-02 | E | Script injection through markdown | med | high | Markdown becomes tokens, then DOM nodes built by our code; there is no HTML sink | `VIEW-02 md` | planned |
| VIEW-03 | D, T | A spreadsheet that exhausts the browser, or formulas that run | med | med | Read values only, never formulas; row, column and size caps; parsing in a Worker | `VIEW-03 caps` | planned |
| VIEW-04 | E | A viewer worker loaded from an injected URL | low | high | One Trusted Types policy allows only the exact viewer worker URLs | `VIEW-04 tt` | planned |
