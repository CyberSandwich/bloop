# Threats: library

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: L (library); the data model is ADR 0013, the decisions ADR 0016.

| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| LIB-01 | I, E | IDOR: one user reads or changes another user's file | med | high | `user_id` is in the WHERE clause of every library query, and the user object is named by the session's user; no route takes either from the client. A foreign id and an unknown id get the same answer | `LIB-01 idor sql`, `LIB-01 idor` | mitigated |
| LIB-02 | T | A quota or Up Next race: bytes released twice, uploads past the limit, or more than 12 ticked | med | med | Quota moves in one guarded statement with its row; a tick counts in the same statement | `LIB-02 race` | mitigated |
| LIB-03 | I | A trashed or disabled file is still served | med | high | One predicate re-checks owner, status, trash, disable, version and the pinned session at fetch time, not at approve time | `LIB-03 fetch-time`, `LIB-03 pinned` | planned |
| LIB-04 | S, T | A forged or stale preview token | low | high | The token is an HMAC with `FILE_TOKEN_KEY` carrying the file version and a 300 s expiry; a changed version, a wrong key or a flipped byte refuses it | `LIB-04 hmac`, `LIB-04 version`, `LIB-04 expiry`, `LIB-04 rotation` | mitigated |
| LIB-05 | E | Active content in a user's file runs with bloop's authority | med | high | Files are served from a separate site with a sandbox CSP, a fixed type and `nosniff`, and no cookies | `LIB-05 headers` | planned |
| LIB-06 | T | A file name injects markup, a path or a header | med | med | Names pass one rule (no controls, bidi or slashes), reach the page only through `textContent`, and download through `filename*` | `LIB-06 names` | planned |
| LIB-07 | R | The data export misses files or metadata, or is not what was promised | low | med | The export is built from the same rows as the library, stores every CRC, and is a pure function of its snapshot | `LIB-07 export`, `LIB-07 crc`, `LIB-07 deterministic`, `LIB-07 zip64` | planned |
| LIB-08 | I | Erasure leaves objects behind | med | high | The purge empties the R2 prefix by listing, not from D1, twice (a late put is caught), then the user's object, and writes a tombstone; holds and tombstones sit outside the prefix | `LIB-08 erase`, `LIB-08 late-put`, `LIB-08 orphan` | planned |
| LIB-09 | D, I | Retention jobs fail or skip rows, so trash or inactive accounts linger, or members are deleted by mistake | med | med | Each sweep is bounded and repeatable; a warning is sent before any inactivity deletion; trash and inactivity have their own tests | `LIB-09 trash`, `LIB-09 inactive` | planned |
| LIB-10 | D | Export abuse: many exports, or one that never ends | med | med | One at a time per user (a lease), a daily cap from the spend guard, a switch, a same-origin check before any read | `LIB-10 export abuse` | planned |
| LIB-11 | I, T | A held, disabled or suspended file is lost or served; the user object never sleeps | med | high | A hold copy survives both purges; a disabled file is absent from the list, approve and export; the object sets no timer | `LIB-11 moderation`, `LIB-11 hibernate` | planned |
| LIB-12 | T | A write race resurrects a trashed row or leaves a ghost | med | med | Writes are guarded updates, none inserts; restore and purge never overlap in time | `LIB-12 race` | mitigated |
| LIB-13 | D | Progress frames flood the page | low | low | Frames are throttled to one a second per file, and the first slide goes out before the rest | `LIB-13 progress` | planned |
| LIB-14 | T | The serving rule is written twice and drifts | med | high | One exported predicate, imported by the library source and the converter's publish step | `LIB-14 fragment` | planned |
