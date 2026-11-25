---
kind: article
order: 2
title: Threat Model for IT Teams
description: What could go wrong with bloop on a shared PC, what stops it, what is accepted, and what is still open. Written for IT and security teams.
published: 2026-11-25
---

A threat model is a list of what could go wrong and what is done about it. bloop's is written down and kept next to its code. This article restates it for the people who decide whether a tool may run in their rooms: it says what is protected, how, and where the protection stops.

## How to Read It {#method}

The model goes seam by seam: signing in, pairing, the file source, opening a file, guest uploads, what stays on the PC, the website, personal data, and a hostile lectern PC. Each threat has a name such as PAIR-03, how likely it is, how bad, what stops it, and a test.

Each row ends in one of three states:

- **Mitigated:** the design stops it, and a named test proves it. The check that runs on every change fails if a mitigated row has no test.
- **Residual:** a defense exists, but some risk is accepted, and the row says which.
- **Open:** it waits on a test on real equipment or on a decision by the owner.

## What Needs Protecting {#assets}

In order of value:

1. Microsoft sign-in tokens that could read a whole OneDrive. These exist only once OneDrive is live, which is planned and not live yet.
2. The files a presenter approves.
3. The right to put content on a room screen.
4. The record of who opened what, where and when.
5. Guest uploads.
6. Availability.

## Pairing and the Screen {#pairing}

- **Replay and shoulder surfing.** A code works once and lasts 60 seconds. The first phone to claim it locks the pairing, and the real presenter's phone then says the code was already used. An attacker who wins the race can put their own file on that screen, which is recorded, but cannot read the presenter's files.
- **A fake screen or a sticker over the QR.** The phone shows a number to match, and a real screen shows the same one. A sticker or poster QR is caught about 99 percent of the time. The number is a check for a person, not a secret: it does not stop a live relay, or an attacker who controls the screen in front of the victim. Rooms that are not registered carry a warning on the phone, and the prize is one file the presenter picked, with a link that dies when the session ends.
- **Guessing a typed code.** A code is 6 characters from an alphabet of 30, about 730 million possibilities. Each address gets 10 misses per 10 minutes, counted exactly, and 20 claims per minute.
- **Forged requests.** No ambient authority: the phone's credentials travel in a header from storage a cross-site page cannot read, the request origin must match bloop's, and a plain form post is refused.
- **Forgetting.** Every session ends by itself, 1 hour by default and never beyond the cap.

## Files and Links {#files}

- **Links.** A link names one file and dies when the session ends, 10 minutes after it is made if unused, and 2 minutes after first use. It allows at most 10 fetches. The query string is ignored and responses are not cached. Only a hash of the link is stored. A leaked link is dead long before the next person sits down.
- **A file that is something else.** Guest Files are identified by their bytes. A deck must be a real Office package with no PDF header; a PDF must not end as a ZIP; a photo or video must be what its name says. Mismatches are refused, and the served type comes from detection, never the name.
- **Active content.** Decks with macros, ActiveX or embedded programs are refused. Opened on the PC, a file is under Office's own protections as well.
- **Serving.** A file is sent with a fixed type, no sniffing, and a content policy that forbids scripts. A photo or video viewed on its own link is sandboxed.
- **Decompression bombs.** The server inflates one small part of a deck and caps the entry count and ratios. A deck that lies about its sizes could still stall PowerPoint on one PC for one session, and that is accepted.
- **Unwanted content.** Anyone who can scan a code could send a file to that screen. A Guest File waits for an Open click at the Screen, which proves someone is there.

## The Token Store {#token-store}

This part describes OneDrive sign-in, which is planned. Each user's Microsoft access is encrypted with its own AES-256-GCM key, wrapped by a key held outside the database, so a copy of the database alone yields ciphertext. The app is a confidential client, so a stolen token cannot be redeemed without the app's secret; the first step in a breach is to rotate that secret, which strands every stolen token. Access is read-only. No access token lasts more than 1 hour, and access unused for 30 days is deleted. The model states the limit plainly: someone who controls both the Cloudflare account and the deploy holds both the ciphertext and the key, and envelope encryption does not defend against that.

Tapping Disconnect OneDrive on a phone deletes the stored access and every sign-in at once. Removing the app in Microsoft Entra leaves a cached Microsoft token that can work until it expires, about an hour; the pages say so rather than promise more.

## The Lectern PC {#lectern}

Malware on the PC could copy a file it is shown. That is true of any presenting method, a USB stick included, and bloop limits it to one file at a time. The Screen's own credential cannot list files, choose files, or make links beyond the approved ones: at most 6 links per file, and every one is recorded. Links die at the end, and the phone's End revokes everything on the server, so the end never depends on the PC.

## What Remains Open {#open}

- A stolen phone that is already unlocked is out of scope.
- Whether PowerPoint, fetching a link, and the browser leave through the same network address is a field question, so link binding to an address is logged rather than enforced by default.
- What remains on a real PC after sign-out and reboot has not been measured on real lecterns. [What Stays on the PC](/articles/what-stays-on-the-pc) says what is known.
- There is no external audit or penetration test yet, and no Cyber Essentials certificate yet. The [Security page](/security#audit) will carry the dates once they are booked.

## Checking It Yourself {#verify}

Every mitigated threat has a test with its id in the name, and the checks run on every change to the code. For a walkthrough of the current model, or a questionnaire your team already uses, write to <hi@bloop.here>.
