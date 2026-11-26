---
kind: article
order: 5
title: Security
description: How bloop protects your files, where they live, who can see them, what can stay on a PC, and how to report a problem.
published: 2026-11-25
datePending: true
---

bloop puts a file on a shared screen without putting your account there. This page is for the people who use it and the people who look after those screens: how files are stored and shown, where they live, who can see them, what can stay on a PC, and how to reach bloop. The articles explain each part in more depth, starting with [How bloop Works](/articles/how-bloop-works).

## How It Works {#how}

1. **Scan.** The Screen shows a code that works once, for 60 seconds. Your phone scans it and shows three numbers; you tap the one the Screen shows.
2. **Approve.** You choose Items from your Library on your phone and tap Approve. Nothing is typed on the PC.
3. **Show.** bloop's server gives the Screen one short-lived link per approved Item. The Screen never gets your account, your other files, your speaker notes or a way to list them.
4. **End.** You end it from your phone or the Screen, or it ends by itself: after 1 hour unless you change it on your phone, and never later than the limit, 12 hours (2 hours in the Demo). Every link stops working at the end.

## What Works Today {#status}

The one list of what is live. Other pages link here.

Caption: What works today and what is planned

| Feature | Status |
| --- | --- |
| The Demo, with bloop's sample files | Live |
| Accounts by invite, with email codes and passkeys | Live |
| Your Library: upload, rename, Trash, Export, Delete Account | Live |
| PowerPoint, PDF, Word, Excel, text, photos and videos, converted to show in the browser | Live |
| Speaker notes on your phone | Live |
| Pairing a Screen by QR or typed code, approval on the phone | Live |
| Choosing the Session length on your phone | Live |
| Controlling the Screen from your phone (next, previous, present) | Live |
| Guest Files from a phone without an Account | Live |
| Reporting a file from the Screen or the Report page | Live |
| Microsoft OneDrive sign-in and files | Planned |
| Dropbox, Google Drive™, Box | Planned |
| Registered rooms (the phone shows the room's name) | Planned |
| Guest passes required by IT for a room | Planned |
| Access log export for IT teams, turned on per organization on request | Built |

## Where It Runs {#where}

bloop runs on Cloudflare Workers. Its database (D1), your Library and Guest Files (R2), and Session and Library state (Durable Objects) are held in Cloudflare's EU jurisdiction. Files are converted in Cloudflare's EU jurisdiction too. The few things kept outside the EU, such as bloop's own logs and the converter's program image, are listed in [Privacy 8.1](/privacy#8.1). Each request is handled at the nearest Cloudflare data center, so bloop says "stored in the EU", never "UK only". The database can be restored to any minute in the last 30 days; files are never copied into that history, so a file deleted for good is gone. Who processes what, and for how long: [Privacy, Who Helps Run bloop](/privacy#processors) and [How Long bloop Keeps It](/privacy#retention).

## Your Files {#files}

- **Uploads** go straight to storage in the EU over HTTPS, in parts that resume if your connection drops. Each upload link is for one part of one file, and expires after 15 minutes.
- **Checks.** Every file is checked by its bytes, not its name, once it arrives. Files with macros, ActiveX, embedded programs, scripts in a PDF or links to outside content are refused, and a file is never stored as a type other than the one its bytes prove.
- **Conversion.** To show a file in the browser, bloop converts it in an isolated virtual machine with no internet access, destroyed after each job, with a time limit at every step; macros never run. Each output is checked before it is stored.
- **Separate address.** Files reach a Screen from a separate bloop address that sets no cookies and runs no scripts of its own, so a file cannot reach your sign-in.
- **At rest.** Cloudflare encrypts the database and stored files at rest. They are not end-to-end encrypted: bloop's server reads a file to convert and show it.
- **Your Library only.** Every request for a file is checked against its owner, its status and its version at the moment it is fetched, so a deleted, trashed or disabled file stops at once, even on a Screen.

## Who Can See Your Files {#access}

- **You**, on any device where you are signed in.
- **A Screen**, only the Items you approve, only during the Session. Speaker notes go only to your phone.
- **The person who runs bloop** can technically open any file or record bloop stores. bloop's admin tools open a file only after it has been reported, and record every action with its reason. The full rule: [Privacy, Who Can See Your Data](/privacy#access).
- **No one else.** bloop has no other staff, and does not sell or share files.

## Sign-In {#sign-in}

- Accounts are by invite only. An invite is a random 256-bit link, stored only as a hash, bound to one email, single use, and valid for 7 days. Opening the link never uses it up.
- Sign-in uses a 6-digit code sent to your email, valid for 10 minutes and 5 tries, or a passkey. A code is stored only as a keyed hash, and never appears in an email's subject.
- Adding a passkey, changing your email or deleting your Account asks you to confirm again with a fresh code or your passkey; adding a passkey or changing your email also sends a notice to your email.
- Your sign-in is a `__Host-` cookie, replaced at every sign-in, that lasts 30 days unused and 90 days at most. Account lists your sign-ins and live Screens; you can end any one, or sign out everywhere.
- Your email is the way back into your Account, so anyone who controls your mailbox can sign in as you. Protect it with its own multi-factor sign-in.

## Encryption and Links {#encryption}

- HTTPS only, with HSTS for 2 years; bloop.here is on browsers' HTTPS-only list.
- A strict Content Security Policy with Trusted Types on every page, no third-party scripts except Cloudflare's bot check on the sign-in and report pages, and no framing.
- A link to an Item works only during its Session. A link that opens a file dies 10 minutes after it is made if unused and 2 minutes after its first use, and allows at most 10 fetches; a link that shows a picture or converted slides in the page lasts the Session, under its own rate limit. A preview of your own file lasts 5 minutes. bloop stores only a hash of each link.
- Session IDs and pairing secrets are random (128 to 256 bits) and stored only as hashes.
- When OneDrive is live: your Microsoft access is encrypted per user with AES-256-GCM, under a key held outside the database, so a copy of the database alone reveals nothing usable. Access is read-only, and no Microsoft access token lasts more than 1 hour.

## What the PC Holds {#pc}

A Session ID and a link to each approved Item, in the browser's session storage, cleared when the Session ends. While a file is open, PowerPoint holds the copy it opened. Slides shown in the browser are held in the page's memory and its cache for at most 5 minutes. When OneDrive is live, PowerPoint may also get a Microsoft download link for the file, which can work for up to 1 hour.

## What Can Stay Behind {#stay}

A downloaded copy, recent file names and opened tabs with their history can stay until the PC's profile is wiped. No web page can remove them. The Screen says so when a Session ends: "Delete {file} from Downloads before you leave." [What Stays on the PC](/articles/what-stays-on-the-pc) goes through each place.

## Sign-In and Permissions {#permissions}

When OneDrive arrives:

- bloop asks Microsoft for read-only access to OneDrive (`Files.Read`). Microsoft grants that for the whole OneDrive; bloop reads one folder and records every read. Where your tenant allows it, the app folder limits access at Microsoft's side, but then only files in that folder appear.
- **Removing access:** once OneDrive is connected, tap Disconnect OneDrive on any phone while you approve: bloop deletes its stored access and every sign-in ends at once, a lost phone's included. You may also be able to remove bloop in My Apps (myapplications.microsoft.com); your IT team can remove it for everyone in Microsoft Entra. After a removal there, a cached Microsoft token can work until it expires, about an hour.

## Threats bloop Plans For {#threats}

- **QR relay or a sticker over the code:** the phone asks you to pick the number the Screen shows before Approve, and a signed-in phone is checked before a code is spent.
- **Shoulder surfing:** a seen code is already used or soon expires, and the first phone to claim it locks the pairing.
- **Forgotten Session:** it ends by itself when its time runs out.
- **Unwanted content:** a Guest File never opens by itself; someone at the Screen must click Open, and anyone there can press End or Report.
- **A harmful file:** checked by its bytes, converted in an isolated machine with no internet access, and served from a separate address with no cookies.
- **Wrong screen:** unregistered screens carry a warning on the phone.
- **Stolen sign-in or lost phone:** end that sign-in, or sign out everywhere, from Account on any device.

The full threat model, written for IT teams: [Threat Model for IT Teams](/articles/threat-model-for-it-teams).

## If Something Goes Wrong {#incidents}

If a breach puts people's data at risk, bloop tells affected people and organizations without undue delay, and the ICO within 72 hours where the law requires it. The first step for a breach of stored Microsoft access is published: rotate the client secret, which makes every stolen token useless ([how the token store works](/articles/threat-model-for-it-teams#token-store)).

## Report a Problem {#report}

Found a security problem? Thank you; please tell bloop.

- **How:** email <{{email}}> with "Security" in the subject. Do not post it in public. Include what you found, how to reproduce it, and its impact.
- **What happens next:** an acknowledgement within 5 working days, then updates until it is fixed. bloop will credit you if you wish.
- **In scope:** bloop.here and the address bloop serves files from.
- **Out of scope:** Cloudflare, Microsoft, Tally and Apple (report to them); denial of service, spam or social engineering; findings that need a rooted or unlocked device.
- **Rules:** test only with your own Account and the Demo; do not access, change or keep other people's data or files; stop and report once you find a problem; give bloop reasonable time to fix it before you publish.
- **Safe harbor:** bloop will not take legal action against good-faith research that follows this policy.
- To report illegal content rather than a security problem, see [Terms, Reports, Removal and Suspension](/terms#reports).

Machine-readable: [/.well-known/security.txt](/.well-known/security.txt).

## For IT Teams {#it}

If you look after shared PCs and want to know what bloop does on them:

- **Nothing to install.** The Screen is a web page; PowerPoint opens files read-only from a link that expires, and other files show in the browser.
- **The PC gets little.** Never an account, a way to list files, speaker notes, or a way to approve.
- **A record of use.** Every approval, open and end is recorded with who, which Item, which Screen and when (no file contents, tokens or IP addresses). An export for your organization is available on request.
- **Tested.** Each threat bloop mitigates has a named test that runs on every change, including a set of hostile files run through the converter.
- **Questions or a review:** email <{{email}}>. Where data is kept and for how long: [Where It Runs](#where) and [Privacy, How Long bloop Keeps It](/privacy#retention).

## Status {#audit}

No external audit or penetration test yet, and no Cyber Essentials certificate yet. The threat model is written down, and [Threat Model for IT Teams](/articles/threat-model-for-it-teams) explains it. Dates will be added here once each is booked.

## What Changed {#changes}

- Version 2.0, 2026-11-25: Accounts, the Library, conversion, who can see your files, sign-in, and the restore history.
- Version 1.0, 2026-11-25: first published version, before Accounts.
