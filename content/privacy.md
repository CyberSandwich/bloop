---
kind: legal
order: 1
title: Privacy Notice
description: What bloop collects, why, how long it keeps it, and your rights.
numbered: true
panel: true
binds: this notice
summaryNote: This summary helps you read; the full text applies.
effective: 2026-11-25
version: 1.0
---

bloop is a new, free side project run by one person in the UK. It keeps only what it needs to put your file on the screen, and deletes a guest's file when the session ends. It never sells data and runs no ads, analytics scripts or trackers. Write to <{{email}}> about anything here.

## Who Is Responsible {#controller}

In short: one named person runs bloop and answers for your data.

1.1 bloop is run by **Duke DJ Saputra**, an individual based in the United Kingdom (**"bloop"**, **"we"**), as a free side project in early access; it is not a commercial service. bloop is the **controller** of the personal data described here: it decides why and how that data is used.

1.2 Contact: <{{email}}>. A postal address is available on request to that address.

1.3 bloop has no data protection officer; none is required. Write to <{{email}}>.

1.4 Words used here: **Screen** means a browser showing bloop's page on a shared display, such as a room PC. **Session** means the time from Approve on your phone until it ends. **Item** means a file or link you approve for a Screen. **Guest File** means a file sent from a phone that is not signed in to a file service. **Demo** means the public sample at bloop.here, which uses a bundled sample account.

## What Works Today {#status}

In short: some of what is described here is not live yet, and each part says which.

2.1 bloop is in early access. Rows below marked **Planned** describe data bloop will handle only once that feature is live. The current list of what is live is on [the Security page](/security#status).

2.2 Today bloop does not connect to Microsoft OneDrive or any other file service. Screens show bloop's sample files and Guest Files.

## What bloop Collects {#data}

In short: little, and never the content of your OneDrive.

3.1 The table lists each kind of personal data, where it comes from, and its status.

Caption: What bloop collects, where it comes from, and its status

| Data | From | Status |
| --- | --- | --- |
| A Guest File (its bytes, name, type and size) | the person who sends it | Live |
| A record of each Session: which Item, on which Screen, when, and how it ended | bloop's own records of what you do | Live |
| A keyed hash of your IP address, used to stop abuse (bloop never stores the address itself) | your browser's connection | Live |
| Usage counts with no names or file names | bloop's own records | Live |
| Emails you send to <{{email}}>, and bloop's replies | you | Live |
| Waitlist answers: your role, where you would use bloop, your organization, what you would like next, your timing and your email, plus the page you came from | you, through the Tally form | Live |
| Your work email and Microsoft account ID (tenant and object ID); never your name | Microsoft, when you sign in and allow access | Planned |
| Your OneDrive access, encrypted, and the ID of the folder bloop reads | Microsoft, when you sign in and allow access | Planned |
| Phone sign-in, as a random value stored only as a hash | bloop | Planned |
| A pseudonym (a keyed hash of your account ID) counting weekly active users | bloop | Planned |

3.2 bloop never stores the content of files from your OneDrive. It fetches a file only when you approve it, and passes it to the Screen. A Guest File is the one exception, and it is deleted when the Session ends ([section 5](#retention)).

3.3 bloop does not use your data for automated decisions about you, and does not build profiles.

3.4 Photos sent as a Guest File are re-encoded on your phone before they leave it, which removes their location and other metadata. Videos have their location fields cleared on your phone. Some cameras also write location in other places, such as an XMP block or a GPS track, which bloop does not clear; send a video you are content to show.

## Why bloop Uses It {#basis}

In short: to run the Session you start, keep it safe, and answer you.

4.1 Each purpose and its **lawful basis** under the UK GDPR:

Caption: Each purpose, the data it uses, and its lawful basis

| Purpose | Data | Lawful basis |
| --- | --- | --- |
| Put the Items you approve on the Screen you choose | Session records, Guest Files, OneDrive access (Planned) | Contract: providing the service you ask for |
| Show a Guest File on the Screen its sender chose | the Guest File | Legitimate interests: showing the file the sender picked, for the time they picked |
| Stop abuse and keep the service safe | IP hash, Session records | Legitimate interests: security and fraud prevention |
| Give your organization's IT team a record of what was opened where | Session records | Legitimate interests: accountability on shared machines; under an agreement with your organization, bloop acts on its instructions instead |
| Count use, with no names, to improve bloop | usage counts, weekly pseudonyms (Planned) | Legitimate interests: improving the service |
| Invite you to early access and arrange a call | waitlist answers | Consent, which you can withdraw at any time |
| Answer your emails | your emails | Legitimate interests: replying to you |

4.2 **You have the right to object** at any time to any use based on legitimate interests. Write to <{{email}}> and bloop will stop unless it has compelling grounds that override your interests, or needs the data for a legal claim.

## How Long bloop Keeps It {#retention}

In short: a guest's file goes when the Session ends; records go on a fixed clock.

5.1 A daily job deletes data when its period ends. [Data and Retention](/articles/data-and-retention) explains each period.

Caption: How long bloop keeps each kind of data

| Data | Kept |
| --- | --- |
| A Guest File's bytes | Deleted when its Session ends. Backstops: an hourly check, and a storage rule that deletes any guest file after 1 day |
| A Guest File's record (name, type, size, times) | 30 days after the file is deleted |
| Session and access records | 180 days. In the Demo, 7 days |
| Usage counts | 90 days, then only daily totals, for 2 years |
| Weekly pseudonyms (Planned) | 120 days |
| Codes, pairing secrets and links for a Session | Until the Session ends, is canceled or times out |
| IP hash for abuse limits | 10 minutes for failed code attempts; until the Session ends for the Screen's own check |
| Your OneDrive access (Planned) | Until you tap Disconnect OneDrive (deleted at once), remove bloop in My Apps or Microsoft Entra (deleted the next time it fails), ask for erasure, or 30 days unused |
| Phone sign-in (Planned) | 30 days unused, 90 days at most |
| Your account record (Planned) | While you have OneDrive access or a phone sign-in, then 30 days |
| Guest passes (Planned) | 24 hours |
| Cloudflare's request logs | At most 7 days, with no personal data |
| Waitlist answers | Until you ask bloop to delete them, or the waitlist closes |
| Emails to <{{email}}> | 2 years after the last message in a thread |

## Who Helps Run bloop {#processors}

In short: three companies process data for bloop, and none may use it for themselves.

6.1 These **processors** handle personal data only on bloop's instructions, under written terms:

Caption: The processors, what each does, the data it handles and where

| Processor | What it does | Data | Where |
| --- | --- | --- | --- |
| Cloudflare, Inc. (US) | Hosting, database, file storage, network, DNS | Everything in section 3 except waitlist answers and email | Stored in Cloudflare's EU jurisdiction; each request is handled at the nearest Cloudflare data center |
| Tally BV (Belgium) | The waitlist form | Waitlist answers | EU; Tally uses its own subprocessors, some in the US |
| Apple (iCloud Mail) | The mailbox behind <{{email}}> | Emails you send and bloop's replies | Apple's data centers, in the US and elsewhere |

6.2 **Microsoft is not a processor for bloop.** When OneDrive is live, Microsoft is where your files and sign-in come from, and it controls your Microsoft account under its own terms and your organization's.

6.3 bloop does not sell personal data, and shares it with no one else except where the law requires it.

## Where Data Is Stored {#transfers}

In short: stored in the EU, run by a US company, with legal safeguards.

7.1 bloop's database and Guest Files are stored in the EU. bloop never claims "UK only": Cloudflare is a US company, and a request is handled at the Cloudflare data center nearest the person making it.

7.2 Where data goes outside the UK, the safeguards are the UK's adequacy regulations for the EU, and for the US the EU Standard Contractual Clauses with the UK Addendum in Cloudflare's data processing terms. Tally's and Apple's transfers follow their own published terms.

## Cookies and Storage {#storage}

In short: only what the service needs to work; no banner, because nothing tracks you.

8.1 bloop runs no analytics scripts, no ads and no tracking. Everything below is strictly necessary for a feature you use, so no consent banner is needed.

Caption: What bloop stores in your browser, why, for how long, and its status

| Name | Kind | Why | How long | Status |
| --- | --- | --- | --- | --- |
| `bloop.pid` | phone, local storage | Lets your phone end or control the Session after you close the tab | Until the Session ends | Live |
| `bloop.sid` | Screen, session storage | Keeps the Screen in its Session on reload | Until the Session ends or the tab closes | Live |
| `__Host-bloop_sid` | phone, cookie | Keeps you signed in on your phone | 30 days unused, 90 days at most | Planned |
| `__Host-bloop_oauth` | phone, cookie | Protects the Microsoft sign-in step | 10 minutes | Planned |
| `__Host-bloop_room` | Screen, cookie | Shows a registered room's name | Set by the room's IT team | Planned |

8.2 The waitlist form is on tally.so and follows Tally's own cookie policy.

## Your Rights {#rights}

In short: ask to see, fix, move or delete your data; bloop answers within a month.

9.1 You have the right to:

1. get a copy of your data (access);
2. have it corrected;
3. have it erased;
4. restrict how it is used;
5. receive it in a portable format;
6. object, as in [4.2](#4.2);
7. withdraw consent to the waitlist at any time, without affecting what came before.

9.2 Write to <{{email}}>. bloop replies within one month, and may ask you to prove who you are first. In some cases the law allows a longer time or a refusal; bloop will say why.

9.3 Once OneDrive is connected, tap Disconnect OneDrive on any phone while you approve: bloop deletes its stored access and every sign-in ends at once, a lost phone's included. You may also be able to remove bloop in My Apps (myapplications.microsoft.com); your IT team can remove it for everyone in Microsoft Entra.

## How to Complain {#complain}

In short: tell bloop first; you can always go to the ICO.

10.1 To complain about how bloop uses your data, write to <{{email}}> with "Complaint" in the subject. bloop acknowledges a complaint within 30 days, looks into it without undue delay, and tells you the outcome.

10.2 You may also complain to the **Information Commissioner's Office (ICO)**, the UK regulator, at any time, at [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint/), which lists its helpline and postal address. The ICO usually expects you to raise it with bloop first.

## Children {#children}

In short: bloop is for work and study, and not for children under 13.

11.1 bloop is made for staff and students at universities, schools and workplaces. It is not meant for children under 13, and bloop does not knowingly collect their data. A Guest File, from anyone, is deleted when its Session ends.

## Changes to This Notice {#changes}

In short: changes are dated and listed here.

12.1 bloop will post any change here with a new version and date. For a material change, bloop will email people on the waitlist and, once sign-in is live, signed-in users, before it takes effect.

### What Changed

- Version 1.0, 2026-11-25: first published version.
- Earlier versions were shown for review before this one; they are replaced and never took effect.
