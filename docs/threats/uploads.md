# Threats: uploads and refused content

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: U (uploads). For the DROP rows the threat is the content a check refuses and the mitigation is the refusal.

## Uploads
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| UP-01 | E | A presigned URL broader than one part | low | high | Each URL is one part, one key, PUT only, and short-lived | `UP-01 scope` | planned |
| UP-02 | D | Oversize upload or a part count beyond the bound | med | med | The declared size must equal the head size at complete; the part count is bounded | `UP-02 size` | mitigated |
| UP-03 | E | Using another user's upload id | med | high | Every upload route checks the owner; another member's id is the same `not_found` as an unknown one | `UP-03 owner` | mitigated |
| UP-04 | D | Stale multipart uploads keep storage | med | low | A bucket lifecycle rule plus an hourly sweep that aborts expired and crashed uploads | `UP-04 abort` | mitigated |
| UP-05 | T | Type confusion between the declared and the real kind | med | high | The stored type comes from the validated kind, never the name or the client | `UP-05 type` | mitigated |
| UP-06 | T | Cross-origin writes to the bucket | low | med | CORS allows only the bloop.here origin; checked live | `UP-06 cors` | planned |
| UP-07 | E | Misuse of the S3 credentials | low | high | The R2 token is scoped to the two buckets, Object Read and Write only (an owner setup step) | none | planned |
| UP-08 | T | Tampering with resume state | low | med | The part list is read only from D1; the one ETag a client may send (the last part's, on complete) must match R2's join or the upload is released | `UP-08 resume` | mitigated |
| UP-09 | D | A retry on the same guest code duplicates or wedges a send | med | low | The same fingerprint resumes the same upload | `UP-09 retry` | planned |

## Refused content
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| DROP-12 | E | Legacy Office files (.ppt, .doc, .xls) with a macro, an object pool or an encrypted storage | med | high | Refuse the file when its compound storage holds a macro, an ObjectPool or encryption | `DROP-12 cfb` | mitigated |
| DROP-13 | E | A PDF with JavaScript, a Launch action, an embedded file or an open action | med | high | Refuse the file when its structure names any of them | `DROP-13 pdf-active` | mitigated |
| DROP-14 | E, I | An Office file with an external relationship, or a macro-enabled type | med | high | Refuse any relationship with an external target and the docm, xlsm and pptm content types | `DROP-14 external` | mitigated |
| DROP-15 | T | Bad magic bytes or brand (webp, gif, heic, webm), or text that is not UTF-8 or is oversize | med | med | Refuse a file whose magic or brand does not match its kind, and text that is not UTF-8 or is over its size cap | `DROP-15 magic` | mitigated |
| DROP-16 | D | An image with a huge pixel size (a decompression bomb) that takes down the room screen's tab | low | med | The size in the image's own header (PNG, JPEG, GIF, WebP) is at most 100 megapixels; a missing or zero size is `bad_structure`, one over the cap is `too_large`; HEIC dimensions are the converter's limits | `DROP-16 pixels` | mitigated |
