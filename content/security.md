---
kind: legal
order: 3
title: Security
description: What bloop holds, where it runs, what can stay on a PC, and how to report a problem.
panel: true
effective: 2026-11-25
version: 1.0
---

bloop puts a file on a shared screen without putting your account there. This page is for the people who look after those screens: what bloop holds, where it runs, what can stay on a PC, and how to reach us. The articles explain each part in more depth, starting with [How bloop Works](/articles/how-bloop-works).

## How It Works {#how}

1. **Scan.** The Screen shows a code that works once, for 60 seconds. Your phone scans it and shows the room and a number to match.
2. **Approve.** You choose Items on your phone and tap Approve. Nothing is typed on the PC.
3. **Show.** bloop's server gives the Screen one short-lived link per approved Item. The Screen never gets your account, your other files or a way to list them.
4. **End.** You end it from your phone or the Screen, or it ends by itself: after 1 hour unless you change it on your phone, and never later than the limit, 12 hours (2 hours in the Demo). Every link stops working at the end.

## What Works Today {#status}

The one list of what is live. Other pages link here.

Caption: What works today and what is planned

| Feature | Status |
| --- | --- |
| The Demo, with bloop's sample files | Live |
| Pairing a Screen by QR or typed code, approval on the phone | Live |
| Choosing the Session length on your phone | Live |
| Guest Files from a phone: PowerPoint and PDF | Live |
| Guest photos (JPEG, PNG) and videos (MP4, MOV), cleaned on the phone | Live |
| Microsoft OneDrive sign-in and files | Planned |
| Dropbox, Google Drive™, Box | Planned |
| Registered rooms (the phone shows the room's name) | Planned |
| Guest passes required by IT for a room | Planned |
| Access log export for IT teams, turned on per organization on request | Built |

## Where It Runs {#where}

bloop runs on Cloudflare Workers. Its database (D1) and Guest File storage (R2) are held in Cloudflare's EU jurisdiction, and Session state lives in Durable Objects in the same jurisdiction. Each request is handled at the nearest Cloudflare data center, so bloop says "stored in the EU", never "UK only". Who processes what, and for how long: [Privacy, Who Helps Run bloop](/privacy#processors) and [How Long bloop Keeps It](/privacy#retention).

## Encryption and Links {#encryption}

- HTTPS only, with HSTS for 2 years; bloop.here is on browsers' HTTPS-only list.
- A strict Content Security Policy with Trusted Types on every page, no third-party scripts, and no framing.
- A link to an Item works only during its Session. A link that opens a file dies 10 minutes after it is made if unused and 2 minutes after its first use, and allows at most 10 fetches; a link that shows a picture in the page lasts the Session, under its own rate limit. bloop stores only a hash of each link.
- Session IDs and pairing secrets are random (128 to 256 bits) and stored only as hashes.
- When OneDrive is live: your Microsoft access is encrypted per user with AES-256-GCM, under a key held outside the database, so a copy of the database alone reveals nothing usable. Access is read-only, and no Microsoft access token lasts more than 1 hour.
- Guest Files are checked by their bytes, not their names. Decks with macros, ActiveX or embedded programs are refused. A file is sent with a fixed type and a strict content policy.

## What the PC Holds {#pc}

A Session ID and a link to each approved Item, in the browser's session storage, cleared when the Session ends. While a file is open, PowerPoint holds the copy it opened. When OneDrive is live, PowerPoint may also get a Microsoft download link for the file, which can work for up to 1 hour.

## What Can Stay Behind {#stay}

A downloaded copy, recent file names and opened tabs with their history can stay until the PC's profile is wiped. No web page can remove them. The Screen says so when a Session ends: "Delete {file} from Downloads before you leave." [What Stays on the PC](/articles/what-stays-on-the-pc) goes through each place.

## Sign-In and Permissions {#permissions}

When OneDrive arrives:

- bloop asks Microsoft for read-only access to OneDrive (`Files.Read`). Microsoft grants that for the whole OneDrive; bloop reads one folder and records every read. Where your tenant allows it, the app folder limits access at Microsoft's side, but then only files in that folder appear.
- **Removing access:** once OneDrive is connected, tap Disconnect OneDrive on any phone while you approve: bloop deletes its stored access and every sign-in ends at once, a lost phone's included. You may also be able to remove bloop in My Apps (myapplications.microsoft.com); your IT team can remove it for everyone in Microsoft Entra. After a removal there, a cached Microsoft token can work until it expires, about an hour.

## Threats bloop Plans For {#threats}

- **QR relay or a sticker over the code:** the phone shows a number to match against the Screen before Approve.
- **Shoulder surfing:** a seen code is already used or soon expires, and the first phone to claim it locks the pairing.
- **Forgotten Session:** it ends by itself when its time runs out.
- **Unwanted content:** a Guest File never opens by itself; someone at the Screen must click Open.
- **Wrong screen:** unregistered screens carry a warning on the phone.
- **Lost phone:** see [Sign-In and Permissions](#permissions).

The full threat model, written for IT teams: [Threat Model for IT Teams](/articles/threat-model-for-it-teams).

## If Something Goes Wrong {#incidents}

If a breach puts people's data at risk, bloop tells affected people and organizations without undue delay, and the ICO within 72 hours where the law requires it. The first step for a breach of stored Microsoft access is published: rotate the client secret, which makes every stolen token useless ([how the token store works](/articles/threat-model-for-it-teams#token-store)).

## Report a Problem {#report}

Found a security problem? Thank you; please tell us.

- **How:** email <security@bloop.here>. Do not post it in public. Include what you found, how to reproduce it, and its impact.
- **What happens next:** an acknowledgement within 5 working days, then updates until it is fixed. bloop will credit you if you wish.
- **In scope:** bloop.here.
- **Out of scope:** Cloudflare, Microsoft, Tally and Apple (report to them); denial of service, spam or social engineering; findings that need a rooted or unlocked device.
- **Rules:** test only with your own accounts and the Demo; do not access, change or keep other people's data; stop and report once you find a problem; give bloop reasonable time to fix it before you publish.
- **Safe harbor:** bloop will not take legal action against good-faith research that follows this policy.
- To report unlawful content rather than a security problem, see [Terms, Guest Files](/terms#guest-files).

Machine-readable: [/.well-known/security.txt](/.well-known/security.txt).

## For IT Teams {#it}

If you look after shared PCs and want to know what bloop does on them:

- **Nothing to install.** The Screen is a web page; PowerPoint opens files read-only from a link that expires.
- **The PC gets little.** Never an account, a way to list files, or a way to approve.
- **A record of use.** Every approval, open and end is recorded with who, which Item, which Screen and when (no file contents, tokens or IP addresses). An export for your organization is available on request.
- **Open source.** The code is public, and each mitigated threat has a named test that runs on every change.
- **Questions or a review:** email <hi@bloop.here>. Where data is kept and for how long: [Where It Runs](#where) and [Privacy, How Long bloop Keeps It](/privacy#retention).

## Status {#audit}

No external audit or penetration test yet, and no Cyber Essentials certificate yet. The threat model is public, and [Threat Model for IT Teams](/articles/threat-model-for-it-teams) explains it. Dates will be added here once each is booked.
