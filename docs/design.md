# bloop design

The one source of truth for bloop's brand, visual design, UI and UX. The system is a calm paper-and-ink one modeled on ample.computer, with opsis.app's top glass nav, tilted hero stage, bento and list card; nothing from either site is copied (section 14). Strings marked `[V-n]` depend on an unverified product property: ship the string only once open item n (section 15) passes, otherwise ship the fallback given there. Every screen passes the checklist in section 13 before it is called done.

## 1. Brand

### Idea
bloop puts your slides on a shared screen. You scan the code on the screen, choose your file on your phone and tap Approve; it opens on the screen, and your account stays on your phone. The brand is the calm of a handover that just works: a quiet paper page, ink type, one live code. The less on the site, the better: every element earns its place.

### Name and logo
| Rule | Value |
|---|---|
| Logo | a dark grey lowercase "b" (#646464) over a pastel orange circle (#F4BA8B), drawn as two paths in `public/favicon.svg` (no text, no embedded image); the same file is the favicon, the nav and footer mark, and the source of the touch icon and OG image (section 9). The gray is the owner's artwork's own value (checked against it), not a rendering bug |
| Wordmark | the word `bloop` beside the logo, lowercase, Inter 600, tracking -0.03em, `--ink` |
| Name-swappable | one build constant (`SITE_NAME`) in every page, title, meta tag and string; baked only into the OG image, which a script regenerates |
| In sentences | lowercase `bloop`, even at the start of a sentence |
| Never | the logo's gray in CSS (its orange only as `--robin`, named once), a gradient on the logo, a period after the wordmark, the name inside the QR |

## 2. Principles

| # | Principle | Test |
|---|---|---|
| 1 | Calming first. Light only, paper and ink; one accent, robin orange (the logo's disc), only in the site's top wash, the hero glow and the name in body copy. | Squint: only the ink pills, the logo and the warm top of the page stand out. |
| 2 | Far less text. One-line headlines, one plain sub, a short FAQ. | Section 13 word caps pass. |
| 3 | Relevant. Every element is about the handover (code, phone, approval, file, screen). | Delete any element that would make sense on another product's page. |
| 4 | Looks finished. Real copy, real states, real product UI as HTML chips. | No lorem and no unstyled state; "Coming soon" only on the hero stage and the provider list, where it is the truth. |
| 5 | Concentric geometry. Inner radius = outer radius minus inset. | Every nested corner passes the formula in section 4. |
| 6 | Coherence over collage. Each borrowed pattern is restated in this one system or dropped. | Section 13 coherence list passes. |

## 3. Voice and copy

### Rules
| Rule | Example |
|---|---|
| Headings, page titles and labels in Title Case with no period; no second clause in grey. Title Case keeps a, an, the, and, but, or, nor, for, as, at, by, in, of, on, to and with lowercase after the first word, and `bloop` always lowercase. | "Present Anywhere", "You Stay in Charge" |
| Headlines at most 8 words; one sentence of at most 20 words (section 13). | |
| Lead with slides for lecturers; security leads only for IT. | |
| Security as concrete never-statements: actor, verb, specific thing. "X, never Y" is allowed; "not X, but Y" is not. | "One file, never an account." |
| Conditions go in a footnote or on `/security`, never into the marketing sentence. "Present Anywhere" is the one claim of reach; the FAQ names its condition (a web browser on the screen, open item 25). | |
| Plain beats clever: no puns, no analogy on the landing, no unexplained noun. | |
| "session", "token" and "tenant" stay off every user-facing screen; only `/security` may use them. One exception by the owner's ruling: the room screen's "Session Ended" (`SESSION_ENDED` in `copy.js`). | "End", "Ended." |
| Contractions yes. Never "we", "our team", "oops", "uh-oh". | |
| Errors: what happened, no blame, what to do, one verb button. | "Unable to open your slides." |
| Digits for all numbers, units tight: 60 s, 90 minutes, 1 file. | |
| Sentences in sentence case with a period. Labels (buttons, status pills, the stage line) are Title Case on every page, site and app alike (open item 26, settled). Questions in the FAQ are sentences. | "Try the Demo"; "Approve on This Device" |
| In body copy, the name is `<b class="name">bloop</b>`: 600 in `--robin-ink`. Not in headings, the wordmark, the legal line or an address. | "**bloop** can share these today." |
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
| `<title>` landing | bloop: Present Anywhere |
| meta and OG description | Scan the code on the screen to present or download your files. Your account stays on your phone. |
| `<title>` `/security`, `/s`, `/a` | bloop Security; bloop screen; Approve on bloop |
| `<title>` `/privacy`, 404 | bloop Privacy Notice; bloop: Page Not Found |
| OG image alt | bloop: Present Anywhere (`public/og.png` must show the same h1; `tools/render-og.py` renders it) |

**Site chrome (every site page, the same markup; a unit test holds them equal)**
| Slot | String |
|---|---|
| Nav | the logo pill, the logo and bloop (home); the links pill: Features (`/#features`), Privacy, Security, Waitlist, and the menu button, labeled Menu, under 640 |
| Waitlist | every Waitlist link is `mailto:` the early access address with `data-waitlist`, so one grep swaps in the form URL |
| Footer | the logo and bloop; "**Present anywhere.** **bloop** puts your files on a shared screen from your phone. The screen gets only the items you approve, never your account." (the tagline stays a sentence: it is body copy); Privacy, Security, Waitlist; a rule; © 2026 bloop. No Source link. |
| 404 | This Page Isn't Here / Check the address, or go to the home page. / button Go to the Home Page |

**Landing**
| Slot | String |
|---|---|
| h1 | Present Anywhere ("Anywhere" carries the glow, section 8) |
| Sub | Scan the code on the screen to present or download your files. Your account stays on your phone. `[V-4]` |
| Action | Try the Demo with a trailing Iconic `arrow-right` (ink pill, `/s?mode=demo`), the hero's only button |
| Stage | Demo Video Coming Soon |
| Features h2 | You Stay in Charge |
| Bento cards (title / line / chips) | Works with Your Storage / Choose from the files you already keep. / OneDrive, Dropbox, Google Drive, Box (tags). Approve with One Tap / The screen gets only the items you approve. / Cancel, Approve. End or Revoke Any Time / One tap on your phone takes your files off the screen. / "Ends in 59:12" (text), Revoke. Present or Download / Show your file full screen, or save a copy. / Present (white), Download (ink) |
| Connect h2, line | Connect Your Files / **bloop** can share these today. |
| What You Can Share (status Available) | PowerPoint, PDF, Images, Links, each with its Iconic glyph (`projector`, `file-text`, `photo`, `link`) |
| Where Your Files Live (status Coming Soon) | Microsoft OneDrive, Dropbox, Google Drive, Box, by name only (section 6, Icons); a provider moves to its own "Available" only once its path is live in a real account; no iCloud |
| FAQ heading | Questions |
| What is bloop? | A way to present your files from your phone on a shared screen, such as a lecture room PC. The screen gets only the items you approve. `[V-4]` |
| Do I need to install anything? | No. The screen runs **bloop** in its web browser, and your phone uses its camera. Slides open in PowerPoint on the room PC. `[V-8]` |
| What does the room PC keep? | A link to each item you open, never your account. A downloaded copy or a file name in recent lists can stay until the PC's profile is wiped. See what can stay. (links to `/security`; threat model RES-02: never a nothing-stays claim) |
| Is it free? | Yes. Early access is free while **bloop** is being tested. `[V-20]` |
| No JavaScript | `/s` "This screen needs JavaScript to show a code."; `/a` "Approving needs JavaScript. Turn it on, then scan again." The site needs none: the menu is a popover, the tilt falls back to CSS, the FAQ is native. |

State strings for `/s` and `/a` are in section 7 with their screens.

## 4. Tokens

Tokens live in `public/css/app.css` `:root`; this list restates them, and the drift test holds the two equal. Light only (`color-scheme:light`).

### Color
| Token | Use |
|---|---|
| `--paper:#f3f3f0` | page ground everywhere |
| `--surface:#ffffff` | cards: FAQ items, the QR card and the house frame (section 6), the stage frame, item lists, the warn card, the provider list, the panel rows, chips |
| `--ink:#1e1e1c` | text, primary pills, the tick, an on toggle, the active page dot, the progress fill and the QR ring, the focus ring |
| `--ink-2:#3a3a36` | the nav's Waitlist pill (solid, never a gradient), nav links, text on a tinted card, the stage's line |
| `--muted:#6c6c66` | secondary text (4.75:1 on paper); never on a pastel |
| `--g2:#a3a39c` | the outline pill's ring, the empty tick ring, field rings; never text |
| `--g1:#dcdcd7` | skeletons, the progress track, page dots, the selected sidebar row, the sheet grab bar, the hero stage, an off toggle |
| `--hairline:rgba(0,0,0,.08)` | rules and card rings, drawn as `box-shadow`, never a border; row hover and press |
| `--sky:#cfe0e8` `--butter:#f6e7b2` `--lav:#d8d1ef` `--sage:#dde3d6` | solid tints, site pages only, never a gradient: one per bento card (sky, butter, lavender, sage in reading order); sky for the Connect panel and the panel on `/privacy` and `/security`. Text on a tint is `--ink` or `--ink-2` |
| `--robin:#f4ba8b` | the logo's disc, the one accent: the site's top wash and the hero glow, always at partial alpha through `color-mix`; never text, never a fill |
| `--robin-ink:#a64f15` | the robin at text strength: the name in body copy (5.0:1 on paper, 5.6:1 on white) |
| `--lead:#62625c` | the hero and page leads, which sit on the robin wash: 4.86:1 where the wash is strongest under text (`--muted` falls to 4.2:1 there) |

Status colors (`--ok`, `--warn`, `--err`) are not used: a state is a sentence plus the object changing.

### Type
- `--font:"Inter","Inter Fallback",Arial,sans-serif`, self-hosted, 400 and 600 only. Body 17/1.5, -0.011em.
- `@font-face` "Inter" from `/fonts/inter-latin.woff2` (`tools/subset-font.py` from `src/fonts/InterVariable.woff2`, `opsz` kept), `font-weight:400 600`, `font-display:swap`, the Latin `unicode-range` (U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD). "Inter Fallback": `local("Arial")`, `size-adjust:107.1%`, `ascent-override:90.4%`, `descent-override:22.5%`, `line-gap-override:0%` (open item 11).

| Role | Size | Line height | Tracking | Weight |
|---|---|---|---|---|
| hero h1 | `min(112px, (100vw - 2 * var(--pad)) / 10)`: one line at every width | 1 | -0.05em | 600 |
| section h2 (landing), `/security` and `/privacy` h1 | 38, 54 from 768 | 1.04 | -0.035em | 600 |
| card title | 22 | 1.2 | -0.025em | 600 |
| hero sub, page lead | 20, 24 from 768, `--lead`, max 640 | 1.35 | -0.015em | 400 |
| `/s` heading (the room, a state; 22 and one line over the stage), line | 28; 19 `--muted` | 1.2; 1.5 | -0.025em | 600; 400 |
| phone title, centered | 28 | 1.2 | -0.025em | 600 |
| item name; group label | 17; 14 `--muted` | 1.3; 1.45 | | 600 |
| FAQ question, answer | 17 600; 16 `--muted` | 1.5; 1.6 | | |
| button | 16 (15 in the nav and on chips) | 1 | -0.01em | 600 |
| nav link | 15 `--ink-2`, 400 (the current page's link `--ink` on its selected pill; same weight, so no link shifts) | 1.5 | | 400 |
| small | 14 `--muted` | 1.45 | | 400 |
| codes (typed code, match digits) | context size, `tabular-nums` | 1 | +0.04 to 0.06em | 600 |

Headings `text-wrap:balance`; no mono, no eyebrow, no uppercase label, no grey second clause in a headline.

### Radii, shadows, motion, layout
| Token | Use |
|---|---|
| `--r-chip:8px` | skeletons, the summary focus ring |
| `--r-field:14px` | the code field, the stage frame, the menu sheet's rows |
| `--r-card:20px` | every white card, the house frame, the floating sidebar, the phone's grouped lists; a row inside is `--r-card` - 6, its 40 px thumbnail `--r-card` - 16 (concentric, section 6) |
| `--r-stage:28px` | the hero stage (16 under 640), bento cards, the privacy and security panel, the QR card and its ring |
| `--r-sheet:24px` | the top corners of the viewer's bottom sheet |
| `--r-pill:9999px` | buttons, chips, the nav pill, toggles |
| `--sh-frame:0 0 0 1px rgba(0,0,0,.06),0 30px 60px -30px rgba(0,0,0,.35)` | the viewer's page or picture, the QR card |
| `--sh-nav:0 0 0 0.5px rgba(0,0,0,.08),0 4px 18px rgba(0,0,0,.05)` | the nav pills at the top of the page |
| `--sh-pill:0 0 0 0.5px rgba(0,0,0,.08),0 10px 30px rgba(0,0,0,.12)` | glass at rest in the app (sidebar, sheet, handle, prev and next, the page count), the nav pills once scrolled, the menu sheet, the skip link |
| `--nav-h:56px` | the height of both nav pills; every inset inside them is (56 - inner height) / 2 |
| `--side:280px` | the viewer sidebar's width |
| `--row:60px` | one item row, the viewer sidebar and the phone list alike |
| `--inset:24px` | the app's corner inset, top and side alike, so both corner controls mirror |
| `--frame-h:56px` | the house frame's height: Back, Approve on This Device, End, the code card, New Code |
| `--ease-out:cubic-bezier(.22,1,.36,1)` | the workhorse: reveals, the FAQ, the nav's scrolled look |
| `--ease-ui:cubic-bezier(.4,0,.2,1)` | press feedback |
| `--pad:24px` | page side padding; 40 from 640 |
| `--section:80px` | section rhythm; 112 from 768 |

### Glass
One recipe, named once (`.glass` in `app.css`, the nav rules use the same tokens), for every floating surface: the nav pills and their menu sheet, the viewer sidebar, its bottom sheet and handle, the prev and next buttons. Liquid, not frosted: a thin fill, a strong blur and saturation, so what passes under (the robin wash at the top of the site) tints it, as opsis's green tints its nav. No refraction, shine or animated sheen; the border is the shadow's 0.5 px ring, never a CSS border.
| Token | Use |
|---|---|
| `--glass:rgba(255,255,255,.62)` | the fill where `backdrop-filter` is supported |
| `--glass-filter:blur(24px) saturate(2)` | with `-webkit-backdrop-filter` beside it |
| `--glass-solid:rgba(255,255,255,.92)` | the fill with no `backdrop-filter` |
| `--glass-firm:rgba(255,255,255,.8)` | the nav pills once scrolled and the menu sheet (it holds text over the hero's type) |
| `--glass-edge:inset 0 1px 0 rgba(255,255,255,.7)` | the hairline highlight on the top edge, composed first in a glass surface's `box-shadow` |
| `--wash:rgba(120,120,128,.1)` | hover on nav links and icon buttons |

Reduced transparency: `--surface`, no filter. The nav eases background and shadow over 240 ms `--ease-out`; app glass enters with the shared motion only.

White cards are flat on paper with no shadow (the viewer's page, the QR card and glass are the only lifted things). Concentric rule: `r_inner = r_outer - inset`, floored at 4 px; a bar holding a pill is a pill. Content width `min(100% - 2 * --pad, 1136px)`; text columns 760. Breakpoints 640, 768, 1024; check at 390, 834 and 1440.

## 5. Layout

- One column, centered, generous space, on the robin wash: a radial of `--robin` at 50 percent alpha from the top center (70 percent of the width by 640 px, its midpoint hint at 30 percent, so it eases out with no ring) on every site page, painted on the page ground. The landing is: the nav; hero (h1, sub, one pill); the stage; Features (`#features`, the bento); Connect Your Files (the Connect panel); the FAQ; the footer. `/security`, `/privacy` and 404 get the same nav and footer around a centered page hero and white topic cards (section 6).
- The hero block (h1 to button) is centered in the first view: `min-height:100svh`, padded `--nav-h` + 40 above and below, so its middle is the viewport's and the stage starts at the fold. No entrance animation; the h1 paints in the first frame (it is the LCP element). The doc pages' hero starts 152 px down; `html` keeps 96 px of `scroll-padding-top`, so a jump to `#features` lands below the nav.
- `/s`, `/a` and `/code` are task pages with no site nav or footer.

## 6. Components

Shared states: focus is `outline:2px solid var(--ink)` on `:focus-visible`, never removed; press is `scale(.97)` over 150 ms `--ease-ui`; disabled is opacity .38; no hover color change on ink pills (the outline pill's ring darkens to ink, text buttons underline); loading swaps in a 16 px spinner with a progressive label ("Approving...").

### Buttons
| Type | Look | Use |
|---|---|---|
| primary | ink pill, paper label, 48 tall, padding 0 24 (44 under the stage) | the one action per view: Try the demo, Approve, Continue, Download, Revoke, Open vevox.com |
| waitlist | `--ink-2` pill, paper label, 44 tall, padding 0 20, 15 px | Waitlist, in the nav only |
| secondary | white pill (`--surface`), a `--hairline` ring that darkens to `--g2` on hover, ink label | Cancel, Present, Enter a Code on a narrow screen |
| text | no fill, 44 hit area | Show as PDF Instead, Add a File (only where no list ends with its row), Enter a Code |
| phone pages | 52 tall, gap 8; side by side from 640 in reading order, the primary last (Cancel then Approve; Ends in then Revoke; Revoke then See It on the Screen); stacked under 640 with the primary on top (`column-reverse`, Apple's order) | Approve, Cancel, Revoke |
| round | 44 glass circle, `--sh-pill` | prev and next on the stage, hidden (not disabled-grey) at either end |

### House frame (`.framed`)
The typed code card's look, kept exactly, for every small framed thing: white, `--r-card`, no shadow, `--frame-h` tall, padding 0 20, 17/600, an icon 24 at its start pulled 6 px in; hover adds a `--g2` ring, press scales .97, disabled is .38 with its icon turning. Users: the labeled Back pill (Iconic `arrow-left` and "Back", top left of `/s`, `/a` and `/code`; on a claimed screen it is Start Over), Approve on This Device and End (top right), the session's logo button, the code card (Iconic `copy` at its start; a click copies the code and shows `check` for 1.5 s) and New Code (a `--frame-h` square, Iconic `refresh`). The corner bar holds them at `--inset` from the top and the side, so both corners mirror.

No gradient, no gloss, no destructive variant.

### Icons
Only where an icon carries meaning at a glance: the menu button, item type tiles (`projector`, `file-text`, `photo`, `link`), the add tile (`plus`), Back (`arrow-left`), prev and next (`chevron-left`, `chevron-right`), the sheet handle (`chevron-up`), the tick (`check`), copy (`copy`), New Code (`refresh`), the warning (`warning-triangle`). Never decoration. One style: the Iconic free set (Make-Lemonade/iconicicons; free licence, any use, no attribution; Pro icons are never used), inline SVG, 24 viewBox, stroke 1.5, round caps and joins, `currentColor`, `aria-hidden` beside a visible or `aria-label` name; the original path data, never redrawn. The site uses `menu`, `arrow-right` (Try the Demo) and the kind glyphs `projector` (PowerPoint), `file-text` (PDF), `photo` (images), `link`. Provider marks: none, names only. Microsoft (OneDrive) and Box allow their marks only under a license or written permission, even for a real integration; Dropbox allows its logo only to show compatibility with a working app; Google allows the Drive logo without pre-approval only to highlight an app's integration through the Drive API. None covers a "Coming Soon" mention. When a path goes live: Dropbox and Google Drive marks may follow their kits (Google wants "Google Drive™" at first mention and our mark larger than theirs); OneDrive and Box stay names until a license exists. Names follow the brands: "Microsoft OneDrive" at first mention.

### Top nav (every site page)
`<header class="nav">`: a fixed grid row 14 px from the top (10 under 640), `min(100% - 32px, 1136px)` wide, `pointer-events` only on the pills, holding two glass pills of `--nav-h`, `--glass-edge` over `--sh-nav`:
- **Logo pill** (start of the row, outside the landmark): the logo 32 and bloop 19 px, home. Padding 0 20 0 12: 12 = (56 - 32) / 2, so the mark's disc is concentric with the pill's end.
- **Links pill**, `<nav class="nav-pill" aria-label="Primary">`, centered: padding 0 6 = (56 - 44) / 2, one gap of 4 between every item, Waitlist included. The links Features, Privacy, Security (44 tall, padding 0 16, `--ink-2`, a `--wash` pill on hover); the page's own link has `aria-current="page"` and keeps that pill with `--ink`, as the selected pill; then the Waitlist pill.
- **Scrolled:** once a 12 px sentinel at the top of the landing leaves the view (an `IntersectionObserver` in `site.js`, never a scroll listener), `is-scrolled` raises both pills to `--glass-firm` and `--sh-pill` over 240 ms `--ease-out`; no hide on scroll, no size change. Other site pages keep the resting look (they run no script).

Under 640 the row is the width less 10 px each side: the logo pill at the start, the links pill at the end holding Waitlist and a 44 px menu button (Iconic `menu`). The links list is the same element as a `popover` (`popovertarget` on the button, no script): a `--glass-firm` sheet `--nav-h` + 20 from the top, 10 px from each side, radius 22, padding 8, `--sh-pill`, rows 44 tall at 17 px, the current page's row on its pill. Light dismiss and Escape close it; on the landing a link click closes it too, so a jump to Features is not covered.

### Hero stage
A plain `--g1` panel, 16:9 (4:3 under 640), `--r-stage`, no shadow, with one centered line "Demo Video Coming Soon" in `--ink-2` 20/600, starting at the fold. Its wrapper has `perspective:2200px` from the top center. Tilt, with no reduced motion and 900 px up: `rotateX(24deg) scale(.9)` to flat over the stage's entry (the `entry` range: from its top edge showing to fully shown, or to filling the view when taller), so it rests flat once fully in view.
- **Spring (`site.js`):** the progress goes through a spring (stiffness 120, damping 30, mass .4, as opsis smooths its tilt; overdamped, no overshoot, a time constant of about a quarter second) into the `currentTime` of a paused `el.animate` of the same keyframes. The damping step is implicit, so a long frame cannot make it ring. A `requestAnimationFrame` loop runs while the spring moves and stops once settled; an `IntersectionObserver` with 1 percent thresholds wakes it, which tracks the goal because over the entry the visible share changes with it; no scroll listener and no inline style write. The script animation outranks the CSS one.
- **Fallback:** without the script, under `@supports (animation-timeline:view())`, the same keyframes on the stage's view timeline, locked to the scroll. Elsewhere it is flat and still.

### Bento (Features)
A grid of 4 cards, one column, two from 768, gap 16. Card: `--r-stage`, padding 28, min 300 tall, its solid tint (sky, butter, lavender, sage in reading order). Title 22/600, then one line in `--ink-2`, then the mock: a white screen fragment pinned to the bottom, inset 12 from the card's sides and bottom, radius 16 (28 - 12), padding 24 16, min 112 tall, `aria-hidden`, default cursor, no hover, no selection. It holds a still of the app in HTML, so the chips read as a picture, not as buttons: 40 tall pills, 15/600, white with the outline pill's ring or ink; storage names as 36 tall `--paper` tags; "Ends in 59:12" as plain `--muted` tabular text. Order as in the app (item 36): Cancel then Approve; "Ends in" then Revoke; Present (white) then Download (ink). No stock images.

### Connect panel (Connect Your Files)
Max 760. A solid sky panel, `--r-stage`, padding 12, holding two white group cards (radius 16 = 28 - 12, padding 20 20 4), side by side from 768. Each group: a head row (17/600 title, its status pill at the end), then rows 56 tall split by a hairline, 600 text. What You Can Share: Available (`--ink` on `--paper`), each row a 24 px Iconic glyph and the kind. Where Your Files Live: Coming Soon (`--muted` on `--paper`), the provider's name only. The status sits on the group, not on each row: one truth per group, and four repeated pills were noise. Status pill: padding 6 12, 14 px, `--r-pill`.

### FAQ
Native `<details>` as white `--r-card` cards, 12 apart, max 760, centered. Summary 17/600 with a `--muted` "+" that turns 45 degrees. Open and close animate the height: `::details-content` with `interpolate-size:allow-keywords` where supported (block-size 380 ms and opacity 250 ms, `--ease-out`); elsewhere a WAAPI height tween in `public/js/site.js` (find in page still opens an item). Reduced motion: instant.

### Footer (every site page)
Width 1136, a top hairline, padding 56 above. A row that wraps: at the start the logo and bloop, then the tagline in 600 `--ink` and two plain sentences in `--muted` (max 420); at the end the links in `--muted` 15 px, 44 px rows. Then a hairline rule and "© 2026 bloop" in 14 px `--muted`, 40 below the row.

### Privacy and security pages (opsis `/compare`, restated)
Content 1136 wide. A centered page hero (the h1 at the section size, an optional `.lead`), then:
- **The panel:** the Connect panel's frame (solid sky, padding 12, two white group cards at radius 16): "What the Screen Gets" (rows with an on toggle) and "What Stays on Your Phone" (rows with an off toggle), 48 under the hero. Each row 56 tall, 600 text, a 40 x 24 toggle at the end (`aria-hidden`; on is ink with the knob right, off `--g1` with the knob left). It is a picture of the split, not a control.
- **Topic cards,** 16 apart: white, `--r-stage`, padding 24 (40 from 768); from 900 two columns, `.8fr 1.2fr`, gap 48: the 24/600 h2 at the start, the prose in `--ink-2` beside it. `.topic.wide` is one column, for the retention table and for the points list on `/security`.

### Item row (the viewer sidebar and the phone list, one face: `core/rows.js`)
`--row` tall, padding 10, gap 12, inside a `--r-card` container with padding 6, so the row is `--r-card` - 6 (14) and its leading 40 px square, 10 in, `--r-card` - 16 (4), with a `--hairline` ring: a picture where one exists without a mint (page 1 of the demo deck and PDF, the demo photo's own 120 px thumbnail), else a `--paper` type tile with a 24 px ink glyph. The handle stands alone at `--r-card`, so its thumbnail is `--r-card` - 10. Separators between phone rows run from the text edge (62) to 10 from the end. Line 1 the name 17/600, one line, ellipsis in the middle so the extension stays. Line 2 14 `--muted`: the kind (PowerPoint, PDF, JPEG image, PNG image, WebP image; a link reads "Link"), then " · " and the size when the item has bytes (a link: its host), then a date only when the source gives one (a live phone: "Edited 10 min ago"; demo items show none rather than a made-up one). Files A to Z, then links.

## 7. Screens

### Screen page (`/s`, the room PC; `/s?mode=demo`, the Demo Room)
Checked at 1440, 834 and the narrowest window. Model for the viewer: the iCloud Drive web app, restated in bloop's tokens; each deviation and its reason is in "Viewer deviations" below.
- **Corner bar** (`/s`, `/a`, `/code` alike): no site header (a kiosk page). It floats over the page (absolute, `--inset` from the top and the side), so what the page holds is centered on the whole viewport; every control in it is the house frame (section 6). Top left: Back home (waiting, busy states), Back as Start Over (scanned, choosing, a guest's offer), or in a session the logo and bloop, which ends the session and then goes home. Top right: Approve on This Device (demo, waiting) or End (in a session). "Session Ended" shows nothing else.
- **Waiting, truly centered.** The QR card: white, `--r-stage`, `--sh-frame`, no padding of its own: the QR's 4-module quiet zone is the padding (the QR at half the viewport height, section 10). Its edge is the countdown: a 4 px ink stroke on the card's rounded edge (an SVG `rect`, `pathLength=100`, half outside the card, so it never touches a module) that starts at the top center and shortens toward it, clockwise, over the code's life (`stroke-dasharray` set once a second, a 1 s linear transition between steps; under reduced motion the safety net drops the transition, so it steps once a second; `aria-hidden`). Then two short lines, "Scan with your phone." / "Or enter the code at {host}/code", and the code row: the code card (house frame, Iconic `copy` at its start, the code 22/600 tabular, +0.06em) beside New Code.
  - **Wide (900 and up, landscape):** two columns, centered as a block, gap 48 to 112: the QR card on the left; on the right the room name (56 to 96 px, 600, -0.035em), the two lines at 28 px `--ink-2`, then the code row. Under that, one column: the room name 44, the card, the lines at 17 `--muted`, the code row.
  - **New Code:** ends the waiting screen (`POST /api/screen/end`, which closes a waiting screen and frees its demo slot) and creates a new one by the boot path (fresh QR, code and full ring); disabled, its arrow turning, until the new screen's view arrives; a refused create shows the rate-limited state and retries as boot does.
- **Claimed:** "Check Your Phone" over the QR card at .12, the match digits 120/600 tabular over it; no ring, no code row, no lines.
- **Busy states** (live launch states, offline, service down, rate limited, error): the heading and line centered, no QR.
- **Ended:** "Session Ended" centered alone, no bar controls; a fresh code after `ENDED_QR_RETURN_MS` (3 s; the server holds `ended` that long).
- **Footer line** on a live screen in every state: "Phone not with you? Sign in to this PC as usual." None on a demo screen, which has no PC to sign in to.
- **Under 600:** a live screen shows "Open This on the Room's Screen" (32) / "Then scan its code with your phone." / Enter a Code and starts nothing. A demo screen runs, with no QR and no "Scan with your phone.": the visitor approves on the same device.

**The viewer (`/s?mode=demo`, approved to open; `viewer.js`).** Built from the screen's view, so a reload shows it again; nothing launches.
- **Sidebar (2 items or more):** a floating glass panel, `--side` wide, under the corner bar and `--inset` from the left and bottom, `--r-card`, padding 6, `--sh-pill`, its own scroll. iCloud Drive's cues: a header "Items" (14/600 `--muted`, as its sidebar headers); item rows (section 6) as buttons; the selected row `--g1` with `aria-current`, filled ink with paper text while the list holds focus (its tint fill, in bloop's one ink), hover `--wash`, all instant. Links follow the files under one hairline from the text edge. The page column moves right of it. The stage then carries no visible name: the sidebar shows it (the h1 stays for screen readers).
- **Under 768:** the sidebar becomes a glass bottom sheet (`popover`, opened by a handle row under the actions: the current item's row, "4 items" and a chevron): full width, `max-height:min(72dvh,600px)`, `--r-sheet` top corners, a 36 x 4 `--g1` grab bar, backdrop `rgba(0,0,0,.18)`, rising from below over 300 ms `--ease-out` (`@starting-style`); light dismiss, Escape, or a pick closes it.
- **Stage:** with no sidebar, the item's name (22/600, one line, ellipsis) on top. The stage fills the height left between the corner bar and the pager and actions; the page or picture is the frame itself (`--r-field`, `--sh-frame`), at its own aspect ratio, as large as fits both ways (`max-width` and `max-height` 100% in a one-cell grid), so nothing is ever cut or letterboxed.
  - Deck or PDF (the demo account's): its pre-rendered pages (`public/img/demo-slide-*`, the same pages for both; alt "Slide 1 of 2" or "Page 1 of 2"). Under the frame one row, gap 12, one centerline: prev, the indicator, next (44 px glass circles, hidden at either end). 6 pages or fewer: 7 px dots, the current one ink; more: an "n of N" pill 32 tall, 14/600 tabular. Arrow keys and Page Up/Down step pages.
  - Image: its minted view link in an `<img>`, contained. The `<img>` is kept for the session and dropped at the end: the CSP has no `blob:`, and a second mint would spend the item's budget. Until the link arrives the stage is empty; a refused mint shows the card.
  - Link: a white card, max 440, `--r-card`, padding 32, centered in the stage: the type tile, the host 22/600, the title 14 `--muted`, and "Open vevox.com" (primary, `target="_blank"`, `rel="noopener noreferrer"`, https only). Never a frame.
  - A guest's own file (no pages, no view): the same card with its kind and size.
- **Actions,** one centered row under the stage, gap 8, 44 tall, only those that apply: Present (secondary, white; full screen of the stage on ink, for pages and a loaded image, where the browser allows it) then Download (primary, ink; a file once the session has left `approved`; it mints that item's download link, or restarts one it started under a minute ago).
- **One item:** no sidebar and no handle; a lone deck or PDF is stage plus pager and actions, a lone image the stage and its actions, a lone link the centered card.

| State | Heading | Line | Controls |
|---|---|---|---|
| waiting | Room 2.14 (or "Unregistered screen") `[V-7]`; Demo Room | (the code card and its line) | demo: Approve on This Device (a same-tab link to `/a?c=` the code) |
| scanned, choosing | Check Your Phone | It should show 42. (for screen readers only: the digits are on the QR card) | Back = Start Over |
| approved (live) | Approved | Opening Lecture 4.pptx. | End |
| opening (live) | Opening Lecture 4.pptx | In PowerPoint on this PC. | End; Download It Instead (after 5 s); Open (primary) only when the launch had no user gesture or a popup was blocked |
| open (live) | Lecture 4.pptx Is Open in PowerPoint (only after a PowerPoint launch; otherwise "Lecture 4.pptx Is Open") | Ends by itself at 11:35. `[V-2]` | End, Download It Instead |
| demo, approved to open | the item on the stage | (the viewer) | End; Present, Download as they apply |
| open fallback | PowerPoint Didn't Open | Download the file, then open it from Downloads. | Download, Show as PDF Instead (text), End |
| PDF fallback | Showing Lecture 4.pptx as a PDF | PowerPoint can't open it on this PC. Animations and videos won't play. | End |
| PDF file | Lecture 4.pdf | Opened as a PDF. (the file is a PDF, so nothing failed) | End |
| guest offer | Talk.pptx | Sent by a guest. Open it here when you're ready. | Open, Back = Start Over |
| guest file open (live) | Talk.pptx Is Open in PowerPoint | bloop deletes its copy when this ends at 11:35. `[V-5]` | End |
| ended | Session Ended | | none |
| expired | no change: the code already refreshed; the phone explains | | |
| offline | This Screen Is Offline | Reconnecting. After 5 s add: Sign in to this PC as usual to open your slides. | none (retry 5 s, backing off to 30 s) |
| service down | bloop Isn't Responding | Sign in to this PC as usual. | none |
| rate limited (creating the screen was refused, `rate_limited`) | Too Many Demos Open Right Now (`/s?mode=demo`); Too Many Screens Started Here (live) | Try again in a few minutes. | none (retries by itself: 5 s, 10 s, then every 30 s) |
| error | Unable to Open Lecture 4.pptx | Try again on your phone, or sign in to this PC as usual. | none (new QR after 5 s) |

Each heading change is announced in a `role="status"` region; error uses `role="alert"`. A live screen keeps its PowerPoint launch ladder; the viewer is the demo's.

**Viewer deviations from the iCloud Drive model (each with its reason)**
| bloop | iCloud Drive | Why |
|---|---|---|
| floating glass sidebar, 280 wide, at `--inset` | flat full-height pane, 250, 1 px divider | the owner's ruling: one glass across the product; wider because rows carry larger type read from across a room |
| 60 px two-line rows, 40 px thumbnails, name 17/600 | 32 px one-line rows, 20 px glyphs; list rows 41 or 61 px, 24 px thumbnails, name 17/400 | read from a distance; kind and size fold into line 2 because a column layout needs 600 px or more; 600 because the system has only 400 and 600 |
| selected row `--g1`, ink fill when the list holds focus | gray5, tint fill when focused | bloop's controls have no accent color; ink is its one fill |
| one header ("Items"), no row separators, one inset rule before the links | headers per section, 1 px separators | one section; separators add noise beside a selected row |
| no sort headers, no path bar, no name over the stage | sort menu, 35 px path bar | a fixed order (files A to Z, links last), and the selected row already names the item; 12 px is unreadable from the back of a room |
| bottom sheet under 768 | the pane slides in over the content | the stage must stay visible under the list |
| prev and next under the frame, in one row with the indicator | (no stage) | the plan wants buttons, dots and count on one centerline; on the frame's edges they would cover the slide |
| QR at half the viewport height, match digits 120 | spec draft: QR 240, digits 64 | the distance table in section 10: 240 px reads to about 1.5 m on a 65 inch display |
| the countdown is the QR card's own edge | spec draft: a 4 px bar under the QR | the owner's ruling: the frame is the timer, as a watch ring; the bar was one more thing under the code |
| reduced motion swaps at once | spec draft: a 150 ms cross-fade | the house safety net at the end of `app.css` already turns every animation off; one rule, no exception |

### Phone page (`/a`, opened by the camera)
- **Frame** (`/a` and `/code` alike): the corner bar with Back alone (home, or back to `/s?mode=demo` when this tab is also the demo screen; no logo), then a column on paper, max 480, one viewport tall, padding `--pad`, its buttons at the foot. The list scrolls inside its own card, so the buttons stay in reach.
- **Desktop (900 and up, with a list):** two columns, max 1040, gap 64: the room title (48), its lines, the scope and the buttons side by side on the left (400); the list on the right, scrolling within the viewport.
- **Approve:** the title is the room (34/600, -0.035em, left, as the screen's room title; "Registered screen" 14 `--muted` under a registered room `[V-7]`); then the list, no label over it (`aria-label="Items"`): one row per item (section 6), the whole 60 px row a checkbox, a trailing Iconic `check` on ticked rows and nothing on the rest, press `--wash`; the last row "Add a file" (a `--paper` plus tile, no tick) opens the guest path. A demo room ticks its whole catalog; a live phone starts with its newest file. Then the scope line (live only) and Cancel then Approve. The match digits ride on the primary, "Approve (Code 42)" (and "Send (Code 42)" for a guest): the person compares them with the screen before the tap that commits, so they sit where the eye already is.
- **Approved:** "Authorized on Demo Room", the approved items read only with their ticks, then "Ends in 59:12" (15 `--muted` tabular, counted down here from the view's `endsAt` and `now`) `[V-2]` and Revoke (primary), which ends the session as End did.

| State | Title | Body | Buttons |
|---|---|---|---|
| checking | (skeleton title bar) | Checking the code | none |
| match | Room 2.14 | a skeleton list | continues to choose |
| choose (nothing ticked) | Room 2.14 | the list | none besides the Add a file row |
| approve | Room 2.14 | the list; Only the items you tick go to the screen. The screen never gets your account. `[V-4]` | Cancel, Approve (Code 42) |
| approve, demo | Demo Room | the list, the whole catalog ticked | Cancel, Approve (Code 42) |
| unregistered screen | as approve, plus one card (Iconic `warning-triangle`, sentence in `--ink` 600; no tint, no stripe) | This screen isn't registered. Only approve if you can see it in front of you. `[V-7]` | Cancel, Approve (Code 42) |
| (choose, approve, unregistered screen, signed in to OneDrive) | as that state | as that state | Disconnect OneDrive (text) first: deletes bloop's stored access and signs this phone out, then shows first use |
| first use | Connect Your OneDrive | bloop reads your slides from OneDrive. You do this once, on this phone. `[V-9]` | Add a File (text, the guest path) `[V-10]`, Cancel, Connect OneDrive |
| needs admin | Your Organization Needs to Approve bloop | Ask your IT team, or sign in to the PC as usual. | Done |
| sign-in declined (`/auth/callback` page) | bloop wasn't given access. | bloop can't read your slides without it. Scan the code on the screen to try again. | Enter a Code |
| sign-in failed (`/auth/callback` page: state, issuer, exchange) | Couldn't sign you in. | Scan the code on the screen to try again, or sign in to the PC as usual. | Enter a Code |
| needs admin (`/auth/callback` page) | as needs admin | as needs admin | none |
| empty | No Slides Found | Save a .pptx file to OneDrive, then scan again. | Add a File (text), Done |
| approving | as approve | | Cancel, Approving... (button loading) |
| opening, open | Authorized on Room 2.14 | the items read only; Ends in 59:12 | Revoke |
| (opening, open and guest sent, when this tab is also the demo screen) | as that state | as that state | Revoke becomes secondary, then See It on the Screen (primary, back to `/s?mode=demo`) |
| open fallback | PowerPoint Didn't Open on the Screen | Tap Download on the screen to open it there. | Revoke |
| PDF fallback | Showing as a PDF on Room 2.14 | PowerPoint can't open it there. Animations and videos won't play. | Revoke |
| PDF file | Opened as a PDF on Room 2.14 | Lecture 4.pdf | Revoke |
| ended | Ended | The screen's link to your file has stopped working. `[V-1]` | Done |
| canceled | Canceled | Nothing was opened on the screen. | Done |
| expired | This Code Has Expired | Scan the new code on the screen. | Enter a Code (text) |
| taken | This Code Was Already Used | Scan the new code on the screen. | Enter a Code (text) |
| offline | You're Offline | Connect to Wi-Fi or mobile data, then try again. | Try Again |
| error | Unable to Open Your Slides | Check the file opens on your phone, then try again. | Try Again |
| guest: choose | Send a File to Room 2.14? | Choose one file from this phone. Only this file goes to the screen. | Cancel, Choose File |
| guest: confirm | Send Talk.pptx to Room 2.14? | bloop deletes its copy when this ends. `[V-5]` | Cancel, Send (Code 42) |
| guest: sending | Sending Talk.pptx | (progress bar) | Cancel |
| guest: file refused | This File Can't Be Sent | Choose a .pptx or .pdf file under {N} MB. `[V-10]` | Choose File |
| guest: sent | Sent to Room 2.14 | Open it on the screen when you're ready. | Cancel |
| guest: pass needed | Ask Your Host for a Guest Link | Open it on this phone, then scan the code again. | Done |
| guest: off | This Screen Can't Take Files | Sign in to the PC as usual to open your file. (the room's guest drop is switched off) | Done |
| rate limited | Too Many Tries | Wait a minute, then scan the code again. | Done |
| busy (storage full, or this month's R2 operation cap reached) | bloop Can't Take Files Right Now | Try again in a few minutes, or sign in to the PC as usual. | Done |
| framed | Open This Page Directly to Approve | | none |

The page moves focus to the new title on each state change. "its copy" is deliberate: bloop's stored upload is deleted, but a downloaded copy on the PC is open item 1.

Typed code page (`/code`, the same frame, one column): title "Enter the Code on the Screen"; one field 56 tall, `--r-field`, of 16 px or more, 6 characters, label "Code", `autocapitalize="characters"`, `autocomplete="one-time-code"`, `inputmode="text"`, shown in two groups of 3; Continue (primary) enabled at 6 characters; a failed claim shows one sentence beside the field (`typedError` in `copy.js`: "Check the code on the screen and try again.", or the expired, used, offline and too-many-tries sentences); success goes to the match state.

### Security page (`/security`; `/it` answers 301 to it from `public/_redirects`)
h1 "The Screen Never Gets Your Account" `[V-4]`, then the panel (section 6): What the Screen Gets: "The items you approve", "A link to each, which expires"; What Stays on Your Phone: "Your account", "Your other files". Then four points in one wide topic card:
1. The PC holds a link to each item you approve, and each link expires.
2. Each code works once for 60 seconds, and the phone shows the room before Approve. `[V-6]`
3. Each open ends by itself after 90 minutes and is logged for IT to export. `[V-2]`
4. A downloaded copy can stay on the PC. Every room is audited, and the results are published. `[V-1]` (until V-1 passes: "A downloaded copy can stay on the PC. See what can stay." linking `#stay`)

Then one topic card per row below (each `[V-5]` until the build confirms it), the row name as its h2 in Title Case ("What the PC Holds", "What bloop Keeps", "Permissions", "What Can Stay on the PC", "Threat Model", "Revoking Access", "Status"):
| Topic | Content |
|---|---|
| What the PC holds | A session ID and a link to each approved item, in the browser's session storage. Each link expires. While a file is open, PowerPoint holds the copy it opened. PowerPoint may also get a Microsoft download link for the file, which can work for up to 1 hour. (Last sentence: redirect mode only, threat model OPEN-03; delete it in stream mode.) |
| What bloop keeps | Your email, a OneDrive token, the ID of one folder, and a log of who opened which file where and when. No slide content, except a guest's upload, deleted when its session ends. |
| Permissions | bloop asks for read access to OneDrive. Microsoft grants that for the whole OneDrive; bloop reads one folder and logs every read. Where your tenant allows it, the app folder limits access at Microsoft's side, but then only files in that folder appear. |
| What can stay on the PC | A downloaded copy in Downloads and the file name in recent lists, until the profile is wiped. Each room is audited; results are published per room. `[V-1]` (the last sentence ships only once V-1 passes) |
| Threat model | QR relay: the phone shows the room name and a match code before Approve. Shoulder surfing: the code works once and lasts 60 seconds. Forgotten session: it ends by itself after 90 minutes. Wrong screen: unregistered screens carry a warning. Lost phone: disconnect bloop from any device. |
| Revoking access | The user disconnects bloop; an admin removes the app in Entra. |
| Status | No external audit yet. The source is public. Report a security issue: security.txt. |

### Privacy notice (`/privacy`, draft until the legal lane, OD-5)
`noindex`; the same nav, panel, topic cards and footer as `/security`; the retention table sits in a wide topic card. The retention rows restate `docs/threat-model.md` section 10; change both together.
| Slot | String |
|---|---|
| h1 | Privacy Notice |
| Draft line (the hero's lead) | This notice is a draft until **bloop**'s legal review. |
| Panel | as on `/security` |
| Who Is Responsible | **bloop** runs this service. Write to {privacy address} with any question about your data. |
| What bloop Keeps and for How Long (table) | Your email and account ID: While you stay connected, then 30 days. / Your OneDrive access, encrypted: Until you disconnect, or after 30 days unused. / A log of who opened which file, in which room, and when: 180 days. For the demo, 7 days. / A guest's file: Deleted when the talk ends, and after 1 day at most. / Your phone's sign-in: 30 days unused, 90 days at most. / Usage counts, with no names: 90 days, then daily totals for 2 years. / Waitlist: the email and answers you send: Kept to invite you to early access, until you ask for them to be deleted or the waitlist closes. |
| After the table | bloop keeps no slide content from your OneDrive. A guest's file is the one exception, and it is deleted when the talk ends. `[V-5]` |
| Why | To open the file you approve on the screen you choose, to keep the service safe, and to give your organization's IT team a record of what was opened where. |
| Where | Your data is stored in the EU on Cloudflare. Cloudflare is a US company, and each request is handled at its nearest data center. (threat model DATA-03: never "UK only" or "never leaves") |
| Your Choices | Disconnect OneDrive on your phone at any time, and **bloop** deletes its stored access. To see or erase what **bloop** holds about you, write to the address above. Your organization's admin can remove **bloop** in Microsoft Entra. |

`/.well-known/security.txt` (RFC 9116): `Contact` (a role address), `Expires` (at most a year ahead), `Preferred-Languages: en`. The placeholder addresses and their owner steps are in `docs/setup.md`.

## 8. Motion

One language: `--ease-out` for anything that appears or moves, `--ease-ui` for presses, linear for progress and opacity dips. Only `transform` and `opacity` animate, plus the FAQ's height and the nav's glass. A scene change on `/s` replays the enter keyframes on the page column by a class (no View Transitions: one path, and the bytes went to the v3.1 controls). Glass enters with the scene and nothing else: no refraction, no sheen.

| What | When | Duration | Easing |
|---|---|---|---|
| press | input | 150 ms | `--ease-ui` |
| stage tilt | scroll | sprung: stiffness 120, damping 30, mass .4 (CSS fallback: scroll-linked) | the spring |
| Try the Demo arrow | hover | 200 ms, 2 px to the right | `--ease-out` |
| FAQ open, close | toggle | 380 ms height, 250 ms fade, 300 ms "+" turn | `--ease-out` |
| nav scrolled | the top sentinel leaves or enters view | 240 ms glass and shadow | `--ease-out` |
| QR refresh | every 60 s | 150 ms out, 150 ms in | linear opacity |
| `/s` QR ring | each second | 1 s between steps | linear |
| New Code arrow | while the new screen loads | 0.8 s a turn | linear |
| `/s` scene change (a state, or the item on the stage) | enter | 380 ms opacity 0 and 12 px rise to rest | `--ease-out` |
| viewer bottom sheet | open | 300 ms from below | `--ease-out` |
| page step, row selection, hover | input | instant | |

The "Anywhere" glow is a static warm glow (one `text-shadow` of `--robin`, blurred .4em), not a one-time sheen. Why: a white glow vanishes on light paper; a sheen is motion on the LCP word, needs `background-clip:text` (the word turns into a painted fill that forced colors and some text renderers drop), plays once while the visitor may still be reading the sub, and reads as the glossy tell section 13 bans; the static glow costs no frame, is the same under reduced motion, and simply disappears in forced colors, leaving plain ink.

Reduced motion (`prefers-reduced-motion:reduce`): the stage rests flat (the spring never starts); the glow is static anyway; the FAQ switches instantly; the `/s` QR ring steps once a second with no glide; scene changes swap at once; the blanket rule at the end of `app.css` is the safety net. Nothing autoplays; the QR refresh is essential (a code must expire), so it has no pause.

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
| Rendering | integer device pixels per module, `shape-rendering:crispEdges`, no CSS scaling after layout, square modules, #1D1D1F on #FFFFFF, never inverted, no logo, no rounded or colored modules, never animated while shown |
| Screen size | module = `floor(0.5 * viewport height * DPR / 41)` device px; 1080p: 13 px, 533 px wide; 1366 x 768: 9 px, 369 px |
| Refresh | every 60 s; next code fetched at 50 s; the old code fades to white over `--d1`, then the new one in; the old code stays valid 10 s; a scanned code locks to that phone, which then has 2 minutes to approve |
| Match code | 2 digits, 10 to 99, on the screen after a scan (120 px on `/s`) and on the phone (44 px); compared, not typed; on `/s` a visually hidden line "It should show 42." announces it |
| Typed fallback | 6 characters of uppercase Crockford base32 in two groups of 3 ("K7M Q9X"), rotating with the QR, entered at `{host}/code`; on `/s` only, never on the landing |
| Accessibility | `role="img"`, `aria-label="QR code. Scan it with your phone camera to open bloop. Or enter the code K 7 M, Q 9 X at {host} slash code."`; the label updates silently |

Size by distance (width = distance / 8, a floor to confirm on site, open item 6): at 1080p a 65 inch display (0.75 mm/px) needs 167, 333 and 500 px at 1, 2 and 3 m; a 2.5 m wide projection (1.3 mm/px) needs 96, 192 and 288 px; a 24 inch monitor serves about 1.5 m. The 533 px default covers a 65 inch display to about 3.2 m and a projection to about 5.5 m.

## 11. Page performance

Stack and system architecture: `docs/architecture.md` and `docs/adr/`.

### Loading order (every page)
1. HTML with the one CSS `<link>` in the head; no inline styles or scripts (the CSP forbids them).
2. Font preload for the one subset; the metric-matched fallback means the swap shifts nothing.
3. `<script type="module">`, deferred by default: `site.js` on the landing only; the task pages' own modules.
4. The hero stage is CSS with its box reserved by `aspect-ratio`, so it shifts nothing and needs no request.

### Budgets (internal targets; Google's "good" lines in brackets)
| Metric | Landing | `/s` | `/a` |
|---|---|---|---|
| First-view requests | 5 or fewer (HTML, CSS, font, site.js, favicon) | 6 or fewer | 5 or fewer |
| CSS, font, browser JS, landing JS | the `size-limit` entries in `package.json`, the only owner. The v3.1 app pass raised browser JS and the CSS entry, after cutting the swipe handler, the View Transitions path and long header comments: the house frame, the QR ring, Copy and New Code, the match digits on Approve, and the approver's desktop layout cost more than the cuts gave back | same | same |
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
| `--lead` on the robin wash at its strongest under text / on `--paper` | 4.86 / 5.5:1 | the hero and page leads |
| `--robin-ink` on `--paper` / white | 5.0 / 5.6:1 | the name in body copy, 600 |
| `--g2` on `--paper` | 2.3:1 | rings only (the outline pill's label is ink), never text |
| QR #1E1E1C on white | 17.0:1 | modules |

### Rules
| Topic | Rule |
|---|---|
| Targets | 48 px buttons; 44 minimum for any hit area (nav links, the Waitlist pill and the menu button, footer links, FAQ summaries) |
| Focus | the ink ring on every interactive element; never on hidden UI (the closed menu sheet is `display:none`) |
| Keyboard | "Skip to Content" first; Tab follows reading order; summaries toggle with Enter and Space; Enter on `/a` activates Approve only when it is focused |
| Live regions | the `/s` heading in `role="status" aria-live="polite"`; failures `role="alert"`; `/a` moves focus to the new title |
| QR | label in section 10; the match code is announced with the scanned state |
| Images | logos are `alt=""` beside the visible name; icons and the bento's chips are `aria-hidden`; the menu button is labeled Menu |
| Language and zoom | `<html lang="en-US">`; zoom never disabled; holds at 200 percent and reflows to 320 CSS px |
| Forms | the code field has a visible label, 16 px or more, errors beside it in text plus icon |

## 13. Quality bar (checklist for every screen)

A screen is done when every box passes; `test/unit/site-pages.test.ts` and `test/e2e/landing.spec.ts` check the measurable ones.

- [ ] **Hero:** at most 40 words; the h1 one sentence of at most 6 words on one line at every width; the sub names the phone, the screen and the file in at most 2 sentences and 30 words.
- [ ] **Whole landing:** 80 to 260 words, FAQ answers included; every sentence at most 20 words; at most 4 FAQ items; every heading at most 8 words.
- [ ] **Try the demo** is the hero's one button, in the first view, and opens `/s?mode=demo`; every Waitlist link is a `mailto:` with `data-waitlist`.
- [ ] **Nav:** one `nav` landmark, the same on every site page; the menu works with no script; the scrolled look comes from an observer, never a scroll listener.
- [ ] **Stage:** flat at rest and under reduced motion; no script; no Source link anywhere.
- [ ] **Never-say grep:** no hit from `tools/never-say.txt` in any page or string; no nothing-stays, no sign-in-is-gone, no runs-everywhere, no freshness claim.
- [ ] **Mobile (390):** no horizontal scroll, targets at least 44 px.
- [ ] **Contrast:** WCAG AA on every text and control; axe and Lighthouse accessibility 1.0 in CI.
- [ ] **Budgets:** section 11.
- [ ] **No tells:** no gradient, glow or glossy button, except the two robin accents (the top wash and the "Anywhere" glow, sections 5 and 8); no eyebrow or mono kicker; no two-tone headline; no status dots or tinted icons; glass only on the surfaces section 4 lists, in its one recipe; no fake logos, testimonials or counts; no em or en dashes, exclamation marks or emoji.

### Coherence
One of each: type scale (600 and 400), card (flat white on paper), button shape (the pill in three roles), radius logic, shadow recipe (the stage frame, the QR card, glass), motion language, icon style (Iconic, stroke 1.5, only where it carries meaning), product pictures as real HTML chips inside a mock frame. One voice (section 3); the same sentence for the same claim on every page.

## 14. Inspiration and credits

Nothing is copied (no copy, assets, fonts or code); each lesson is restated in bloop's own system.
| Site | Taken | Avoided |
|---|---|---|
| ample.computer | the paper and ink palette, the type scale, ink and outline pills, white FAQ cards, the footer (tagline, plain lines, a rule, the year) | its long scroll stories |
| opsis.app | the top glass nav pill and its menu sheet, a plain two-word h1, the scroll tilt of the hero stage and the spring that smooths it, the brand-color glow at the top of the page that tints the glass, the bento of real UI chips, the list card with status pills, the privacy panel of toggles; from `/compare`: the centered page hero, white topic cards with the heading beside the prose, and a tint panel framing white cards | its density, its glossy gradient buttons, a FAQ that jumps, the `/compare` table and its paintings |

Font: Inter (SIL OFL 1.1), subset from the official `InterVariable.woff2`, license shipped with it.

## 15. Open items (settle during the build)

| # | Item | Fallback until settled |
|---|---|---|
| 1 | What the PC still holds after End (expired link, open PowerPoint window, Downloads copy, recent lists), per room | `/a` ended shows "Ended." only; `/security` point 4 becomes "The security page lists what can stay on the PC." |
| 2 | Automatic end after 90 minutes; End from phone and screen | drop "after 90 minutes" and the "Ends by itself" lines |
| 3 | A file edited minutes earlier opens as edited | no copy promises freshness either way |
| 4 | The screen holds only a session ID and one short-lived file link; the account never reaches it | the sub ends at "It opens in seconds."; the FAQ's "never your account" and the approve line dropped |
| 5 | bloop stores no slide content except guest uploads, deleted at the end; what bloop keeps and how long | the "deletes its copy" lines dropped; `/security` rows hidden |
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
| 26 | One casing for labels (settled: Title Case for headings, titles and labels everywhere, section 3) | |
