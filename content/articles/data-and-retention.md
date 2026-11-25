---
kind: article
order: 4
title: Data and Retention
description: What bloop keeps, where it is stored, how long each kind of data lasts, and who can see it. Written for IT and data protection teams.
published: 2026-11-25
---

A data protection officer asks three questions about any tool: what does it keep, where, and for how long. This article answers them for bloop in one place. The [Privacy Notice](/privacy) is the binding text; this is the reader-facing explanation.

## What bloop Keeps {#keeps}

bloop keeps little, and never the content of a presenter's OneDrive. The table covers what is live today. Anything that arrives with OneDrive sign-in is listed in the Privacy Notice as planned.

Caption: What bloop keeps, where, and for how long

| Data | Where | Kept |
| --- | --- | --- |
| A Guest File's bytes | Cloudflare R2, EU | Deleted when its session ends. A storage rule deletes any guest file after 1 day |
| A Guest File's record: name, type, size, times | Cloudflare D1, EU | 30 days after the file is deleted |
| Session and access records | Cloudflare D1, EU | 180 days. In the Demo, 7 days |
| Usage counts, with no names | Cloudflare D1, EU | 90 days, then daily totals for 2 years |
| Codes, links and pairing secrets | The Screen's own Durable Object, EU | Until the session ends, is canceled or times out |
| Failed code attempts, as a hash of the address | Cloudflare Durable Object, EU | 10 minutes |
| Cloudflare's request logs | Cloudflare | Off on the live site. If they are turned on, they record each request's details, including your IP address, and keep them at most 7 days |
| Waitlist answers | Tally | Until you ask for deletion, or the waitlist closes |
| Emails to <{{email}}> | Apple iCloud Mail | 2 years after the last message in a thread |

## What a Record Holds {#records}

Every approval, open and end is recorded with who did it, which item, which Screen, and when. A record holds no file contents, no tokens, no links and no IP addresses; an IP address is turned into a keyed hash and the address itself is never stored. A file's name is part of the record, which is why records are deleted on a fixed clock and why a person can ask for theirs to be erased.

An IT team can ask for an export of its organization's records. It is built and turned on per organization on request, and it neutralizes spreadsheet formulas in file names.

## Where It Is Stored {#where}

bloop runs on Cloudflare. Its database and guest file storage are held in Cloudflare's EU jurisdiction, and session state lives in Durable Objects in the same jurisdiction. Cloudflare is a US company, and each request is handled at the Cloudflare data center nearest the person making it. For that reason bloop says "stored in the EU" and never "UK only".

## How Deletion Runs {#deletion}

A guest file has three layers, so one failure does not leave a file behind:

1. It is deleted when the session ends, whether the presenter ends it or its time runs out.
2. An hourly sweep deletes any file older than the longest a session can last (12 hours live).
3. A storage rule on the bucket deletes anything older than 1 day.

Records go on a fixed clock: a daily job removes each kind of data when its period ends. The periods are configuration, not code, so changing one means changing a setting, never rewriting the job.

## Roles {#roles}

Today bloop is the controller of the personal data it holds, run by one named individual. Under an agreement with a university, bloop would act on the university's instructions for staff use and for guest uploads on its rooms. No such agreement exists yet. If you need one, or a data protection impact assessment, write to <{{email}}>.

## Asking for Your Data {#asking}

A person can ask to see, correct, restrict, move or erase their data, or to object, by writing to <{{email}}>. bloop replies within one month. The [Privacy Notice](/privacy#rights) has the full list of rights and how to complain to the ICO.
