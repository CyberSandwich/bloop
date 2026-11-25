---
kind: article
order: 1
title: How bloop Works
description: How a phone pairs with a shared screen, what the screen is given, and how a session ends. Written for IT teams and lecturers.
published: 2026-11-25
---

bloop lets a lecturer put a file on a shared PC without signing in to their own account there. This article follows one session from the first scan to the last link, and says what the room PC holds at each step.

## The Problem It Solves {#problem}

A room PC is used by many people in a day. Signing in to your own account there leaves traces: a cached sign-in, recent file names, a downloaded copy. Plugging in a USB stick moves the risk to the stick. Either way the presenter makes a trade between convenience and leaving something behind.

bloop moves the choosing to the presenter's phone. The PC shows a web page, and the phone decides what the page may show. The PC never holds the presenter's account.

## Four Steps {#steps}

1. **Scan.** The room PC opens bloop's Screen page, which shows a QR code and a short typed code. A code works once and lasts 60 seconds. The phone scans it, or the presenter types it, and the phone shows a two-digit number to match against the Screen.
2. **Approve.** The presenter chooses the files to show and taps Approve. Nothing is typed on the PC.
3. **Show.** bloop's server gives the Screen one short-lived link for each approved file. The Screen opens it; on a PC with PowerPoint installed, a deck opens in PowerPoint, read-only.
4. **End.** The presenter ends the session from the phone, or someone ends it at the Screen, or it ends by itself. Every link stops working at that moment.

## What the Screen Gets {#gets}

The Screen gets the files you approve, each as a link, and nothing else. It never gets your account, your other files, or any way to list them. It cannot approve anything: only the phone that first claimed the code can.

A link is made for one file in one session. It dies 10 minutes after it is made if nobody uses it, and 2 minutes after its first use, and it allows at most 10 fetches. A link that shows a picture or plays a video inside the page lasts as long as the session, under its own rate limit. bloop stores only a hash of each link, so a copy of its records cannot be turned back into a working link.

## Matching the Right Screen {#match}

The first phone to claim a code locks the pairing, so a code photographed from the back of the room is already used by the time anyone tries it. The match number is a check for a person: it catches a QR sticker placed over a real screen, or a phone pointed at the wrong room. It is one in a hundred and it is not a secret. [The Threat Model for IT Teams](/articles/threat-model-for-it-teams) says exactly what it does and does not defend.

## Guest Files {#guest}

A presenter who is not signed in to a file service can send a file straight from the phone as a Guest File: a PowerPoint deck, a PDF, a photo (JPEG or PNG) or a video (MP4 or MOV).

- Each file is checked by its bytes, not its name. A deck with macros, ActiveX or embedded programs is refused.
- A photo is re-encoded on the phone before it leaves, which removes its location and other metadata. A video has its location fields cleared on the phone.
- A Guest File never opens by itself. Someone at the Screen must click Open, which proves a person is standing there.
- bloop deletes the file when the session ends.

## How a Session Ends {#ending}

Every session starts at 1 hour. The presenter can change that on the phone, up to 12 hours (2 hours in the public Demo). The end is an absolute time kept on the server, so a forgotten session still ends, and a burst of changes cannot stretch it past the limit. When it ends, bloop drops the links, the pairing secrets and any guest file. [What Stays on the PC](/articles/what-stays-on-the-pc) covers what a web page cannot reach.

## What Works Today {#today}

The Demo, pairing by QR or typed code, choosing the session length, and Guest Files (PowerPoint, PDF, photos and videos) are live. Signing in to Microsoft OneDrive and other file services is planned and is not live yet. The [Security page](/security#status) keeps the one current list.
