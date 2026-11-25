---
kind: legal
order: 4
title: Accessibility
description: How accessible bloop is, the problems we know about, and how to report one.
effective: 2026-11-25
version: 1.0
---

bloop wants everyone to be able to put a file on a shared screen, whatever their eyesight, hearing, movement or way of reading. This statement covers bloop.here: the site pages, the Screen page a room PC opens, and the phone page your camera opens. It says how accessible they are today, the problems we know about and what we are doing about them.

## How Accessible bloop Is {#how}

You should be able to:

- use the pages with a keyboard alone, and with a screen reader on the phone or the room PC
- zoom the site pages up to 200 percent, and read them at a width of 320 pixels without scrolling sideways
- turn off motion: with reduced motion set on your device, bloop's animations stop
- pair a Screen without the QR code, by typing the code the Screen shows at [bloop.here/code](/code)
- approve on your phone rather than at the PC, so nothing is typed on a shared keyboard

Some parts are not fully accessible yet. They are listed under [Known Problems](#problems), each with a way around it.

## Compliance Status {#status}

bloop aims to meet the Web Content Accessibility Guidelines (WCAG) version 2.2 at level AA. It is partially compliant: most of it meets the standard, and the problems listed below do not yet.

## Known Problems {#problems}

- **Automated checks cover only some screens.** The landing page, these policy pages, the articles and some states of the Screen and phone pages are checked automatically on each change. Other states, such as the Session Expiry sheet or a message that appears and fades, are not yet. *Way around:* if something does not work with your setup, tell us (below). *Plan:* check every page and every state automatically.
- **Windows contrast themes are untested on the QR code.** In a Windows contrast theme the Screen's QR code may show in reversed colors, which some phone cameras cannot read. *Way around:* type the code the Screen shows at [bloop.here/code](/code) on your phone. *Plan:* keep the QR code's own colors in contrast themes, and test it in each Windows theme.
- **Small Screen text at 125 or 150 percent scaling.** When a room PC scales its display, or the browser is zoomed, the Screen page can fall back to a narrower layout whose hint and code text are small. Below 600 pixels wide it asks for a larger window instead of showing a code. *Way around:* zoom the browser back to 100 percent or make the window full screen; the number to match also shows on your phone. *Plan:* size the Screen's text with its QR code, and make the message say what to change.
- **The countdown on the phone changes every second.** The "Ends in" button names the time left to the second, so a screen reader can read it again each time it changes. *Way around:* open it to hear the end time once, as a clock time. *Plan:* give the button a name that changes only each minute.
- **Older browsers on the room PC.** The Screen's End confirmation and its file list need Chrome or Edge 114, Safari 17, Firefox 125 or later. In an older browser they may not open, or may stay open. *Way around:* end the Session from your phone; it also ends by itself when its time runs out. *Plan:* check the browser when the Screen opens and say which version it needs, and use a standard dialog for End.

## Report a Problem {#report}

If you find a problem not listed here, or you need something from bloop in another format, such as large print or plain text, email <{{email}}> with "Accessibility" in the subject. Say which page, what you were trying to do and what you use (for example, a screen reader or zoom). bloop will reply within 5 working days.

## Enforcement {#enforcement}

The Equality and Human Rights Commission (EHRC) enforces the Equality Act 2010 in England, Scotland and Wales. If you are not happy with how bloop answers your report, contact the [Equality Advisory and Support Service (EASS)](https://www.equalityadvisoryservice.com/). In Northern Ireland, contact the [Equality Commission for Northern Ireland](https://www.equalityni.org/).

## How This Was Prepared {#prepared}

This statement was prepared on 2026-11-25, the effective date above, from bloop's own testing: automated checks that run on every change, and checks by hand on phones and desktop browsers. No external audit has been done yet. bloop will review it when the pages change, and at least once a year.

## What Changed {#changes}

- Version 1.0, 2026-11-25: first published version.
