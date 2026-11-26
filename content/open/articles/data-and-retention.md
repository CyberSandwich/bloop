---
kind: article
order: 4
title: Data and Retention
description: What bloop keeps, where it is stored, how long each kind of data lasts, and who can see it. Written for IT and data protection teams.
published: 2026-11-25
---

A data protection officer asks three questions about any tool: what does it keep, where, and for how long. This article explains how bloop answers them. The [Privacy Notice](/privacy) is the binding text, and it holds every period in one table: [How Long bloop Keeps It](/privacy#retention).

## What bloop Keeps {#keeps}

bloop keeps three kinds of data:

- **A presenter's Library:** the files a signed-in presenter uploads, and the copies bloop makes to show them. They stay until the presenter deletes them.
- **Guest Files:** a file sent from a phone that is not signed in. It is kept only for the session it was sent to.
- **Records:** invites, sign-ins, sessions, reports and usage counts. Each kind is deleted on its own fixed clock.

bloop does not connect to OneDrive or any other file service yet, so it holds nothing from one. The Screen is never given an account; [How bloop Works](/articles/how-bloop-works#gets) says what it gets.

## What a Record Holds {#records}

Every approval, open and end is recorded with who did it, which item, which Screen, and when. A record holds no file contents, no tokens, no links and no IP addresses; an IP address is turned into a keyed hash and the address itself is never stored. A file's name is part of the record, which is why records are deleted on a fixed clock and why a person can ask for theirs to be erased.

An IT team can ask for an export of its organization's records. It is built and turned on per organization on request, and it neutralizes spreadsheet formulas in file names.

## Where It Is Stored {#where}

bloop runs on Cloudflare. Its database, Library files and Guest Files are held in Cloudflare's EU jurisdiction, and files are converted there. Cloudflare is a US company, and each request is handled at the Cloudflare data center nearest the person making it. For that reason bloop says "stored in the EU" and never "UK only".

A few things are kept outside the EU: bloop's own logs, which hold no IP address and no URL, the converter's program image, and what Tally, Apple and Anthropic handle. [The Privacy Notice](/privacy#8.1) keeps the complete list and the legal safeguards.

## A File's Life {#library}

1. **Kept.** A file stays in the Library until its owner deletes it, within the limits in [the Terms](/terms#library).
2. **Trash.** A deleted file goes to the Trash first, where its owner can restore it. When the Trash period ends, or the owner empties it, the file and its copies are deleted for good.
3. **Unused Account.** An Account nobody signs in to gets a warning email, and is deleted unless its owner signs in before the deadline in that email.
4. **Deleted Account.** Deleting an Account takes effect after a short grace period, and signing in before then cancels it. Then bloop deletes the Library and the Account, and sends one email to say it is done. [The Privacy Notice](/privacy#5.4) lists what goes and the little that stays.

Before leaving, a presenter can download every original file and a data file with Export in Account.

## How Deletion Runs {#deletion}

A Guest File has three layers, so one failure does not leave a file behind:

1. It is deleted when the session ends, whether the presenter ends it or its time runs out.
2. An hourly sweep deletes any guest file older than the longest a session can last.
3. A storage rule on the bucket deletes anything left after that, though it can run a little late ([how long](/privacy#retention)).

Records go on a fixed clock: a daily job removes each kind of data when its period ends. The periods are configuration, not code, so changing one means changing a setting, never rewriting the job.

The database keeps a short restore history for recovering from a fault, so a deleted record lingers there until the history rolls past it. Files are never in that history: once a file is deleted for good, it cannot be recovered. [The Privacy Notice](/privacy#5.2) gives the period.

## Who Can See It {#access}

The person who runs bloop can technically open any stored file, because files are encrypted at rest but not end to end: bloop's server must read them to convert and show them. bloop's admin tools open a file's contents only after it has been reported, and record every action with its reason. [The Privacy Notice](/privacy#access) has the full rule.

## Roles {#roles}

Today bloop is the controller of the personal data it holds, run by one named individual. Under an agreement with a university, bloop would act on the university's instructions for staff use and for guest uploads on its rooms. No such agreement exists yet. If you need one, or a data protection impact assessment, write to <{{email}}>.

## Asking for Your Data {#asking}

A presenter can export or delete their own data in Account at any time. Anyone can ask to see, correct, restrict, move or erase their data, or to object, by writing to <{{email}}>. [The Privacy Notice](/privacy#rights) has the full list of rights, the reply time, and how to complain to the ICO.
