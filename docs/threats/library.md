# Threats: library

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: L (library); the data model is ADR 0013.

| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| LIB-01 | I, E | IDOR: one user reads or changes another user's file | med | high | `user_id` is in the WHERE clause of every library query; no route takes it from the client | `LIB-01 idor` | planned |
| LIB-02 | T | A quota race lets uploads exceed the user's limit | med | med | Quota is reserved with one conditional UPDATE at create and settled at complete | `LIB-02 race` | planned |
| LIB-03 | I | A trashed or disabled file is still served | med | high | The source re-checks owner, status, trash, disable and version at fetch time, not at approve time | `LIB-03 fetch-time` | planned |
| LIB-04 | S, T | A forged or stale preview token | low | high | The token is an HMAC with `FILE_TOKEN_KEY` and carries the file version; a changed version refuses it | `LIB-04 hmac`, `LIB-04 version` | planned |
| LIB-05 | E | Active content in a user's file runs with bloop's authority | med | high | Files are served from a separate site with a sandbox CSP, a fixed type and `nosniff`, and no cookies | `LIB-05 headers` | planned |
| LIB-06 | T | A file name injects markup or a header | med | med | Names reach the page only through `textContent`, and downloads use `filename*` | `LIB-06 names` | planned |
| LIB-07 | R | The data export misses files or metadata | low | med | The export is built from the same rows as the library and tested for completeness | `LIB-07 export` | planned |
| LIB-08 | I | Erasure leaves objects behind | med | high | The purge covers the original, every derived object and the user's Durable Object, in bounded rounds, and writes a tombstone | `LIB-08 erase` | planned |
| LIB-09 | D, I | Retention jobs fail or skip rows, so trash or inactive accounts linger (or members are deleted by mistake) | med | med | Each sweep is bounded, repeatable and skips email users in the user-row sweep; trash and inactivity have their own tests | `LIB-09 trash`, `LIB-09 inactive` | planned |
