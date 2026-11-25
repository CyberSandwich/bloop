---
kind: article
order: 1
title: How bloop Works
description: How a phone pairs with a shared screen, what the screen is given, and how a session ends. Written for IT teams and lecturers.
published: 2026-11-25
---

bloop lets a presenter put their own files on a shared PC without signing in to anything on it. This article follows one session from the first scan to the last link, and says what the room PC holds at each step.

## The Problem It Solves {#problem}

A room PC is used by many people in a day. Signing in to your own account there leaves traces: a cached sign-in, recent file names, a downloaded copy. Plugging in a USB stick moves the risk to the stick. Either way the presenter makes a trade between convenience and leaving something behind.

bloop moves the choosing to the presenter's phone. The PC shows a web page, and the phone decides what the page may show. The PC never holds the presenter's account.

## Your Account and Library {#library}

A presenter signs in to bloop on their own phone or computer, never on the room PC. Accounts are by invite during early access, and sign-in uses a code sent to email or a passkey.

Files go into the presenter's Library ahead of time, from the phone or a computer, within the limits in [the Terms](/terms#library). bloop stores them in the EU until the presenter deletes them. A deleted file waits in the Trash, where it can be restored, and an Account left unused gets a warning email before it is deleted. [Data and Retention](/articles/data-and-retention) explains each step.

After an upload, bloop prepares the file once to show in a browser, so a deck still shows on a PC without PowerPoint. That work runs in a sealed container in the EU, as [the Security page](/security#files) describes. A deck's speaker notes are kept for the phone and never go to the Screen.

## Five Steps {#steps}

1. **Scan.** The room PC opens bloop's Screen page, which shows a QR code and a short typed code. A code works once and lasts 60 seconds. The phone scans it, or the presenter types it. A phone that is not signed in can sign in and carry on, try the Demo, or send one file as a Guest File.
2. **Match.** The Screen shows a two-digit number, and the phone shows three. The presenter taps the one on the Screen. A wrong tap cancels the pairing, and the Screen shows a new code.
3. **Approve.** The presenter chooses files from the Library and taps Approve. Files already marked Up Next are approved by the match tap itself. Nothing is typed on the PC.
4. **Show.** bloop's server gives the Screen one short-lived link for each approved file. A deck opens in PowerPoint, read-only, when the PC has it; otherwise, and for other files, the Screen shows the prepared copy in the browser.
5. **End.** The presenter ends the session from the phone or from Account on any device, or someone ends it at the Screen, or it ends by itself. Every link stops working at that moment.

## What the Screen Gets {#gets}

The Screen gets the files you approve, each as a link, and nothing else. It never gets your account, your other files, your speaker notes, or any way to list them. It cannot approve anything: only the signed-in phone that made the match can.

Each link is made for one file in one session, stops working when the session ends, and is stored only as a hash. Every fetch checks the file again, so a file you delete stops at once, even on a Screen. [The Security page](/security#encryption) gives the exact limits.

## Matching the Right Screen {#match}

The first phone to claim a code locks the pairing, so a code photographed from the back of the room is already used by the time anyone tries it. bloop checks that a phone is signed in before it spends the code.

The three-number pick is a check for a person, and the number is not a secret. It catches a QR sticker placed over a real screen, or a code relayed from another room, because the presenter must match the screen in front of them. [The Threat Model for IT Teams](/articles/threat-model-for-it-teams) says exactly what it does and does not defend.

## Guest Files {#guest}

A phone that is not signed in can still send one file straight to the Screen as a Guest File.

- Each file is checked by its bytes, not its name. A deck with macros, ActiveX or embedded programs is refused.
- A Guest File never opens by itself. Someone at the Screen must click Open, which proves a person is standing there.
- bloop deletes the file when the session ends, and two backstops catch any it misses. [The Privacy Notice](/privacy#retention) gives the latest it can last.

## How a Session Ends {#ending}

Every session has an end time kept on the server. The presenter can change it on the phone, within the limits on [the Security page](/security#how). A forgotten session still ends, and a burst of changes cannot stretch it past the limit. When it ends, bloop drops the links, the pairing secrets and any Guest File; Library files stay in the Library. [What Stays on the PC](/articles/what-stays-on-the-pc) covers what a web page cannot reach.

## What Works Today {#today}

The [Security page](/security#status) keeps the one current list of what is live and what is planned.
