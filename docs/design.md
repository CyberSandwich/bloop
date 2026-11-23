# bloop design

The one source of truth for bloop's brand, visual design, UI and UX. The system is a calm paper-and-ink one modeled on ample.computer, with opsis.app's bottom glass pill and hero reel; nothing from either site is copied (section 14). Strings marked `[V-n]` depend on an unverified product property: ship the string only once open item n (section 15) passes, otherwise ship the fallback given there. Every screen passes the checklist in section 13 before it is called done.

## 1. Brand

### Idea
bloop puts your slides on a shared screen. You scan the code on the screen, choose your file on your phone and tap Approve; it opens on the screen, and your account stays on your phone. The brand is the calm of a handover that just works: a quiet paper page, ink type, one live code. The less on the site, the better: every element earns its place.

### Name and logo
| Rule | Value |
|---|---|
| Logo | a dark grey lowercase "b" (#646464) over a pastel orange circle (#F4BA8B), drawn as two paths in `public/favicon.svg` (no text, no embedded image); the same file is the favicon, the pill and footer mark, and the source of the touch icon and OG image (section 9) |
| Wordmark | the word `bloop` beside the logo, lowercase, Inter 600, tracking -0.03em, `--ink` |
| Name-swappable | one build constant (`SITE_NAME`) in every page, title, meta tag and string; baked only into the OG image, which a script regenerates |
| In sentences | lowercase `bloop`, even at the start of a sentence |
| Never | the logo's colors in CSS, a gradient, a period after the wordmark, the name inside the QR |

## 2. Principles

| # | Principle | Test |
|---|---|---|
| 1 | Calming first. Light only, paper and ink, no accent color in the UI. | Squint: only the ink pills and the logo stand out. |
| 2 | Far less text. One-line headlines, one plain sub, a short FAQ. | Section 13 word caps pass. |
| 3 | Relevant. Every element is about the handover (code, phone, approval, file, screen). | Delete any element that would make sense on another product's page. |
| 4 | Looks finished. Real copy, real states, real product UI in the reel. | No lorem, no "Coming soon", no unstyled state. |
| 5 | Concentric geometry. Inner radius = outer radius minus inset. | Every nested corner passes the formula in section 4. |
| 6 | Coherence over collage. Each borrowed pattern is restated in this one system or dropped. | Section 13 coherence list passes. |

## 3. Voice and copy

### Rules
| Rule | Example |
|---|---|
| One plain sentence per headline, with a period; no second clause in grey. | "Your slides on any screen." |
| Headlines at most 8 words; one sentence of at most 20 words (section 13). | |
| Lead with slides for lecturers; security leads only for IT. | |
| Security as concrete never-statements: actor, verb, specific thing. "X, never Y" is allowed; "not X, but Y" is not. | "One file, never an account." |
| Conditions go in a footnote or on `/it`, never into the marketing sentence. | |
| Plain beats clever: no puns, no analogy on the landing, no unexplained noun. | |
| "session", "token" and "tenant" stay off every user-facing screen; only `/it` may use them. | "End", "Ended." |
| Contractions yes. Never "we", "our team", "oops", "uh-oh". | |
| Errors: what happened, no blame, what to do, one verb button. | "Unable to open your slides." |
| Digits for all numbers, units tight: 60 s, 90 minutes, 1 file. | |
| Sentences in sentence case with a period. Site labels (landing, `/it`, `/privacy`, 404) are sentence case; app labels (`/s`, `/a`, `/code`) stay Title Case until open item 26 settles one casing. | "Try the demo"; "Approve on This Device" |
| US English; no em or en dashes, exclamation marks, emoji or adjective triads. | "Canceled", "organization" |
| Never claim sign-in is gone: the PC's own login still exists. Say what the screen does not get. | |
| Never promise freshness (that the newest edit opens), that it runs on every screen, or that the PC keeps nothing. | |

### Vocabulary
| Use | Avoid |
|---|---|
| your slides, your file, the screen, the room PC, scan, choose, Approve, End, one file, ends by itself `[V-2]`, early access, demo | the phrases in `tools/never-say.txt`, the house banned words (`references/ai-tells.md`), ephemeral, pilot, university-approved, single sign-on, AI, platform, room features, remote, polls, secure (as a bare adjective), buy now, subscribe, any price |

`tools/never-say.txt` holds bloop's never-say phrases, one per line; the build greps every page and string file against it and fails on a hit.

### Strings (one per slot)

**Page meta**
| Slot | String |
|---|---|
| `<title>` landing | bloop: your slides on any screen |
| meta and OG description | Scan the code on the screen with your phone and choose a file. It opens in seconds, and your account stays on your phone. |
| `<title>` `/it`, `/s`, `/a` | bloop for IT and AV; bloop screen; Approve on bloop |
| `<title>` `/privacy`, 404 | bloop privacy notice; bloop: page not found |
| OG image alt | bloop: Your slides on any screen. |

**Landing**
| Slot | String |
|---|---|
| h1 | Your slides on any screen. |
| Sub | Scan the code on the screen with your phone and choose a file. It opens in seconds, and your account stays on your phone. `[V-4]` |
| Actions | Try the demo (ink pill, `/s?mode=demo`); Get early access (outline pill, a `mailto:` to the early access address) |
| Reel label (`role="img"`) | A room screen shows a code. A phone scans it and asks to open Lecture 4.pptx. After Approve, the slides are on the screen, and End brings the code back. |
| Reel captions | Scan; Approve; Slides up. Control: Pause the animation (`aria-pressed`) |
| FAQ heading | Questions |
| What is bloop? | A way to open your slides on a shared screen, such as a lecture room PC, from your phone. The screen gets only the file you choose. `[V-4]` |
| Do I need to install anything? | No. The screen runs bloop in its web browser, and your phone uses its camera. The room PC opens your slides in PowerPoint. `[V-8]` |
| What does the room PC keep? | A link to the file you open, never your account. A downloaded copy or the file name in recent lists can stay until the PC's profile is wiped. See what can stay. (links to `/it`; threat model RES-02: never a nothing-stays claim) |
| Is it free? | Yes. Early access is free while bloop is being tested. `[V-20]` |
| Pill | the logo, bloop, Try the demo |
| Footer | the logo and bloop; Privacy, For IT, Source (the public repository), the early access address as text |
| Header on `/it`, `/privacy`, 404 | the logo and bloop (home); Try the demo |
| 404 | This page isn't here. / Check the address, or go to the home page. / button Go to the home page |
| No JavaScript | `/s` "This screen needs JavaScript to show a code."; `/a` "Approving needs JavaScript. Turn it on, then scan again." The landing needs none: the reel is CSS, the FAQ is native. |

State strings for `/s` and `/a` are in section 7 with their screens.

## 4. Tokens

Tokens live in `public/css/app.css` `:root`; this list restates them, and the drift test holds the two equal. Light only (`color-scheme:light`).

### Color
| Token | Use |
|---|---|
| `--paper:#f3f3f0` | page ground everywhere |
| `--surface:#ffffff` | cards: FAQ items, the QR panel, file lists, the warn card, the reel's caption and pause button |
| `--ink:#1e1e1c` | text, primary pills, the tick, progress and capsule fills, the focus ring |
| `--muted:#6c6c66` | secondary text (4.75:1 on paper); never on a pastel |
| `--g2:#a3a39c` | the outline pill's ring, the empty tick ring, field rings; never text |
| `--g1:#dcdcd7` | skeletons, capsule and progress tracks |
| `--hairline:rgba(0,0,0,.08)` | rules and card rings, drawn as `box-shadow`, never a border |

The reel paints its scene from the same palette plus ample-like pastels as SVG fill attributes (sky #CFE0E8 ground; butter #F6E7B2, lavender #D8D1EF, sage #DDE3D6 chart bars), so they are not tokens. Status colors (`--ok`, `--warn`, `--err`) are not used: a state is a sentence plus the object changing.

### Type
- `--font:"Inter","Inter Fallback",Arial,sans-serif`, self-hosted, 400 and 600 only. Body 17/1.5, -0.011em.
- `@font-face` "Inter" from `/fonts/inter-latin.woff2` (`tools/subset-font.py` from `src/fonts/InterVariable.woff2`, `opsz` kept), `font-weight:400 600`, `font-display:swap`, the Latin `unicode-range` (U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD). "Inter Fallback": `local("Arial")`, `size-adjust:107.1%`, `ascent-override:90.4%`, `descent-override:22.5%`, `line-gap-override:0%` (open item 11).

| Role | Size | Line height | Tracking | Weight |
|---|---|---|---|---|
| hero h1 | `min(96px, (100vw - 2 * var(--pad)) / 12)`: one line at every width | 1 | -0.05em | 600 |
| h2 (FAQ), `/it` and `/privacy` h1 | 38, 54 from 768 | 1.04 | -0.035em | 600 |
| hero sub | 20, 24 from 768, `--muted`, max 680 | 1.35 | -0.015em | 400 |
| `/s` heading, line | 54; 26 `--muted` | 1.04; 1.3 | -0.035em; -0.02em | 600; 400 |
| phone title | 28 | 1.2 | -0.025em | 600 |
| FAQ question, answer | 17 600; 16 `--muted` | 1.5; 1.6 | | |
| button | 16 (15 in a header or the pill) | 1 | -0.01em | 600 |
| small | 14 `--muted` | 1.45 | | 400 |
| codes (typed code, match digits) | context size, `tabular-nums` | 1 | +0.04 to 0.06em | 600 |

Headings `text-wrap:balance`; no mono, no eyebrow, no uppercase label, no grey second clause in a headline.

### Radii, shadows, motion, layout
| Token | Use |
|---|---|
| `--r-chip:8px` | skeletons, the summary focus ring |
| `--r-field:14px` | the code field, the slide frame |
| `--r-card:20px` | every card |
| `--r-stage:28px` | the reel (16 under 640) |
| `--r-pill:9999px` | buttons, chips, the bottom pill |
| `--sh-frame:0 0 0 1px rgba(0,0,0,.06),0 30px 60px -30px rgba(0,0,0,.35)` | the demo slides |
| `--sh-stage:0 0 0 0.5px rgba(0,0,0,.1),0 50px 120px -30px rgba(30,50,70,.45),0 20px 40px -20px rgba(0,0,0,.2)` | the reel |
| `--sh-pill:0 0 0 0.5px rgba(0,0,0,.08),0 10px 30px rgba(0,0,0,.12)` | the bottom pill, the skip link |
| `--ease-out:cubic-bezier(.22,1,.36,1)` | the workhorse: reveals, the FAQ, the reel fades |
| `--ease-spring:cubic-bezier(.34,1.56,.64,1)` | the pill's arrival only |
| `--ease-ui:cubic-bezier(.4,0,.2,1)` | press feedback |
| `--ease-cam:cubic-bezier(.65,0,.35,1)` | the reel's camera push |
| `--pad:24px` | page side padding; 40 from 640 |
| `--section:80px` | section rhythm; 112 from 768 |

Cards are flat white on paper with no shadow (the reel, the slides and the pill are the only lifted things). Concentric rule: `r_inner = r_outer - inset`, floored at 4 px; a bar holding a pill is a pill. Content width `min(100% - 2 * --pad, 1136px)`; text columns 760. Breakpoints 640, 768, 1024; check at 390, 834 and 1440.

## 5. Layout

- One column, centered, generous space. The landing is: hero (h1, sub, two pills), the reel, the FAQ, the footer, and the bottom pill. No top nav on the landing; `/it`, `/privacy` and 404 get a slim header (logo home, Try the demo) and the same footer.
- The hero has no entrance animation and no `min-height:100vh`; the h1 paints in the first frame (it is the LCP element).
- The pill never covers content: `body` keeps 96 px plus the safe area of bottom padding and `html` the same `scroll-padding-bottom`.
- `/s`, `/a` and `/code` are task pages with no site header, footer or pill.

## 6. Components

Shared states: focus is `outline:2px solid var(--ink)` on `:focus-visible`, never removed; press is `scale(.97)` over 150 ms `--ease-ui`; disabled is opacity .38; no hover color change on ink pills (the outline pill's ring darkens to ink, text buttons underline); loading swaps in a 16 px spinner with a progressive label ("Approving...").

### Buttons
| Type | Look | Use |
|---|---|---|
| primary | ink pill, paper label, 48 tall, padding 0 24 | the one action per view: Try the demo, Approve, Continue |
| secondary | outline pill: `inset 0 0 0 1.5px var(--g2)` ring, ink label | Get early access, End, Cancel, Approve on This Device |
| text | no fill, 44 hit area | Download It Instead, Full Screen, Send a File Instead |
| stacked (phone pages) | full width, 52 tall, gap 8 | Approve then Cancel |

No gradient, no gloss, no destructive variant.

### Reel (the landing's one visual)
- Three frames of real bloop UI, each an inline SVG (viewBox 1200 x 750) of a room monitor and a phone: Scan (the `/s` waiting screen with a real QR for the landing's address; the phone camera locks on and shows the link), Approve (the screen's "Check your phone." with the match code; the phone's approve sheet, Approve pressed), Slides up (a slide on the monitor; the phone's open state, End pressed, back to Scan). Shared parts (`#rig`, `#qr`, the island) are SVG `<defs>` used by reference.
- Motion: one 12 s CSS clock. Frame 1 never fades; frames 2 and 3 fade in over it (`--ease-out`), so bezels never show through each other. Each change is sequential: the outgoing frame's text and caption fade out, the frames cross-fade with no text showing, then the incoming text fades in, so two texts are never legible at once. A camera push to 1.045 toward the phone during Approve (`--ease-cam`), corner brackets snapping in, button presses, chart bars rising. Tilt: under `@supports (animation-timeline:view())` and 900 px up, `rotateX(18deg) scale(.94)` to flat over `entry 0%` to `cover 20%`, so it rests flat.
- Control: a 44 px pause button (WCAG 2.2.2), shown by the script; the script also pauses the clock while the reel is off screen. No `style` writes: classes only.
- Accessibility: the stage is one `role="img"` with the label in section 3; the frames are `aria-hidden` and `inert`.
- Reduced motion: no clock, no tilt, no pause button; the three frames sit side by side (one column on a phone), each captioned.

### FAQ
Native `<details>` as white `--r-card` cards, 12 apart, max 760, centered. Summary 17/600 with a `--muted` "+" that turns 45 degrees. Open and close animate the height: `::details-content` with `interpolate-size:allow-keywords` where supported (block-size 380 ms and opacity 250 ms, `--ease-out`); elsewhere a WAAPI height tween in `public/js/site.js` (find in page still opens an item). Reduced motion: instant.

### Bottom pill (landing only)
A plain `div`, not a nav: the logo, bloop and a Try the demo ink pill, fixed at the bottom center (`16px + safe area`), glass (`rgba(255,255,255,.72)`, `blur(20px) saturate(1.8)`; white .92 without `backdrop-filter`, solid under reduced transparency), `--sh-pill`. Hidden and `inert` while the hero's buttons are on screen (one `IntersectionObserver`); shows over 550 ms `--ease-spring`, hides over 300 ms ease-in.

### Status chip, file row, footer
- **Status chip** (`/s` only): white pill with a hairline, 32 tall, 14/600, text only: Scanned; Lucide `check` then Approved (On Screen on the demo result); Lucide `wifi-off` then Offline.
- **File row** (phone): in a white card list with inset hairlines. Row 60 tall: Lucide `presentation` in `--muted`; the name 17/600, one line, middle ellipsis; "Edited 10 min ago" 14 `--muted`; a 24 px tick, ink with a paper check when selected, a `--g2` ring when not.
- **Footer**: a top hairline, the logo and bloop at the start, the links at the end in `--muted` 15 px, 44 px rows; wraps on a phone.

## 7. Screens

### Screen page (`/s`, the room PC), 1440 and up
- No site header (a kiosk page); the logo and wordmark top left at 32 inset; status chip top right.
- Left: the QR panel (a white card, quiet zone inside) at 50 percent of the viewport height. Right, 72 px away, vertically centered: heading 54, line 26 `--muted`, the refresh capsule (a 48 x 6 pill whose ink fill grows linearly over the code's 60 s, `aria-hidden`, no seconds counter), then "Can't scan? On your phone, go to {host}/code and enter" with the typed code at 34 px 600.
- Footer line in every state: "Phone not with you? Sign in to this PC as usual." 17 px `--muted`. None on a demo screen, which has no PC to sign in to.
- Demo result: the slides centered, as wide as the window allows while the heading and End stay on screen; the heading, line and End below them, left-aligned to the slides' edge.
- 834: stacked, QR first. Under 600: no QR; "Open this on the room's screen." (32) / "Then scan its code with your phone." (lead 19) / Enter a Code; no status chip and no footer. A demo screen (`/s?mode=demo`) runs under 600 too, with no QR: the visitor approves on the same device.

| State | Heading | Line | Controls |
|---|---|---|---|
| waiting | Room 2.14 (or "Unregistered screen") `[V-7]` | Scan with your phone camera to present your slides. | none |
| waiting, demo | Demo room | Scan with your phone camera, or approve on this device. | Approve on This Device (secondary, a same-tab link to `/a?c=` the code) |
| scanned | Check your phone. | It should show 42. (QR at .12, match code 120 px over it, chip Scanned) | none |
| choosing | Check your phone. | Choose a file, then tap Approve. | none |
| approved | Approved. | Opening Lecture 4.pptx. (64 px check for 400 ms) | End (secondary) |
| opening | Opening Lecture 4.pptx | in PowerPoint on this PC. | End (secondary); Download It Instead (text, after 5 s); Open (primary) only when the launch had no user gesture or a popup was blocked |
| open | Lecture 4.pptx is open in PowerPoint. (only after a PowerPoint launch; otherwise "Lecture 4.pptx is open.") | Ends by itself at 11:35. `[V-2]` | End (secondary), Download It Instead |
| demo result, sample deck (approved to open) | Sample deck.pptx | On a room PC this opens in PowerPoint. | the slides in the page (click or arrow keys, Full Screen), End |
| demo result, guest file | Your file reached the screen. | On a room PC it opens in PowerPoint. (a PDF: "On a room PC it opens as a PDF.") | a card with the file's name and size, Download (once the file was fetched), End |
| open fallback | PowerPoint didn't open. | Download the file, then open it from Downloads. | Download, Show as PDF Instead (text), End |
| PDF fallback | Showing Lecture 4.pptx as a PDF. | PowerPoint can't open it on this PC. Animations and videos won't play. | End |
| PDF file | Lecture 4.pdf | Opened as a PDF. (the file is a PDF, so nothing failed) | End |
| guest file open | Talk.pptx is open in PowerPoint. | bloop deletes its copy when this ends at 11:35. `[V-5]` | End |
| ended | Ended. | Scan the new code to present. (QR returns after 3 s) | none |
| expired | no change: the code already refreshed; the phone explains | | |
| offline | This screen is offline. | Reconnecting. After 5 s add: Sign in to this PC as usual to open your slides. | none (retry 5 s, backing off to 30 s) |
| service down | bloop isn't responding. | Sign in to this PC as usual. | none |
| rate limited (creating the screen was refused, `rate_limited`) | Too many demos open right now. (`/s?mode=demo`); Too many screens started here. (live) | Try again in a few minutes. | none (retries by itself: 5 s, 10 s, then every 30 s) |
| error | Unable to open Lecture 4.pptx. | Try again on your phone, or sign in to this PC as usual. | none (new QR after 5 s) |

Each heading change is announced in a `role="status"` region; error uses `role="alert"`.

### Phone page (`/a`, opened by the camera), 390
Top to bottom: the logo and wordmark, 17 px, centered; title 28/34 600; room row (Lucide `monitor` 24, room name 17 px 600, second line 14 `--muted` "Registered screen" `[V-7]`); match code (label "Code on the screen", digits 48 px 600 tabular, "Check it matches the screen."); the file group; the scope line with Lucide `lock` 14; stacked actions above `env(safe-area-inset-bottom)`. On a computer the page sits in a 440 px centered column under "This page is meant for your phone. You can approve here too."

| State | Title | Body | Buttons |
|---|---|---|---|
| checking | (skeleton title bar) | Checking the code | none |
| match | Open slides on this screen? | Room 2.14, Lectern PC. Code on the screen: 42. Check it matches the screen. | continues to choose |
| choose file | Choose your slides. | Your recent slides (file rows) | a tick selects one |
| approve | Open Lecture 4.pptx on Room 2.14? | Only this file goes to the screen. The screen never gets your account. `[V-4]` | Approve, Cancel |
| approve, demo | Open Sample deck.pptx here? | This is a demo. You don't need an account. | Approve, Cancel |
| unregistered screen | as approve, plus one card (Lucide `triangle-alert` 20, sentence in `--ink` 600; no tint, no stripe) | This screen isn't registered. Only approve if you can see it in front of you. `[V-7]` | Approve, Cancel |
| (any of choose file, approve, unregistered screen, signed in to OneDrive) | as that state | as that state | plus Disconnect OneDrive (text): deletes bloop's stored access and signs this phone out, then shows first use |
| (any of choose file, approve, approve demo, unregistered screen, first use, empty) | as that state | as that state | plus Send a File Instead (text, before Disconnect OneDrive): the guest path, for a phone with no OneDrive to choose from `[V-10]` |
| first use | Connect your OneDrive. | bloop reads your slides from OneDrive. You do this once, on this phone. `[V-9]` | Connect OneDrive, Cancel |
| needs admin | Your organization needs to approve bloop. | Ask your IT team, or sign in to the PC as usual. | Done |
| sign-in declined (`/auth/callback` page) | bloop wasn't given access. | bloop can't read your slides without it. Scan the code on the screen to try again. | Enter a Code |
| sign-in failed (`/auth/callback` page: state, issuer, exchange) | Couldn't sign you in. | Scan the code on the screen to try again, or sign in to the PC as usual. | Enter a Code |
| needs admin (`/auth/callback` page) | as needs admin | as needs admin | none |
| empty | No slides found. | Save a .pptx file to OneDrive, then scan again. | Done |
| approving | | | Approving... (button loading) |
| opening | Opening on Room 2.14. | Lecture 4.pptx | End |
| open | Open on Room 2.14. | Lecture 4.pptx. Ends by itself at 11:35. `[V-2]` | End |
| (opening, open and guest sent, when this tab is also the demo screen) | as that state | as that state | See It on the Screen (primary, back to `/s?mode=demo`) first; End becomes secondary |
| open fallback | PowerPoint didn't open on the screen. | Tap Download on the screen to open it there. | End |
| PDF fallback | Showing as a PDF on Room 2.14. | PowerPoint can't open it there. Animations and videos won't play. | End |
| PDF file | Opened as a PDF on Room 2.14. | Lecture 4.pdf | End |
| ended | Ended. | The screen's link to your file has stopped working. `[V-1]` | Done |
| canceled | Canceled. | Nothing was opened on the screen. | Done |
| expired | This code has expired. | Scan the new code on the screen. | Enter a Code (text) |
| taken | This code was already used. | Scan the new code on the screen. | Enter a Code (text) |
| offline | You're offline. | Connect to Wi-Fi or mobile data, then try again. | Try Again |
| error | Unable to open your slides. | Check the file opens on your phone, then try again. | Try Again |
| guest: choose | Send a file to Room 2.14? | Choose one file from this phone. Only this file goes to the screen. | Choose File, Cancel |
| guest: confirm | Send Talk.pptx to Room 2.14? | bloop deletes its copy when this ends. `[V-5]` | Send, Cancel |
| guest: sending | Sending Talk.pptx | (progress bar) | Cancel |
| guest: file refused | This file can't be sent. | Choose a .pptx or .pdf file under {N} MB. `[V-10]` | Choose File |
| guest: sent | Sent to Room 2.14. | Open it on the screen when you're ready. | Cancel |
| guest: pass needed | Ask your host for a guest link. | Open it on this phone, then scan the code again. | Done |
| guest: off | This screen can't take files. | Sign in to the PC as usual to open your file. (the room's guest drop is switched off) | Done |
| rate limited | Too many tries. | Wait a minute, then scan the code again. | Done |
| busy (storage full, or this month's R2 operation cap reached) | bloop can't take files right now. | Try again in a few minutes, or sign in to the PC as usual. | Done |
| framed | Open this page directly to approve. | | none |

The page moves focus to the new title on each state change. "its copy" is deliberate: bloop's stored upload is deleted, but a downloaded copy on the PC is open item 1.

Typed code page (`/code`): title "Enter the code on the screen."; one field of 16 px or more, 6 characters, label "Code", `autocapitalize="characters"`, `autocomplete="one-time-code"`, `inputmode="text"`, shown in two groups of 3; Continue (primary) enabled at 6 characters; a wrong code shows "Check the code on the screen and try again." beside the field; success goes to the match state.

### IT page (`/it`)
h1 "The PC gets one file. Never an account." `[V-4]`, then the data flow ("Phone: you choose and approve", "bloop: keeps your Microsoft sign-in, encrypted", "Screen: gets one file link"), then four points:
1. The PC holds a link to one file, and the link expires.
2. Each code works once for 60 seconds, and the phone shows the room before Approve. `[V-6]`
3. Each open ends by itself after 90 minutes and is logged for IT to export. `[V-2]`
4. A downloaded copy can stay on the PC. Every room is audited, and the results are published. `[V-1]` (until V-1 passes: "A downloaded copy can stay on the PC; the table below lists what can stay.")

Then the detail table (each row `[V-5]` until the build confirms it; compact stacks every row):
| Row | Content |
|---|---|
| What the PC holds | A session ID and a link to one file, in the browser's session storage. The link expires. While the file is open, PowerPoint holds the copy it opened. PowerPoint may also get a Microsoft download link for the file, which can work for up to 1 hour. (Last sentence: redirect mode only, threat model OPEN-03; delete it in stream mode.) |
| What bloop keeps | Your email, a OneDrive token, the ID of one folder, and a log of who opened which file where and when. No slide content, except a guest's upload, deleted when its session ends. |
| Permissions | bloop asks for read access to OneDrive. Microsoft grants that for the whole OneDrive; bloop reads one folder and logs every read. Where your tenant allows it, the app folder limits access at Microsoft's side, but then only files in that folder appear. |
| What can stay on the PC | A downloaded copy in Downloads and the file name in recent lists, until the profile is wiped. Each room is audited; results are published per room. `[V-1]` (the last sentence ships only once V-1 passes) |
| Threat model | QR relay: the phone shows the room name and a match code before Approve. Shoulder surfing: the code works once and lasts 60 seconds. Forgotten session: it ends by itself after 90 minutes. Wrong screen: unregistered screens carry a warning. Lost phone: disconnect bloop from any device. |
| Revoking access | The user disconnects bloop; an admin removes the app in Entra. |
| Status | No external audit yet. The source is public. Report a security issue: security.txt. |

The data flow is an ordered list of three white cards (one row from 768).

### Privacy notice (`/privacy`, draft until the legal lane, OD-5)
`noindex`; same header and footer as `/it`. The retention rows restate `docs/threat-model.md` section 10; change both together.
| Slot | String |
|---|---|
| h1 | Privacy notice |
| Draft line | This notice is a draft until bloop's legal review. |
| Who is responsible | bloop runs this service. Write to {privacy address} with any question about your data. |
| What bloop keeps, and for how long (table) | Your email and account ID: While you stay connected, then 30 days. / Your OneDrive access, encrypted: Until you disconnect, or after 30 days unused. / A log of who opened which file, in which room, and when: 180 days. For the demo, 7 days. / A guest's file: Deleted when the talk ends, and after 1 day at most. / Your phone's sign-in: 30 days unused, 90 days at most. / Usage counts, with no names: 90 days, then daily totals for 2 years. |
| After the table | bloop keeps no slide content from your OneDrive. A guest's file is the one exception, and it is deleted when the talk ends. `[V-5]` |
| Why | To open the file you approve on the screen you choose, to keep the service safe, and to give your organization's IT team a record of what was opened where. |
| Where | Your data is stored in the EU on Cloudflare. Cloudflare is a US company, and each request is handled at its nearest data center. (threat model DATA-03: never "UK only" or "never leaves") |
| Your choices | Disconnect OneDrive on your phone at any time, and bloop deletes its stored access. To see or erase what bloop holds about you, write to the address above. Your organization's admin can remove bloop in Microsoft Entra. |

`/.well-known/security.txt` (RFC 9116): `Contact` (a role address), `Expires` (at most a year ahead), `Preferred-Languages: en`. The placeholder addresses and their owner steps are in `docs/setup.md`.

## 8. Motion

One language: `--ease-out` for anything that appears or moves, `--ease-ui` for presses, linear for progress and opacity dips. Only `transform` and `opacity` animate, plus the FAQ's height.

| What | When | Duration | Easing |
|---|---|---|---|
| press | input | 150 ms | `--ease-ui` |
| reel entrance | load | rise 16 px over 900 ms, 200 ms delay | `--ease-out` |
| reel clock | while in view and not paused | 12 s loop | per section 6 |
| reel tilt | scroll | scroll-linked | linear |
| FAQ open, close | toggle | 380 ms height, 250 ms fade, 300 ms "+" turn | `--ease-out` |
| pill show, hide | hero buttons leave or enter view | 550 ms; 300 ms | `--ease-spring`; ease-in |
| QR refresh | every 60 s | 150 ms out, 150 ms in | linear opacity |
| `/s` capsule | each second | 1 s | linear |

Reduced motion (`prefers-reduced-motion:reduce`): the reel shows its three still frames; the FAQ and pill switch instantly; the `/s` capsule updates in 10 s steps; the blanket rule at the end of `app.css` is the safety net. Nothing else autoplays; the QR refresh is essential (a code must expire), so it has no pause.

## 9. Logo and social image

- `public/favicon.svg` is the logo: a circle and one even-odd path for the "b" (stem, bowl and counter), traced by hand from the owner's artwork and checked against it at full size and at 16 px.
- `tools/render-og.py` renders from it: `public/og.png` (1200 x 630: the logo and wordmark, the h1 on one line at 90 px, the sub's first sentence in `--muted`, on paper) and `public/apple-touch-icon.png` (180 px, the mark on paper, since iOS fills transparency with black). `tools/og.svg` is the editable source of the OG image.
- `og:image` and `og:url` are absolute URLs on the production host.

## 10. The QR

| Item | Spec |
|---|---|
| Library | an established generator, not a custom encoder: uqr 0.1.3 (MIT, an ESM port of Nayuki's generator; `encode(text, {ecc:'M', minVersion:4, maxVersion:4, border:4})` returns the matrix, drawn as one SVG path); 7.8 KB gzip unminified, in the JS budget; qrcode-generator is the alternative |
| Content | `https://{host}/a?c={code}`: the 6-character pairing code, in the query because camera apps may drop a fragment `[V-12]`. The phone strips it with `history.replaceState` when its modules load. The query can reach request logs and a Referer, which is bounded: a code works once and lives 60 seconds (10 s grace) |
| Mode, version | byte mode, level M, pinned to version 4 (33 x 33 modules) so the size never jumps |
| Quiet zone | 4 modules each side, inside the white panel: 41 modules across |
| Rendering | integer device pixels per module, `shape-rendering:crispEdges`, no CSS scaling after layout, square modules, #1D1D1F on #FFFFFF (the reel's drawn QR uses `--ink`), never inverted, no logo, no rounded or colored modules, never animated while shown |
| Screen size | module = `floor(0.5 * viewport height * DPR / 41)` device px; 1080p: 13 px, 533 px wide; 1366 x 768: 9 px, 369 px |
| Refresh | every 60 s; next code fetched at 50 s; the old code fades to white over `--d1`, then the new one in; the old code stays valid 10 s; a scanned code locks to that phone, which then has 2 minutes to approve |
| Match code | 2 digits, 10 to 99, on the screen after a scan (120 px on `/s`) and on the phone (48 px); compared, not typed |
| Typed fallback | 6 characters of uppercase Crockford base32 in two groups of 3 ("K7M Q9X"), rotating with the QR, entered at `{host}/code`; on `/s` only, never on the landing |
| Accessibility | `role="img"`, `aria-label="QR code. Scan it with your phone camera to open bloop. Or enter the code K 7 M, Q 9 X at {host} slash code."`; the label updates silently |

Size by distance (width = distance / 8, a floor to confirm on site, open item 6): at 1080p a 65 inch display (0.75 mm/px) needs 167, 333 and 500 px at 1, 2 and 3 m; a 2.5 m wide projection (1.3 mm/px) needs 96, 192 and 288 px; a 24 inch monitor serves about 1.5 m. The 533 px default covers a 65 inch display to about 3.2 m and a projection to about 5.5 m.

## 11. Page performance

Stack and system architecture: `docs/architecture.md` and `docs/adr/`.

### Loading order (every page)
1. HTML with the one CSS `<link>` in the head; no inline styles or scripts (the CSP forbids them).
2. Font preload for the one subset; the metric-matched fallback means the swap shifts nothing.
3. `<script type="module">`, deferred by default: `site.js` on the landing only; the task pages' own modules.
4. The reel is inline SVG in the HTML with its box reserved by the SVG's aspect, so it shifts nothing and needs no request.

### Budgets (internal targets; Google's "good" lines in brackets)
| Metric | Landing | `/s` | `/a` |
|---|---|---|---|
| First-view requests | 5 or fewer (HTML, CSS, font, site.js, favicon) | 6 or fewer | 5 or fewer |
| CSS, font, browser JS, landing JS | the `size-limit` entries in `package.json`, the only owner | same | same |
| LCP | 1.2 s desktop, 1.8 s on slow 4G [2.5 s] | 1.5 s | 1.5 s on 4G |
| CLS | 0.02 [0.1] | 0 | 0.02 |
| INP | 100 ms [200 ms] | 100 ms | 100 ms |

## 12. Accessibility

### Contrast pairs
| Pair | Ratio | Use |
|---|---|---|
| `--ink` on `--paper` / white | 15.6 / 17.0:1 | text, pill labels inverted |
| `--paper` on `--ink` | 15.6:1 | primary pill label |
| `--muted` on `--paper` / white | 4.75 / 5.2:1 | secondary text |
| `--g2` on `--paper` | 2.3:1 | rings only (the outline pill's label is ink), never text |
| QR #1E1E1C on white | 17.0:1 | modules |

### Rules
| Topic | Rule |
|---|---|
| Targets | 48 px buttons; 44 minimum for any hit area (header and pill buttons, footer links, the pause button, FAQ summaries) |
| Focus | the ink ring on every interactive element; never on hidden UI (the hidden pill is `inert` and `visibility:hidden`) |
| Keyboard | "Skip to Content" first; Tab follows reading order; summaries toggle with Enter and Space; Enter on `/a` activates Approve only when it is focused |
| Live regions | the `/s` heading in `role="status" aria-live="polite"`; failures `role="alert"`; `/a` moves focus to the new title |
| QR | label in section 10; the match code is announced with the scanned state |
| Images | logos are `alt=""` beside the visible name; the reel is one labeled image |
| Language and zoom | `<html lang="en-US">`; zoom never disabled; holds at 200 percent and reflows to 320 CSS px |
| Forms | the code field has a visible label, 16 px or more, errors beside it in text plus icon |

## 13. Quality bar (checklist for every screen)

A screen is done when every box passes; `test/unit/site-pages.test.ts` and `test/e2e/landing.spec.ts` check the measurable ones.

- [ ] **Hero:** at most 40 words; the h1 one sentence of at most 6 words on one line at every width; the sub names the phone, the screen and the file in at most 2 sentences and 30 words.
- [ ] **Whole landing:** 80 to 180 words, FAQ answers included; every sentence at most 20 words; at most 4 FAQ items; every heading at most 8 words.
- [ ] **Try the demo** is in the first view and opens `/s?mode=demo`; Get early access is a `mailto:`.
- [ ] **Pill:** hidden over the hero's buttons; never covers the footer; not a `nav`.
- [ ] **Reel:** one labeled image; a pause control; three captioned stills under reduced motion; flat at rest.
- [ ] **Never-say grep:** no hit from `tools/never-say.txt` in any page or string; no nothing-stays, no sign-in-is-gone, no runs-everywhere, no freshness claim.
- [ ] **Mobile (390):** no horizontal scroll, targets at least 44 px.
- [ ] **Contrast:** WCAG AA on every text and control; axe and Lighthouse accessibility 1.0 in CI.
- [ ] **Budgets:** section 11.
- [ ] **No tells:** no gradient, glow or glossy button; no eyebrow or mono kicker; no two-tone headline; no status dots or tinted icons; no glass except the pill; no fake logos, testimonials or counts; no em or en dashes, exclamation marks or emoji.

### Coherence
One of each: type scale (600 and 400), card (flat white on paper), button shape (the pill in three roles), radius logic, shadow recipe (three lifted things), motion language, icon style (Lucide, stroke 2), illustration language (the reel's flat devices). One voice (section 3); the same sentence for the same claim on every page.

## 14. Inspiration and credits

Nothing is copied (no copy, assets, fonts or code); each lesson is restated in bloop's own system.
| Site | Taken | Avoided |
|---|---|---|
| ample.computer | the paper and ink palette, the type scale, ink and outline pills, white FAQ cards, the bottom pill hidden over the hero's buttons | its long scroll stories |
| opsis.app | a reel of real UI under a plain h1 and sub, its camera push and scroll tilt; the glass pill | its density, its glossy gradient buttons, a FAQ that jumps |

Font: Inter (SIL OFL 1.1), subset from the official `InterVariable.woff2`, license shipped with it.

## 15. Open items (settle during the build)

| # | Item | Fallback until settled |
|---|---|---|
| 1 | What the PC still holds after End (expired link, open PowerPoint window, Downloads copy, recent lists), per room | `/a` ended shows "Ended." only; `/it` point 4 becomes "The IT page lists what can stay on the PC." |
| 2 | Automatic end after 90 minutes; End from phone and screen | drop "after 90 minutes" and the "Ends by itself" lines |
| 3 | A file edited minutes earlier opens as edited | no copy promises freshness either way |
| 4 | The screen holds only a session ID and one short-lived file link; the account never reaches it | the sub ends at "It opens in seconds."; the FAQ's "never your account" and the approve line dropped |
| 5 | bloop stores no slide content except guest uploads, deleted at the end; what bloop keeps and how long | the "deletes its copy" lines dropped; `/it` rows hidden |
| 6 | QR scan distance and module size on real displays at 1, 2 and 3 m; 60 s life; 10 s grace | keep the spec |
| 7 | Room registration, room name format, unregistered warning | "This screen" as the room name |
| 8 | Opening in installed PowerPoint (Protected View, download blocks, license prompts); the PDF fallback | Download It Instead visible from the start |
| 9 | Phone account needs (connect once, admin consent, sign-in lifetime) | first-use body "bloop reads your slides from OneDrive." |
| 10 | Guest flow and its file size limit `{N}` | the guest states removed |
| 11 | Inter subset size with `opsz` kept (settled: 44,268 bytes, within its `size-limit` entry, `opsz` kept); fallback metrics measured against it (open: needs a browser) | keep the starting metrics |
| 12 | Camera apps keep the `?c=` query (iOS, Android, common in-app scanners); the log and Referer exposure of a one-use 60 s code | move the code into a path on the API origin |
| 13 | Final name, host and a public role address | keep `SITE_NAME` and `{host}` placeholders out of production |
| 14 | API origin; WebSocket allowed on campus networks | long-polling every 2 s |
| 15 | Clickjacking of `/a` without `frame-ancestors` | the JS frame guard (the framed state) |
| 17 | Demo flow: the phone's demo path, the sample deck, rate limits | the demo states as written |
| 18 | Match code as compare-only passes a security review | as written |
| 19 | The hero passes a 5-second test with 5 people ("you scan the screen with your phone and your slides open, and the screen never gets your account") | rewrite the sub, not the layout |
| 20 | Free early access wording makes no commercial offer | the FAQ answer becomes "Early access is open." |
| 22 | uqr minified gzip size; its version 4, level M codes read by two phone cameras | qrcode-generator |
| 25 | "Any screen" needs its condition visible | the FAQ install answer names the browser and PowerPoint |
| 26 | One casing for labels: the site uses sentence case ("Try the demo"), the app pages Title Case (`copy.js`) | both, as now |
