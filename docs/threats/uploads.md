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

## Refused content
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| DROP-12 | E | Legacy Office files (.ppt, .doc, .xls) with a macro, an object pool or an encrypted storage | med | high | Refuse the file when its compound storage holds a macro, an ObjectPool or encryption, and when its kind's document stream (`WordDocument`, `Workbook` or `Book`, `PowerPoint Document`) is missing or is a storage, not a stream | `DROP-12 cfb` | mitigated |
| DROP-13 | E | A PDF that runs a script, starts a program, submits or imports data, plays rich media or jumps to another file, or carries an embedded file, an XFA form or encryption | med | high | A name-token scan of the file and of every object stream refuses the action types, not the keys that hold them: `/JS`, `/JavaScript`, `/Launch`, `/SubmitForm`, `/ImportData`, `/RichMedia`, `/GoToR` and `/GoToE` wherever they appear, inside `/OpenAction` and `/AA` included (a GoToR always names another file; a GoToE's target is another file or an embedded one), and `/EmbeddedFile`, `/EmbeddedFiles` and `/XFA` (`macro_content`); `/Encrypt` is `encrypted`. An `/OpenAction` or `/AA` that holds only a GoTo or a destination passes (LaTeX hyperref and the PowerPoint, Word, Keynote, Google Slides and Acrobat exports write them), and so does any other action (a URI link, a named page action). An object stream not in the plain Flate form, over 8 MiB, or past 4,096 per file, and an `/ObjStm` token outside every object stream read, is `bad_structure`. The chunked and the whole-file scan give the same verdict. Residual: stream payloads (content, XFA XML, embedded bytes) are not parsed, and a name in a string or comment refuses the file (fail closed) | `DROP-13 pdf-active` (unit: a producer corpus passes, each dangerous action refused, the chunked and whole scans agree over the corpus and random mutations) | mitigated |
| DROP-14 | E, I | An Office file with an external relationship, or a macro-enabled type | med | high | Refuse any relationship with an external target and the docm, xlsm and pptm content types | `DROP-14 external` | mitigated |
| DROP-15 | T | Bad magic bytes or brand (webp, gif, heic, webm), or text that is not UTF-8 or is oversize | med | med | Refuse a file whose magic or brand does not match its kind, and text that is not UTF-8 or is over its size cap | `DROP-15 magic` | mitigated |
| DROP-16 | D | An image with a huge pixel size (a decompression bomb) that takes down the room screen's tab | low | med | The size in the image's own header (PNG, JPEG, GIF, WebP; a GIF's logical screen and its first frame both) is at most 100 megapixels; a missing or zero size is `bad_structure`, one over the cap is `too_large`; HEIC dimensions are the converter's limits | `DROP-16 pixels` | mitigated |
