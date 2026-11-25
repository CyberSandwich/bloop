---
kind: legal
order: 1
title: Privacy Notice
description: What bloop collects, why, how long it keeps it, who can see it, and your rights.
numbered: true
panel: true
binds: this notice
summaryNote: This summary helps you read; the full text applies.
effective: 2026-11-25
version: 2.0
---

bloop is a new, free side project run by one person in the UK. If you have an account, bloop stores your files in the EU until you delete them, and deletes a guest's file when the session ends. It never sells data and runs no ads, analytics scripts or trackers. How your files are protected is on [the Security page](/security). Write to <{{email}}> about anything here.

## Who Is Responsible {#controller}

In short: one named person runs bloop and answers for your data.

1.1 bloop is run by **Duke DJ Saputra**, an individual based in the United Kingdom (**"bloop"**), as a free side project in early access; it is not a commercial service. bloop is the **controller** of the personal data described here: it decides why and how that data is used.

1.2 Contact: <{{email}}>. A postal address is available on request to that address.

1.3 bloop has no data protection officer; none is required. Write to <{{email}}>.

1.4 Words used here: **Account** means a bloop account, opened from an invite. **Library** means the files stored in your Account. **Screen** means a browser showing bloop's page on a shared display, such as a room PC. **Session** means the time from Approve on your phone until it ends. **Item** means a file or link you approve for a Screen. **Guest File** means a file sent from a phone that is not signed in. **Demo** means the public sample at bloop.here, which uses bloop's own sample files.

## What Works Today {#status}

In short: some of what is described here is not live yet, and each part says which.

2.1 bloop is in early access, and Accounts are by invite only. Rows below marked **Planned** describe data bloop will handle only once that feature is live. The current list of what is live is on [the Security page](/security#status).

2.2 bloop does not connect to Microsoft OneDrive or any other file service yet. Screens show files from your Library, Guest Files and bloop's sample files.

## What bloop Collects {#data}

In short: your email, the files you store, and records of what you do with them.

3.1 The table lists each kind of personal data, where it comes from, and its status.

Caption: What bloop collects, where it comes from, and its status

| Data | From | Status |
| --- | --- | --- |
| Your email address, and the invite that named it (who sent it and when) | the person who invited you, then you | Live |
| Your passkeys: a public key and a name for each, never your fingerprint, face or device PIN | your device, if you add one | Live |
| Your sign-ins: when, how (email code or passkey) and a label such as "Safari on iPhone" | bloop's own records | Live |
| The files in your Library (their bytes, name, type and size), and the copies bloop makes to show them: a PDF, slide pictures, a thumbnail and your speaker notes | you | Live |
| A Guest File (its bytes, name, type and size), and the copies bloop makes to show it | the person who sends it | Live |
| A record of each Session: which Item, on which Screen, when, and how it ended | bloop's own records of what you do | Live |
| A keyed hash of your IP address, used to stop abuse (bloop does not store the address itself, except in Cloudflare's request logs if they are turned on: [section 5](#retention)) | your browser's connection | Live |
| Signals from your browser that tell a person from a bot, when you ask for a sign-in code or send a report | your browser, through Cloudflare Turnstile | Live |
| Reports you send about content, and what bloop did about them | you, and bloop's own records | Live |
| Records of what bloop did to an Account or file, and why (for example, a file disabled after a report) | bloop's own records | Live |
| Usage counts with no names or file names | bloop's own records | Live |
| Emails you send to <{{email}}>, and bloop's replies | you | Live |
| Emails bloop sends you: invites, sign-in codes and notices about your Account | bloop | Live |
| Waitlist answers: your role, where you would use bloop, your organization, what you would like next, your timing and your email, plus the page you came from | you, through the Tally form | Live |
| Your work email and Microsoft account ID (tenant and object ID); never your name | Microsoft, when you sign in and allow access | Planned |
| Your OneDrive access, encrypted, and the ID of the folder bloop reads | Microsoft, when you sign in and allow access | Planned |

3.2 bloop stores the files you upload to your Library until you delete them ([section 5](#retention)). It does not look inside them except to check them and to make the copies it needs to show them, and it does not read your speaker notes for any other purpose: they are shown only on your phone, never on the Screen.

3.3 bloop does not use your data for automated decisions about you, and does not build profiles. Its checks refuse some files automatically, such as decks with macros; you can ask for a person to look at a refusal ([section 9](#rights)).

3.4 Photos sent as a Guest File are re-encoded on your phone before they leave it, which removes their location and other metadata. Videos have their location fields cleared on your phone. Files you upload to your Library are stored as you send them, with any metadata they carry; remove it first if you do not want it stored.

## Why bloop Uses It {#basis}

In short: to run your Account and the Sessions you start, keep them safe, and answer you.

4.1 Each purpose and its **lawful basis** under the UK GDPR:

Caption: Each purpose, the data it uses, and its lawful basis

| Purpose | Data | Lawful basis |
| --- | --- | --- |
| Run your Account and Library: sign-in, storing, converting and showing your files, export and deletion | your email, passkeys, sign-ins, Library files, Session records | Contract: providing the service you ask for |
| Send you sign-in codes and notices about your Account | your email | Contract: providing the service you ask for |
| Put the Items you approve on the Screen you choose | Session records, Library files, Guest Files | Contract: providing the service you ask for |
| Show a Guest File on the Screen its sender chose | the Guest File | Legitimate interests: showing the file the sender picked, for the time they picked |
| Invite you, and keep invites tied to one email | invites, waitlist answers | Legitimate interests: running an invite-only early access |
| Stop abuse and keep the service safe | IP hash, Turnstile signals, sign-ins, Session records | Legitimate interests: security and fraud prevention |
| Act on reports of illegal content, suspend Accounts that break the Terms, and keep a record of each decision | reports, the reported file, records of actions | Legal obligation: the Online Safety Act 2023; and legitimate interests: keeping the service safe and lawful |
| Report child sexual abuse content to the National Crime Agency, and keep it as the law requires | the reported file, its records, Session records, IP hash | Legal obligation: the Online Safety Act 2023 and the CSEA reporting regulations |
| Give your organization's IT team a record of what was opened where | Session records | Legitimate interests: accountability on shared machines; under an agreement with your organization, bloop acts on its instructions instead |
| Count use, with no names, to improve bloop | usage counts | Legitimate interests: improving the service |
| Invite you to early access from the waitlist and arrange a call | waitlist answers | Consent, which you can withdraw at any time |
| Answer your emails | your emails | Legitimate interests: replying to you |

4.2 **You have the right to object** at any time to any use based on legitimate interests. Write to <{{email}}> and bloop will stop unless it has compelling grounds that override your interests, or needs the data for a legal claim.

## How Long bloop Keeps It {#retention}

In short: your files stay until you delete them; a guest's file goes when the Session ends; records go on a fixed clock.

5.1 A daily job deletes data when its period ends. [Data and Retention](/articles/data-and-retention) explains each period.

Caption: How long bloop keeps each kind of data

| Data | Kept |
| --- | --- |
| A file in your Library, and its converted copies | Until you delete it. A deleted file goes to your Trash for 30 days, where you can restore it, and is then deleted for good. You can also delete it from the Trash at once |
| Your Account (email, passkeys, sign-ins) and everything in your Library | Until you delete your Account, which takes effect 7 days after you ask (you can cancel by signing in before then); or, if you do not use your Account for 12 months, bloop emails you a warning and deletes it 30 days later unless you sign in |
| A Guest File's bytes and converted copies | Deleted when its Session ends. Backstops: an hourly check, and a storage rule that deletes any guest file within 2 days at the latest |
| A Guest File's record (name, type, size, times) | 30 days after the file is deleted |
| Session and access records | 180 days. In the Demo, 7 days |
| Sign-in codes and passkey steps | A sign-in code works for 10 minutes; the record goes 1 day after it expires |
| A phone sign-in | 30 days unused, 90 days at most; ends at once when you sign out everywhere or delete your Account |
| Invites | 7 days to accept; the record goes 90 days after it is accepted, revoked or expired |
| Reports about content | 1 year |
| Records of what bloop did to an Account or file, and why | 2 years |
| Content held for a report to the National Crime Agency | See [5.3](#5.3) |
| Usage counts | 90 days, then only daily totals, for 2 years |
| Codes, pairing secrets and links for a Session | Until the Session ends, is canceled or times out |
| IP hash for abuse limits | 10 minutes for failed code attempts; until the Session ends for the Screen's own check |
| Your OneDrive access (Planned) | Until you tap Disconnect OneDrive (deleted at once), remove bloop in My Apps or Microsoft Entra (deleted the next time it fails), ask for erasure, or 30 days unused |
| Cloudflare's request logs | Off on the live site. If they are turned on, they record each request's details, including your IP address, and keep them at most 7 days |
| Cloudflare's record of each email bloop sends (to, from, subject, delivered or not) | 31 days |
| Waitlist answers | Until you ask bloop to delete them, or the waitlist closes; once you are invited, 90 days after the invite |
| Emails to <{{email}}> | 2 years after the last message in a thread |

5.2 **Restore history.** bloop's database keeps a history that lets it be restored to any minute in the last 30 days, and the stores behind your Library list and live Screens keep the same. So a record bloop deletes, including one you asked bloop to erase, can still be recovered from that history for up to 30 days, and is then gone for good. bloop uses the history only to recover from a fault, and never to bring back data someone asked bloop to erase. Files themselves are not in that history: once a file is deleted for good, it cannot be recovered.

5.3 If bloop becomes aware of child sexual abuse content stored or sent through it, the law requires bloop to report it to the National Crime Agency. Once a report is sent, bloop must keep the reported content, the report, and related data it holds for 1 year from the report, and the report's reference for 5 years. bloop keeps nothing else for this reason, and deletes each item when its period ends.

5.4 When your Account is deleted, bloop deletes your email, passkeys, sign-ins, every file in your Library and its converted copies, and removes your email and file names from its Session records. It keeps only what [5.1](#5.1) lists as kept for longer (reports, records of actions, and an invite record for up to 90 days), anything [5.3](#5.3) requires, and sends one email to say it is done.

## Who Can See Your Data {#access}

In short: you, the Screens you choose, and the one person who runs bloop when there is a reason.

6.1 **You** see your Library, your sign-ins and your live Screens on your phone or computer. **A Screen** gets only the Items you approve for it, and only for the Session. Your speaker notes go only to your phone.

6.2 **The person who runs bloop.** Your files are encrypted at rest by Cloudflare, but they are not end-to-end encrypted: bloop's server must read them to convert and show them. So the person who runs bloop can technically open any file or record bloop stores, using bloop's admin tools or the Cloudflare account that hosts it. bloop's admin tools show Accounts, invites, reports and records of actions, and the names, types and sizes of files; they open a file's contents only when that file has been reported. bloop looks at a file's contents only to act on a report about it, to fix a fault you ask it to look at, or when the law requires it, and never for a report of child sexual abuse content, which goes to the National Crime Agency unopened. Every action through bloop's admin tools is recorded with its reason, each opened file included. The Cloudflare account is protected by multi-factor sign-in.

6.3 No one else at bloop can see your data: bloop has no other staff.

## Who Helps Run bloop {#processors}

In short: three companies process data for bloop, and none may use it for themselves, with one narrow exception.

7.1 These **processors** handle personal data only on bloop's instructions, under written terms:

Caption: The processors, what each does, the data it handles and where

| Processor | What it does | Data | Where |
| --- | --- | --- | --- |
| Cloudflare, Inc. (US) | Hosting, database, file storage, file conversion, network, DNS, the emails bloop sends (Cloudflare Email Service) and the bot check on sign-in and reports (Turnstile) | Everything in section 3 except waitlist answers held by Tally and your emails to <{{email}}>, and its request logs if they are turned on | Files and the database are stored in Cloudflare's EU jurisdiction, and files are converted there; each request is handled at the nearest Cloudflare data center |
| Tally BV (Belgium) | The waitlist form | Waitlist answers | EU; Tally uses its own subprocessors, some in the US |
| Apple (iCloud Mail) | The mailbox behind <{{email}}> | Emails you send and bloop's replies | Apple's data centers, in the US and elsewhere |

7.2 The one exception: Cloudflare also uses Turnstile's browser signals to improve its own bot detection, as a controller in its own right under its Turnstile privacy terms. Turnstile runs only when you ask for a sign-in code or send a report.

7.3 **Microsoft is not a processor for bloop.** When OneDrive is live, Microsoft is where your files and sign-in come from, and it controls your Microsoft account under its own terms and your organization's.

7.4 bloop does not sell personal data, and shares it with no one else except where the law requires it, such as a report to the National Crime Agency ([5.3](#5.3)).

## Where Data Is Stored {#transfers}

In short: stored in the EU, run by a US company, with legal safeguards.

8.1 bloop's database, your Library and Guest Files are stored in the EU, and files are converted in the EU. bloop never claims "UK only": Cloudflare is a US company, and a request is handled at the Cloudflare data center nearest the person making it.

8.2 Where data goes outside the UK, the safeguards are the UK's adequacy regulations for the EU, and for the US the UK-US data bridge: Cloudflare is certified to the UK Extension of the EU-US Data Privacy Framework. Cloudflare's data processing terms add the EU Standard Contractual Clauses with the UK Addendum in case that certification lapses. Tally's and Apple's transfers follow their own published terms.

## Cookies and Storage {#storage}

In short: only what the service needs to work; no banner, because nothing tracks you.

9.1 bloop runs no analytics scripts, no ads and no tracking. Everything below is strictly necessary for a feature you use, so no consent banner is needed.

Caption: What bloop stores in your browser, why, for how long, and its status

| Name | Kind | Why | How long | Status |
| --- | --- | --- | --- | --- |
| `__Host-bloop_sid` | cookie | Keeps you signed in | 30 days unused, 90 days at most | Live |
| `__Host-bloop_in` | cookie | Tells bloop's pages you are signed in, so they show Library in place of Sign In; it holds no secret | As long as your sign-in | Live |
| `__Host-bloop_bind` | cookie | Ties a passkey step to the browser that started it | 10 minutes | Live |
| `bloop.pid` | phone, local storage | Lets your phone end or control the Session after you close the tab | Until the Session ends | Live |
| `bloop.sid` | Screen, session storage | Keeps the Screen in its Session on reload | Until the Session ends or the tab closes | Live |
| `__Host-bloop_oauth` | phone, cookie | Protects the Microsoft sign-in step | 10 minutes | Planned |
| `__Host-bloop_room` | Screen, cookie | Shows a registered room's name | Set by the room's IT team | Planned |

9.2 Files reach a Screen from a separate bloop address that sets no cookies. The waitlist form is on tally.so and follows Tally's own cookie policy.

## Your Rights {#rights}

In short: see, fix, move or delete your data, much of it yourself; bloop answers within a month.

10.1 You have the right to:

1. get a copy of your data (access);
2. have it corrected;
3. have it erased;
4. restrict how it is used;
5. receive it in a portable format;
6. object, as in [4.2](#4.2);
7. ask a person to look again at a file bloop's checks refused;
8. withdraw consent to the waitlist at any time, without affecting what came before.

10.2 Much of this you can do yourself, in Account: **Export** downloads your original files and a data file of your Account, sign-ins, Sessions and records; **Delete Account** erases everything as [5.4](#5.4) describes; and you can delete any file, rename it, or change your email.

10.3 For anything else, write to <{{email}}>. bloop replies within one month, and may ask you to prove who you are first. In some cases the law allows a longer time or a refusal; bloop will say why.

10.4 Once OneDrive is connected, tap Disconnect OneDrive on any phone while you approve: bloop deletes its stored access and every sign-in ends at once, a lost phone's included. You may also be able to remove bloop in My Apps (myapplications.microsoft.com); your IT team can remove it for everyone in Microsoft Entra.

## How to Complain {#complain}

In short: tell bloop first; you can always go to the ICO.

11.1 To complain about how bloop uses your data, write to <{{email}}> with "Complaint" in the subject. bloop acknowledges a complaint within 30 days, looks into it without undue delay, and tells you the outcome.

11.2 You may also complain to the **Information Commissioner's Office (ICO)**, the UK regulator, at any time, at [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint/), which lists its helpline and postal address. The ICO usually expects you to raise it with bloop first.

## Children {#children}

In short: Accounts are for adults; bloop is not made for children.

12.1 Accounts are for adults (18 or over) at universities, colleges and workplaces, by invite only. bloop is not made for children, and does not knowingly hold an Account for anyone under 18; if it learns of one, it deletes it. A Guest File, from anyone, is deleted when its Session ends, except as [5.3](#5.3) describes.

## Changes to This Notice {#changes}

In short: every change is dated here, and big ones are announced first.

13.1 bloop will post any change here with a new version and date. For a material change, bloop will say so on this page and email Account holders and people on the waitlist before it takes effect.

### What Changed

- Version 2.0, 2026-11-25: Accounts by invite, the Library, who can see your data, the restore history, reports and the National Crime Agency, and Cloudflare Email Service and Turnstile.
- Version 1.0, 2026-11-25: first published version, before Accounts.
