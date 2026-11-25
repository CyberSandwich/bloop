---
kind: article
order: 3
title: What Stays on the PC
description: What bloop clears on a room PC when a session ends, what a web page cannot reach, and what an IT team can do about the rest.
published: 2026-11-25
---

A shared PC should not remember the last person who used it. bloop does what a web page can do toward that, and this article says where a web page stops. The short answer: bloop clears its own traces, and a downloaded copy, recent file names and browser history can stay until the PC's profile is wiped.

## What bloop Clears {#cleared}

When a session ends, from the phone, from the Screen or by itself:

- **On the server,** bloop drops every link, the pairing secrets, the list of files the phone was shown, and any Guest File. Links stop working the moment the session ends, so a copy of one kept in a list is dead.
- **In the browser,** the Screen page holds only a session ID in the browser's session storage, and the links live in memory. On end the page clears them, asks the browser to clear the site's storage, and closes any PDF window it opened.

The room PC never held the presenter's account, so there is no account on the PC to sign out of.

## What Can Stay {#stay}

These sit outside the reach of any web page:

- **A downloaded copy.** If a file is opened by downloading it, the copy sits in the browser's Downloads folder.
- **The copy PowerPoint opened,** and the file name in its recent list.
- **Browser history and opened tabs,** which can include the address of a link. That link is dead after the session, but the entry remains.
- **A Microsoft download link,** when OneDrive is live and a PC fetches through Microsoft. PowerPoint may be given such a link, and it can work for up to 1 hour.

## What bloop Cannot Reach {#cannot}

A web page cannot delete files, empty a recent list or clear another program's history. bloop does not claim to, and it does not ask for a way to. The Screen says so when a session ends, with the one thing a person can do about it: "Delete {file} from Downloads before you leave."

## What IT Teams Can Do {#it}

Treat the room PC the way you treat any shared machine:

- Reset or wipe the user profile at sign-out or on a schedule.
- Run the browser in a mode that clears history and downloads on exit.
- Review the recent-file settings of your Office build for shared rooms.

Whatever you choose, test it in your own rooms: run a session, end it, sign out, restart, and then look in the places above. That is the only proof that counts for your PCs.

## What Is Not Measured Yet {#unmeasured}

bloop has not yet measured what remains on real room PCs after sign-out and restart, including how long the Microsoft download link persists and what the download history keeps. Until it has, it claims the clearing described above and nothing beyond it. If you try bloop in your own rooms, those results are the most useful thing you can send to <hi@bloop.here>.
