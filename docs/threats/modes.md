# Threats: launch modes

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: F (foundation); the rules are in ADR 0026.

| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| MODE-01 | I, E | In preview, an open surface or an invite reaches someone outside the test list | med | high | Preview never exposes the open surfaces or invites to non-test emails; with `preview_lockout` no account outside `ADMIN_EMAILS` plus `TEST_EMAILS` works. A missing, unknown or failed mode read means preview, and every `/open` path form is 404 in both modes | `MODE-01 modes` | planned |
