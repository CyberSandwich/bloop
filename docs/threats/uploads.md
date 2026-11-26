# Threats: uploads and refused content

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: U (uploads). For the DROP rows the threat is the content a check refuses and the mitigation is the refusal.

## Uploads
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| UP-01 | E | A presigned URL broader than one part | low | high | Each URL is one part, one key, PUT only, and short-lived | `UP-01 scope` | planned |
| UP-02 | D | Oversize upload or a part count beyond the bound | med | med | The declared size must equal the head size at complete; the part count is bounded | `UP-02 size` | planned |
| UP-03 | E | Using another user's upload id | med | high | Every upload route checks the owner | `UP-03 owner` | planned |
| UP-04 | D | Stale multipart uploads keep storage | med | low | A bucket lifecycle rule plus a cron abort | `UP-04 abort` | planned |
| UP-05 | T | Type confusion between the declared and the real kind | med | high | The stored type comes from the validated kind, never the name or the client | `UP-05 type` | planned |
| UP-06 | T | Cross-origin writes to the bucket | low | med | CORS allows only the bloop.here origin; checked live | `UP-06 cors` | planned |
| UP-07 | E | Misuse of the S3 credentials | low | high | The R2 token is scoped to the two buckets, Object Read and Write only (an owner setup step) | none | planned |
| UP-08 | T | Tampering with resume state | low | med | Part ETags are read only from D1, never from the client at complete | `UP-08 resume` | planned |
| UP-09 | D | A retry on the same guest code duplicates or wedges a send | med | low | The same fingerprint resumes the same upload | `UP-09 retry` | planned |
| UP-10 | D | A time-left estimate that jumps or counts up, so a person abandons a healthy upload | med | low | The estimate is an EWMA of the bytes moved per second, shown after 5 s, and moves only on a 20 percent change | `UP-10 estimate hysteresis` | mitigated |
| UP-11 | D | A fill that runs backward on a part retry, or stalls at 100 before the file is checked | med | low | The shown fill never decreases and stays under 100 percent until complete answers | `UP-11 fill never moves back on a part retry` | mitigated |

## Refused content
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| DROP-12 | E | Legacy Office files (.ppt, .doc, .xls) with a macro, an object pool or an encrypted storage | med | high | Refuse the file when its compound storage holds a macro, an ObjectPool or encryption | `DROP-12 cfb` | planned |
| DROP-13 | E | A PDF with JavaScript, a Launch action, an embedded file or an open action | med | high | Refuse the file when its structure names any of them | `DROP-13 pdf-active` | planned |
| DROP-14 | E, I | An Office file with an external relationship, or a macro-enabled type | med | high | Refuse any relationship with an external target and the docm, xlsm and pptm content types | `DROP-14 external` | planned |
| DROP-15 | T | Bad magic bytes or brand (webp, gif, heic, webm), or text that is not UTF-8 or is oversize | med | med | Refuse a file whose magic or brand does not match its kind, and text that is not UTF-8 or is over its size cap | `DROP-15 magic` | planned |
