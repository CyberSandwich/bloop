# bloop design

The one source of truth for bloop's brand, visual design, UI and UX. The system is a calm paper-and-ink one modeled on ample.computer, with opsis.app's top glass nav, tilted hero stage and list card; nothing from either site is copied (section 14). Strings marked `[V-n]` depend on an unverified product property: ship the string only once open item n (section 15) passes, otherwise ship the fallback given there. Every screen passes the checklist in section 13 before it is called done.

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
| 1 | Calming first. Light only, paper and ink; one accent, robin orange (the logo's disc), only in the sheen on "Anywhere", the warm backdrop under the How It Works stills and the close panel (section 6) and the name in body copy; the page ground is plain paper. | Squint: only the ink pills, the logo and the warm panels stand out. |
| 2 | Far less text. One-line headlines, one plain sub, a short FAQ. | Section 13 word caps pass. |
| 3 | Relevant. Every element is about the handover (code, phone, approval, file, screen). | Delete any element that would make sense on another product's page. |
| 4 | Looks finished. Real copy, real states, real product UI as HTML chips. | No lorem and no unstyled state; "Coming soon" only on the hero stage and the provider list, where it is the truth. |
| 5 | Concentric geometry. Inner radius = outer radius minus inset. | Every nested corner passes the formula in section 4. |
| 6 | Coherence over collage. Each borrowed pattern is restated in this one system or dropped. | Section 13 coherence list passes. |

## 3. Voice and copy

### Rules
| Rule | Example |
|---|---|
| Headings, page titles and labels in Title Case with no period; no second clause in grey. Title Case keeps a, an, the, and, but, or, nor, for, as, at, by, in, of, on, to and with lowercase after the first word, and `bloop` always lowercase. At most 5 words, a room or file name counting as one (the voice test in `client-copy.test.ts` holds the app's strings and page headings to it). | "Present Anywhere", "You Stay in Charge" |
| Headlines at most 8 words; one sentence of at most 20 words (section 13). | |
| Lead with slides for lecturers; security leads only for IT. | |
| Security as concrete never-statements: actor, verb, specific thing. "X, never Y" is allowed; "not X, but Y" is not. | "One file, never an account." |
| Conditions go in a footnote or on `/security`, never into the marketing sentence. "Present Anywhere" is the one claim of reach; the FAQ names its condition (a web browser on the screen, open item 25). | |
| Plain beats clever: no puns, no analogy on the landing, no unexplained noun. | |
| "session", "token" and "tenant" stay off every user-facing screen; only `/security` may use them. One exception by the owner's ruling: the room screen's "Session Ended" (`SESSION_ENDED` in `copy.js`). | "End", "Ended." |
| Contractions yes. Never "we", "our team", "oops", "uh-oh". | |
| Errors: what happened, no blame, what to do, one verb button. | "Unable to Open Your File" |
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
| meta and OG description | Scan the QR code, approve on your phone, and present. (the sub, word for word; it makes no claim about the account, which "stays on your phone" overstated: the server holds a refresh token, AUTH-01) |
| `<title>` `/security`, `/s`, `/a`, `/code` | bloop: Security; bloop: Screen; bloop: Approve; bloop: Enter the Code |
| `<title>` `/privacy`, 404 | bloop: Privacy Notice; bloop: Page Not Found |
| OG image alt | bloop: Present Anywhere (`public/og.png` must show the same h1; `tools/render-og.py` renders it) |

**Site chrome (every site page, the same markup; a unit test holds them equal)**
| Slot | String |
|---|---|
| Nav | the logo pill, the logo and bloop (home); the links pill: Features (`/#features`), Privacy, Security, Waitlist, and the menu button, labeled Menu, under 640 |
| Waitlist | every Waitlist link opens `https://tally.so/r/Yj4KAN?source=<page>` in the same tab, where `<page>` is landing, privacy, security, viewer (the Session Ended link on `/s`) or 404; each keeps `data-waitlist`, so one grep finds every link; the form is Tally's, so the CSP needs nothing (a link navigation is not covered by it, and `form-action` governs forms only) |
| Footer | the logo and bloop; "**Present anywhere.** **bloop** puts your files on a shared screen from your phone. The screen gets only the items you approve, never your account." (the tagline stays a sentence: it is body copy); Privacy, Security, Waitlist and the address `hi@bloop.here` as a `mailto:` link in the same list, so its text is visible without a mail app; a rule; © 2026 bloop. No Source link. |
| 404 | This Page Isn't Here / Check the address. / button Go to the Home Page (the button says where, so the line does not) |

**Landing**
| Slot | String |
|---|---|
| h1 | Present Anywhere ("Anywhere" carries the sheen, section 8) |
| Sub | Scan the QR code, approve on your phone, and present. `[V-4]` |
| Action | Try the Demo with a trailing Lucide `arrow-right` (ink pill, `/demo`, which `public/_redirects` answers 302 to `/s?mode=demo`, so the demo's address can move without touching a page), the hero's only button |
| Stage | the Demo Room screenshot; alt "The Demo Room screen showing a list of files and a dog on the stage" |
| How It Works (step / line / still) | 1 Scan / Scan the screen's QR code with your phone camera. / the Lucide `qr-code` glyph alone, 64 px, ink, centered. 2 Approve / Select your files, then tap Approve. / the demo's own list: Sample deck.pptx and Dog.jpg (its 120 px thumbnail as the tile) selected, the Vevox link left out. 3 Present / Present immediately or download your file. / a copy of the viewer's pill: "1 / 20", Present, Download |
| Features h2 | You Stay in Charge |
| Feature cells (title / line), checked against `docs/threat-model.md` and `tools/never-say.txt` | Approve on Your Phone / Check the code matches, then tap Approve. Screen Never Gets Your Account / It gets a link to each item you approve. Revoke Any Time / Revoke from your phone, and each link expires. Present or Download / Show a file full screen, or save a copy. Know What Can Stay / A downloaded copy can stay on the PC. See what can stay. (links to `/security#stay`; RES-02: the residue is named, never denied) Share Files and Links / Slides, PDFs, photos and links, from your phone. (no provider path is live, so no cell sells storage; Connect says Coming Soon; "Your Account Stays on Your Phone" would overstate it, since the server holds a refresh token, AUTH-01) |
| Connect h2 | Connect Your Files, with no line under it (the two group heads and their statuses say it) |
| What You Can Share (status Available) | PowerPoint, PDF, Images, Links, each with its Lucide glyph (`presentation`, `file-text`, `image`, `link`), as the viewer's tiles; the group title is screen-reader only, so the head row is the status chip |
| Where Files Live (status Coming Soon) | Microsoft OneDrive, Dropbox, Google Drive, Box, by name only with the generic `cloud` glyph on each row, no brand mark (Google Drive™, its first mention on the page) (section 6, Icons); the group title is visible, beside the chip; a provider moves to its own "Available" only once its path is live in a real account; no iCloud |
| FAQ heading | Questions |
| Do I need to install anything? | No. The screen runs **bloop** in its web browser, and your phone uses its camera. Slides open in PowerPoint on the room PC. `[V-8]` |
| What does the room PC keep? | A link to each item you open, never your account. A downloaded copy, recent file names and opened tabs with their history can stay until the profile is wiped. See what can stay. (the same sentence as `/security#stay`) (links to `/security`; threat model RES-02: never a nothing-stays claim) |
| Is it free? | Yes. Early access is free while **bloop** is being tested. `[V-20]` |
| Close (no heading; the section is labeled "Try the demo") | the logo mark over the hero's Try the Demo, repeated as the page's last call to action |
| No JavaScript | `/s` "This screen needs JavaScript to show a code."; `/a` "Approving needs JavaScript. Turn it on, then scan again." The site needs none: the menu is a popover, the tilt falls back to CSS, the FAQ is native. |

State strings for `/s` and `/a` are in section 7 with their screens.

## 4. Tokens

Tokens live in `public/css/base.css` `:root`; this list restates them, and the drift test holds the two equal. Light only (`color-scheme:light`).

### Color
| Token | Use |
|---|---|
| `--paper:#f3f3f0` | page ground everywhere |
| `--surface:#ffffff` | cards: the How It Works steps, the features band, FAQ items, the QR card and the house frame (section 6), the stage frame, item lists, the warn card, the provider list, the panel rows, chips |
| `--ink:#1e1e1c` | text, primary pills, the tick, the active page dot, the progress fill, the focus ring |
| `--ink-2:#3a3a36` | the nav's Waitlist pill (solid, never a gradient), nav links, text on a tinted card, the stage's line |
| `--muted:#66665f` | secondary text, 4.6:1 or more on every neutral it sits on: 5.2 on paper, 4.67 on the hover wash, 5.5 on glass, 4.9 on the wash over glass, 4.62 on a selected row (`--g-select`); never on a pastel. Lighter than `--lead`, never darker |
| `--g2:#a3a39c` | the outline pill's ring, the empty tick ring, field rings; never text |
| `--g1:#dcdcd7` | skeletons, the progress track, page dots, the sheet grab bar, the hero stage's ground while its picture loads; never under text |
| `--g-select:#e6e6e2` | the selected row only: lighter than `--g1` so `--muted` meta text keeps 4.6:1 on it, a shade darker than the wash on paper and clearly darker than the wash on glass, where the sidebar sits |
| `--hairline:rgba(0,0,0,.08)` | rules and card rings, drawn as `box-shadow`, never a border; row hover and press |
| `--sky:#cfe0e8` | a solid tint, site pages only, never a gradient: the Connect panel and the panel on `/privacy` and `/security` (not the close panel). Text on it is `--ink` or `--ink-2` |
| `--mint:#cce8df` `--mint-ink:#1e3d35` | the Available status chip and its text (9.1:1): green reads as ready at a glance, and pastel keeps it from shouting |
| `--amber:#f6e7b2` `--amber-ink:#57420f` | the Coming Soon status chip and its text (7.8:1): amber reads as not yet, never as an error; text on a pastel is its own dark ink, never `--muted` |
| `--robin:#f4ba8b` | the logo's disc, the one accent: the core of the "Anywhere" sheen band and a soft shape of the warm backdrop (section 6); never body text, never a flat fill |
| `--robin-deep:#c8632a` | the edges of the orange band that sweeps through "Anywhere" (the word rests in ink; the band's core is `--robin`); the QR ring's countdown stroke (4.0:1 on white, over the 3:1 a graphic needs); never body text |
| `--rose:#f8d7d3` `--rose-ink:#9b2c22` | the pair for the controls that end: End on the screen and Revoke on the phone, a pastel fill with its own deep red text (5.6:1). Red says stop without alarm; the same house frame or pill, so nothing else changes |
| `--robin-ink:#a64f15` | the robin at text strength: the name in body copy (5.0:1 on paper, 5.6:1 on white) |
| `--lead:#50504b` | the hero and page leads, on paper: 7.3:1; never lighter than `--muted`, so a lead outranks secondary text |

Status colors (`--ok`, `--warn`, `--err`) are not used: a state is a sentence plus the object changing.

### Type
- `--font:"Inter","Inter Fallback",Arial,sans-serif`, self-hosted, 400 and 600 only. Body 17/1.5, -0.011em.
- `--mono:ui-monospace, "SF Mono", Menlo, monospace`, system, never loaded: the match number on the room screen, 600, and nothing else.
- `@font-face` "Inter" from `/fonts/inter-latin.woff2` (`tools/subset-font.py` from `src/fonts/InterVariable.woff2`, `opsz` kept), `font-weight:400 600`, `font-display:swap`, the Latin `unicode-range` (U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD). "Inter Fallback": `local("Arial")`, `size-adjust:107.1%`, `ascent-override:90.4%`, `descent-override:22.5%`, `line-gap-override:0%` (open item 11).

| Role | Size | Line height | Tracking | Weight |
|---|---|---|---|---|
| hero h1 | `min(112px, (100vw - 2 * var(--pad)) / 10)` from 640: one line; under 640 `min(56px, (100vw - 2 * var(--pad)) / 5)`: a phone's h1 stays large and takes two lines where one does not fit, as at 390 (the two meet at 640) | 1 | -0.05em | 600 |
| section h2 (landing), `/security` and `/privacy` h1 | 30, 38 from 640, 54 from 768 (under 640 the heads stay below the one-line hero h1, 34 px at 390) | 1.04 | -0.035em | 600 |
| card title (a feature cell 19) | 22 | 1.2 | -0.025em | 600 |
| hero sub, page lead | 20, 24 from 768, `--lead`, max 640 | 1.35 | -0.015em | 400 |
| `/s` heading (a state; 22 and one line over the stage), line | 28; 19 `--muted` | 1.2; 1.5 | -0.025em | 600; 400 |
| display: the waiting room's name and Session Ended, on `/s` (the phone's ended title is the phone title) | `--display:clamp(44px, 5.5vw, 96px)` | 1.05 | -0.035em | 600 |
| phone title, centered | 28 | 1.2 | -0.025em | 600 |
| item name; its meta line; group label | 15; 13 `--muted` tabular, 2 below the name; 14 `--muted` | 1.3; 1.45 | | 600; 400; 600 |
| FAQ question, answer | 17 600; 16 `--muted` | 1.5; 1.6 | | |
| button | 16 (15 in the nav and on chips) | 1 | -0.01em | 600 |
| nav link | 15 `--ink-2`, 400 (the current page's link `--ink` on its selected pill; same weight, so no link shifts) | 1.5 | | 400 |
| small | 14 `--muted` | 1.45 | | 400 |
| codes (typed code, match digits) | context size, `tabular-nums`; the room screen's match number in `--mono` at 0.4 of the QR card | 1 | +0.04 to 0.06em | 600 |
| `/s` hint lines (waiting, claimed) | 22 `--ink-2` in the wide layout (the card-title step under the 44 to 96 name); stacked, `--muted` at the QR card's width / 24, from 13 to 15 | 1.35 | | 400 |

Headings `text-wrap:balance` (h1 and h2 in base.css, the site's h3 in site.css, so a card title never ends on one word); no mono (except the match number in the QR card), no eyebrow, no uppercase label, no grey second clause in a headline.

### Radii, shadows, motion, layout
| Token | Use |
|---|---|
| `--r-chip:8px` | skeletons, the summary focus ring, a file tile in a How It Works still |
| `--r-field:14px` | the code field, the stage frame, the menu sheet's rows, the How It Works stills |
| `--r-card:20px` | the house frame, the viewer's link card and the app's white cards |
| `--r-list:24px` `--list-pad:8px` | a box of rows (the viewer sidebar, the phone's list, the sheet, the handle): the box is `--r-list` padded `--list-pad` on every side, so a row's fill is `--r-list` - `--list-pad` (16) and its thumbnail, 8 in, that - 8 (8): one chain of `calc()` from the box down (section 6) |
| `--r-stage:28px` | frames that hold inner cards or a picture: the hero stage (16 under 640), the privacy and security panel, the QR card and its ring |
| `--r-content:24px` | every flat content card on the site: the How It Works steps, the feature cells, the FAQ items, the topic cards |
| `--r-sheet:24px` | the top corners of the viewer's bottom sheet |
| `--r-pill:9999px` | buttons, chips, the nav pill |
| `--sh-frame:0 0 0 1px rgba(0,0,0,.06),0 30px 60px -30px rgba(0,0,0,.35)` | the viewer's page or picture, the QR card, the hero stage (its screenshot's ground is the page's own paper, so only the frame says it is a picture) |
| `--sh-nav:0 0 0 0.5px rgba(0,0,0,.08),0 4px 18px rgba(0,0,0,.05)` | the nav pills at the top of the page |
| `--sh-pill:0 0 0 0.5px rgba(0,0,0,.08),0 10px 30px rgba(0,0,0,.12)` | glass at rest in the app (sidebar, sheet, handle, the viewer's control pill), the nav pills once scrolled, the menu sheet, the skip link |
| `--nav-h:56px` | the height of both nav pills; every inset inside them is (56 - inner height) / 2 |
| `--wordmark:22px` | the bloop beside the logo, wherever it stands: the nav, the footer and the app's logo button |
| `--mark:32px` | the logo mark beside the wordmark, in the same three places; the nav's logo pill inset is (56 - 32) / 2 |
| `--glyph:0.8` | the drawn size of every glyph inside its box (`scale`, so no layout box moves): Lucide fills about 18 of its 24 units where the glyphs before it filled 14.5, so objects, lines and ticks are drawn at 0.8 |
| `--glyph-dir:0.88` | the same for arrows and chevrons (`.dir`): they were already near the old extent (14 of 24 against 14.5), so they shrink less; the Scan still's QR (64 px) is drawn at 1 |
| `--side:280px` | the viewer sidebar's width |
| `--row:56px` | one item row (8 + a 40 px tile + 8), the viewer sidebar and the phone list alike |
| `--inset:10px` | the app's edge inset, every side alike (12 from 640), and the gap between floating parts on `/s`: the corner controls mirror, the list, the stage and the controls keep the same daylight |
| `--frame-h:56px` | the house frame's height: Back, Approve on This Device, End, the code card, New Code |
| `--display` | the type token for the waiting room's name and Session Ended (Type above) |
| `--ease-out:cubic-bezier(.22,1,.36,1)` | the workhorse: reveals, the FAQ, the nav's scrolled look |
| `--ease-ui:cubic-bezier(.4,0,.2,1)` | press feedback |
| `--pad:24px` | page side padding; 40 from 640 |
| `--section:80px` | section rhythm; 112 from 768 |

### Glass
One recipe, named once (`.glass` in `base.css`; the nav pills carry the class in their markup, so `base.css` names no site selector), for every floating surface: the nav pills and their menu sheet, the viewer sidebar, its bottom sheet and handle, the viewer's control pill, the phone's sticky actions, and the components of the How It Works stills and the close card, over the warm backdrop (below). Liquid, not frosted: a thin fill, a strong blur and saturation, so what passes under (the warm backdrop, the page as it scrolls) tints it, as opsis's green tints its nav. No refraction, shine or animated sheen; the border is the shadow's 0.5 px ring, never a CSS border.
| Token | Use |
|---|---|
| `--glass:rgba(255,255,255,.62)` | the fill where `backdrop-filter` is supported |
| `--glass-filter:blur(24px) saturate(2)` | with `-webkit-backdrop-filter` beside it |
| `--glass-solid:rgba(255,255,255,.92)` | the fill with no `backdrop-filter` |
| `--glass-firm:rgba(255,255,255,.8)` | the nav pills once scrolled and the menu sheet (it holds text over the hero's type) |
| `--glass-edge:inset 0 1px 0 rgba(255,255,255,.7)` | the hairline highlight on the top edge, composed first in a glass surface's `box-shadow` |
| `--wash:rgba(120,120,128,.1)` | hover on nav links, icon buttons and rows (a fine pointer only) |

The warm backdrop (`.frag` and `.close-panel` in `site.css`, one rule): four soft radial shapes over a warm white (`--robin` at 12 percent on `--surface`), from the existing tokens, no new ones: `--robin-deep` at 50 percent alpha (deep orange), `--robin` (peach), `--amber` and `--rose` (pink), each fading out by about 65 percent of its box. The image is 150 percent of its box, and each element's `background-position` crops a different arrangement, so the three stills and the close panel share one rule and differ in layout. Static, no image, no animation; `--paper` where `color-mix` is missing. Glass over it is `.glass` at `--glass-firm` (`--glass-solid` without `backdrop-filter`) with the nav's edge and lift, and carries every text at 4.5:1 or better against the strongest shape (the muted Vevox name is the tightest, about 5:1).

Reduced transparency: `--surface`, no filter. The nav eases background and shadow over 240 ms `--ease-out`; app glass enters with the shared motion only.

White cards are flat on paper with no shadow (the viewer's page, the QR card, the hero stage and glass are the only lifted things). Concentric rule: `r_inner = r_outer - inset`, floored at 4 px; a bar holding a pill is a pill. Content width `min(100% - 2 * --pad, 1136px)`; text columns 760. Breakpoints 640, 768, 1024; check at 390, 834 and 1440.

## 5. Layout

- One column, centered, generous space, on plain `--paper` (no wash: the orange lives in the "Anywhere" sheen and the warm panels). The landing is: the nav; hero (h1, sub, one pill); the stage; How It Works (three steps); Features (`#features`, the grid on a white band); Connect Your Files (the Connect panel); the FAQ; the close (the mark over Try the Demo); the footer. `/security`, `/privacy` and 404 get the same nav and footer around a centered page hero and white topic cards (section 6).
- The hero block (h1 to button) is centered in the whole first view: `min-height:100svh`, padded `--nav-h` + 40 above and below, so the stage starts at the fold and the block sits at true center (a view less 120 px put it 60 px high). No entrance animation; the h1 paints in the first frame (the LCP element is the h1 or the stage picture, whichever paints larger). The doc pages' hero starts 152 px down; `html` keeps 96 px of `scroll-padding-top`, so a jump to `#features` lands below the nav.
- `/s`, `/a` and `/code` are task pages with no site nav or footer.

## 6. Components

Shared states: focus is `outline:2px solid var(--ink)` on `:focus-visible`, never removed; press is `scale(.97)` over 150 ms `--ease-ui`; disabled is opacity .38; no hover color change on ink pills (the outline pill's ring darkens to ink, text buttons underline); loading swaps in a 16 px spinner with a progressive label ("Approving...").

### Buttons
| Type | Look | Use |
|---|---|---|
| primary | ink pill, paper label, 52 tall, padding 0 24 (44 only in the viewer's pill) | the one action per view: Try the demo, Approve, Continue, Download, Approve on This Phone, Open vevox.com, Enter the Code (a dead code's one exit; the same words as `/code`'s title) |
| rose | `--rose` fill, `--rose-ink` label, the primary's size (the house frame on `/s`) | End (screen), Revoke (phone): the controls that end a session |
| waitlist | `--ink-2` pill, paper label, 44 tall, padding 0 16, 15 px | Waitlist, in the nav only |
| secondary | white pill (`--surface`), a `--hairline` ring that darkens to `--g2` on hover, ink label | Cancel, Present, Enter the Code on a narrow screen |
| text | no fill, 44 hit area | Show as PDF Instead, Add a File (only where no list ends with its row) |
| phone pages | 52 tall, gap 8; side by side from 640 in reading order, the primary last (Cancel then Approve; Revoke then See It on the Screen), a leading text button pulled 12 px so its text meets the column's; stacked under 640 with the primary on top (`column-reverse`, Apple's order) | Approve, Cancel, Revoke |

### House frame (`.framed`)
The typed code card's look, kept exactly, for every small framed thing: white, `--r-card`, no shadow, `--frame-h` tall, padding 0 20, 17/600; a leading glyph is concentric with the frame's rounded end, so the start padding is (`--frame-h` - glyph) / 2: 16 for a 24 icon, 12 for the `--mark` logo; hover adds a `--g2` ring, press scales .97, disabled is .38 with its icon turning. Users: the labeled Back pill (Lucide `arrow-left` and "Back", top left of `/s`, `/a` and `/code`; on a claimed screen it is Start Over), Approve on This Device and End (top right), the session's logo button, the code card (Lucide `copy` at its start; a click copies the code and shows `check` for 1.5 s; the code holds a fixed width, from the glyph's inset with the slack after it, so New Code never shifts; a new code clears the check; New Code's own glyph stays centered in its square) and New Code (a `--frame-h` square, Lucide `refresh-cw`, which turns clockwise). The logo button's wordmark is `--wordmark`, as on the site. The corner bar holds them at `--inset` from the top and the side, so both corners mirror.

No gradient, no gloss; the one variant is rose, for End.

### Icons
Only where an icon carries meaning at a glance: the menu button (`menu`, `x` while its sheet is open), item type tiles (`presentation`, `file-text`, `image`, `link`), the add tile (`plus`), Back (`arrow-left`), a link row's open in a new tab (`arrow-up-right`), the sheet handle (`chevron-up`; turned 90 degrees, the viewer's paging hint), the tick (`check`), copy (`copy`), New Code (`refresh-cw`), the warning (`triangle-alert`). Never decoration. One source: Lucide (ISC), via the owner's set at saputra.co.uk/iconic (the `icons` folder of the owner's saputra.co.uk project, outside this repo), one file per glyph. A glyph is used by its file name and drawn as published: its child elements and their attributes unchanged, never redrawn, inline SVG, 24 viewBox, one stroke weight of 2, round caps and joins, `currentColor`, `aria-hidden` beside a visible or `aria-label` name. Size is the only adjustment, one token per role in `base.css`: every `.icon` is drawn at `--glyph` (0.8) of its box by `scale`, an arrow or chevron (`.dir`) at `--glyph-dir` (0.88), so a glyph's box, and every inset computed from it, stays 24 (20 in a still), and its optical size sits with the text's cap height; the stroke attribute stays 2 as published. The pages inline them; `public/js/core/icons.js` holds the ones the scripts draw and is generated by `tools/render-icons.py` from the same files. Lucide's ISC notice ships as `public/js/core/Lucide.LICENSE.txt`. The site uses `menu` and `x` (the menu button while its sheet is open), `arrow-right` (Try the Demo), `check` (what the screen gets, on the privacy and security panel), the kind glyphs in the How It Works stills and the Connect rows, `qr-code` (the Scan still, 64 px), and one per feature cell: `circle-check`, `lock`, `circle-x`, `download`, `monitor`, `link`. Provider marks: none, names only, as plain text: each brand allows its mark only for a live integration or under a license, and none covers "Coming Soon". Names follow the brands: "Microsoft OneDrive", and "Google Drive™" at its first mention on a page.

### Top nav (every site page)
`<header class="nav">`: a fixed grid row 14 px from the top (10 under 640), `min(100% - 32px, 1136px)` wide, `pointer-events` only on the pills, holding two glass pills of `--nav-h`, `--glass-edge` over `--sh-nav`:
- **Logo pill** (start of the row, outside the landmark): the logo 32 and bloop at `--wordmark`, home. Padding 0 20 0 12: 12 = (56 - 32) / 2, so the mark's disc is concentric with the pill's end.
- **Links pill**, `<nav class="nav-pill" aria-label="Primary">`, centered: padding 0 6 = (56 - 44) / 2, one gap of 4 between items. The Waitlist pill has the links' own 16 padding, so the space from Security's text to Waitlist's text is the space between two link texts (16 + 4 + 16 = 36; an e2e test holds them within 1 px). The links Features, Privacy, Security (44 tall, padding 0 16, `--ink-2`, a `--wash` pill on hover); the page's own link has `aria-current="page"` and keeps that pill with `--ink`, as the selected pill; then the Waitlist pill.
- **Scrolled:** once a 12 px sentinel at the top of the landing leaves the view (an `IntersectionObserver` in `site.js`, never a scroll listener), `is-scrolled` raises both pills to `--glass-firm` and `--sh-pill` over 240 ms `--ease-out` (under Reduce Transparency, `--surface`, as the menu sheet); no hide on scroll, no size change. Other site pages keep the resting look (they run no script).

Under 760 (between 640 and 760 the two pills met) the row is the width less 10 px each side: the logo pill at the start, the links pill at the end holding Waitlist and a 44 px menu button (Lucide `menu`, `x` while the sheet is open, by `:popover-open` with no script). The links list is the same element as a `popover` (`popovertarget` on the button, no script): a `--glass-firm` sheet `--nav-h` + 20 from the top, 10 px from each side, radius 22, padding 8, `--sh-pill`, rows 44 tall at 17 px, the current page's row on its pill. Light dismiss and Escape close it; on the landing a link click closes it too, so a jump to Features is not covered.

### Hero stage
A screenshot of the Demo Room, edge to edge in a `--r-stage` frame with `--sh-frame`, its top edge at the fold (section 5). Under 640 it is replaced by an iPhone mockup showing the demo viewer with Dog.jpg, which carries its own device frame on a transparent ground, so the stage there has no frame, radius, fill or shadow (`overflow: visible`); the mockup is the owner's capture, `public/img/hero-phone-{600,900}.{avif,webp}` rendered by `tools/render-hero-mobile.py` with its transparent margins trimmed (the phone was 57 percent of the file's width), alpha kept, metadata stripped; its ratio, 1155 / 2366, is set in CSS on `.stage img`, since the `img`'s own width and height are the screenshot's, so the swap shifts nothing. The capture shows the earlier dog photo and a Download-only pill, so it is retaken (by the owner) now the viewer shows the new dog and Present. Interim: the viewer with Dog.jpg selected (the current dog, with Present and Download in the pill), captured at 1440 x 828 (the browser tool's 1x, stitched from two captures since a window is at most 772 tall here; `tools/render-hero-desktop.py` encodes it at the documented AVIF 62 and WebP 80: at 30 the grass smears at 2x, and the photo's detail needs the higher quality, so the hero budgets allow it), since the sample deck still carries a third party's brand; it is recaptured with the deck on the stage at 2x once a neutral sample deck lands. `<picture>`: first the phone sources under 640 (`media`, AVIF then WebP, 600 and 900 wide), then AVIF (quality 62) and WebP (quality 80), each at 1000 and 1440 wide with `sizes`, metadata stripped; one `alt` covers both pictures: "The bloop viewer showing a dog, with Present and Download buttons and a list of files"; the `img` has its width and height (no shift), `fetchpriority="high"` and no lazy loading. The h1 is the LCP element (the stage starts at the fold); the high priority keeps the picture early at the cost of competing with the font. Its wrapper has `perspective:2200px` from the top center. Tilt, at every width unless motion is reduced (the stage starts at the fold at every width, so a phone sees it face up and flatten as it scrolls in, as a desktop does; the 2200 px perspective reads undistorted on the tall phone picture, checked at 500 wide): `rotateX(24deg) scale(.9)` to flat over the stage's entry (the `entry` range: from its top edge showing to fully shown, or to filling the view when taller), so it rests flat once fully in view.
- **Spring (`site.js`):** the progress goes through a spring (stiffness 120, damping 30, mass .4, as opsis smooths its tilt; overdamped, no overshoot, a time constant of about a quarter second) into the `currentTime` of a paused `el.animate` of the same keyframes. The damping step is implicit, so a long frame cannot make it ring. A `requestAnimationFrame` loop runs while the spring moves and stops once settled; an `IntersectionObserver` with 1 percent thresholds wakes it, which tracks the goal because over the entry the visible share changes with it; no scroll listener and no inline style write. The script animation outranks the CSS one.
- **Fallback:** without the script, under `@supports (animation-timeline:view())`, the same keyframes on the stage's view timeline, locked to the scroll. Elsewhere it is flat and still.

### How It Works
Three verbs. A list of 3 white `--r-content` cards, one column, three from 1024 (at 834 a third of the width wraps the file names), gap 16, no heading: the section carries `aria-label="How It Works"` for a screen reader, and the cards start at the section's own top padding like every other section, so the stage-to-cards gap is the site's section gap. Each card: the step as an h2, since the section has no heading above it (a 28 px ink circle with its number, `aria-hidden` since the list numbers it, then the verb, 22/600), one line in `--ink-2`, 24, then a still of that step: the warm backdrop (below), 12 in from the card's sides and bottom at `--r-content` - 12, padding 20 above and below and 12 at the sides, `aria-hidden`, no selection. The device is not named: the line says it, and a label above the verb read as a third row of text. Side by side (from 1024) the cards share the list's three rows by `subgrid` (title, line, still): the stills start on one line and take the tallest one's height, content centered, so each ends 12 above its card's bottom, concentric with the card. The stills are small real fragments of the app in HTML, not pictures of buttons, each component on a glass surface over the backdrop: the QR glyph at 64 px on a glass tile (padding 20, `--r-field`); the demo's own list as the phone shows it, in one glass card (`--r-field`, padding 8 and 12, rows 44), file rows with with a 32 px tile (the deck's glyph; the dog's own 120 px thumbnail) and a tick (`frag-tick`: the app's `.tick` hides outside a checked row), the left-out Vevox link in `--muted` 400 on an outlined, unfilled tile (no opacity, so its name keeps 4.5:1 on the glass); a copy of the viewer's pill, "1 / 20", Present and Download, in `--r-pill` and glass, Download staying solid ink. Privacy is shown here, as the phone's own selection, rather than claimed.

### Features grid
The ample pattern: six neutral cells on a white full-bleed band, one column, two from 640, three from 1024, gap 16. Cell: `--paper`, `--r-content`, padding 24; a 24 px Lucide glyph in ink, the title 19/600 16 below it, then one or two sentences in `--ink-2`; under 640 the glyph sits inline before the title, 12 apart, on its first line, so a one-column list is not a column of lone icons. One fill for every cell: no pastels, gradients or button mocks, so the words carry it. Every claim is checked against the threat model and the never-say list; the residue cell names what can stay and links to it, and the storage cell says Coming Soon.

### Close
No heading: the section carries `aria-label="Try the demo"`. One panel on the warm backdrop at `--r-stage` (16 under 640), the width of the stage, padding 56 above and below, holding one glass card (`--r-content`, padding 40 and 48) with the 64 px logo mark over the hero's Try the Demo, 32 apart. The backdrop's one focal shape sits behind the card; the others stay at the corners. Reason: ample.computer closes on one dark pill under a large question, and opsis.app on a full-width rounded panel with its app icon over the action; both end on a single action with the brand mark near it. bloop takes the panel and the mark and drops the headline, since the page already said everything and a second h2 repeated the hero's button label. The page ends on the one action it opened with.

### Connect panel (Connect Your Files)
Max 760. A solid sky panel, `--r-stage`, padding 12, holding two white group cards (radius 16 = 28 - 12, padding 20 20 4), side by side from 768. Each group: a head row with its title on the left (17/600, "What You Can Share", "Where Files Live") and its status chip on the right, on one line, baselines aligned (a chip alone read as a missing title), then rows at least 56 tall, padded 12 above and below so a wrapped row keeps its inset, split by a hairline, 600 text. What You Can Share: Available (`--mint-ink` on `--mint`), each row a 24 px Lucide glyph (`presentation`, `file-text`, `image`, `link`, as the viewer's tiles) and the kind. Where Files Live: Coming Soon (`--amber-ink` on `--amber`), each row the generic Lucide `cloud` at the same 24 px and inset, then the provider's name, so every name in both cards starts at one x; it is not a brand logo, and the rows are name-only otherwise. The status sits on the group, not on each row: one truth per group, and four repeated pills were noise. Status chip: padding 6 12, 14 px, `--r-pill`; the two pastels tell ready from not yet before the words are read, and each carries its own dark ink at 4.5:1 or more.

### FAQ
Native `<details>` as white `--r-content` cards, 12 apart, max 760, centered. Summary 17/600 with a `--muted` "+" that turns 45 degrees. Open and close animate the height: `::details-content` with `interpolate-size:allow-keywords` where supported (block-size 380 ms and opacity 250 ms, `--ease-out`); elsewhere a WAAPI height tween in `public/js/site.js` (find in page still opens an item). Reduced motion: instant.

### Footer (every site page)
Width 1136, a top hairline, padding 56 above. A row that wraps: at the start the logo at `--mark` and bloop at `--wordmark`, then the tagline in 600 `--ink` and two plain sentences in `--muted` (max 420); at the end the links, the address last, in `--muted` 15 px, 44 px rows. Then a hairline rule and "© 2026 bloop" in 14 px `--muted`, 40 below the row.

### Privacy and security pages (opsis `/compare`, restated)
Content 1136 wide. A centered page hero (the h1 at the section size, an optional `.lead`), then:
- **The panel:** the Connect panel's frame (solid sky, padding 12, two white group cards at radius 16): "What the Screen Gets" (each row ends in a 20 px Lucide `check`) and "What the Screen Never Gets" (each row ends in "Never"; titled for the screen, since "What Stays on Your Phone: Your account, Never" read backward, 15/400 `--muted`), 48 under the hero. Rows as the Connect groups' (section 6); both marks `aria-hidden`, since the group heads carry the meaning. No switches: nothing that is not a control looks pressable.
- **Topic cards,** 16 apart: white, `--r-content`, padding 24 (40 from 768); from 900 two columns, `.8fr 1.2fr`, gap 48: the 24/600 h2 at the start, the prose in `--ink-2` beside it. `.topic.wide` is one column, for the retention table and for the points list on `/security`. From 900 each table row is that same `.8fr 1.2fr` grid with gap 48, so a value starts where a topic's prose does: one grid template on the page.

### Item row (the viewer sidebar and the phone list, one face: `core/rows.js`)
One pattern in every list (the sidebar, the sheet, the phone's list): `--row` tall, gap 12, padding 6 inside a 2 px border that stays transparent until `:focus-visible` turns it ink, so focus never moves the layout. Radii chain from the box (section 4): the row's fill `--r-list` - `--list-pad`, its leading 40 px square, 8 in, the row's radius - 8, with a `--hairline` ring: a picture where one exists without a mint (page 1 of the demo deck and PDF, contained whole on the tile as Finder shows a document; the demo photo's own 120 px thumbnail, cover), else a `--paper` type tile with a 24 px ink glyph, always visible. The handle is a row on its own (radius 16, its thumbnail 8 in at 8), so a thumbnail has one radius everywhere. Rows sit 2 px apart, so a selected row and a hovered one never merge. No separators between rows; in the viewer sidebar one inset `--hairline` rule (`.split`) sets the links off from the files. Selected (`aria-current`) is `--g-select`; hover is `--wash`, on a fine pointer only, and with press and the pointer only on a row that is a control (a button, a link, a checkbox or radio label): the phone's approved rows are a record, not controls; never an ink fill, so the glyph never vanishes. A link row is never selected: it is an `<a target="_blank" rel="noopener noreferrer">` with a trailing `arrow-up-right` in `--muted` and "New Tab" for screen readers; it opens the link and leaves the stage as it is. Line 1 the name 15/600 ink, one line, ellipsis in the middle so the extension stays. Line 2 13 `--muted` tabular, 2 below: the kind (PowerPoint, PDF, JPEG image, PNG image, WebP image; a link reads "Link"), then " · " and the size when the item has bytes (a link: its host), then a date only when the source gives one (a live phone: "Edited 10 min ago"; demo items show none rather than a made-up one). Files A to Z, then links.

## 7. Screens

### Screen page (`/s`, the room PC; `/s?mode=demo`, the Demo Room)
Checked at 1440, 834 and the narrowest window. Model for the viewer: the iCloud Drive web app, restated in bloop's tokens; each deviation and its reason is in "Viewer deviations" below.
- **Corner bar** (`/s`, `/a`, `/code` alike): no site header (a kiosk page). On `/s` the bar's controls and the footer stay unseen from the script's start (`is-booting`) to its first paint (`is-ready`), so no Back in a session and no live footer in the demo ever flash; with no script, a failed one or a framed page, the static Back and footer stay, and a read or the screen's create with no answer in 10 s (`FETCH_TIMEOUT_MS`) paints as offline, never a blank page (writes wait, since a slow approve may still land; a browser without `AbortSignal.timeout` waits too). It floats over the page (absolute, `--inset` from the top and the side), so what the page holds is centered on the whole viewport; every control in it is the house frame (section 6). Top left: Back home (waiting, and busy states outside a session; it stops the page's socket and any pending boot first, and from waiting it ends the screen, as New Code does, so its code and demo slot go at once), Back as Start Over (scanned, choosing, a guest's offer), or in a session, transient states included (offline, an error), the logo and bloop, which ends the session and then goes home. Top right: Approve on This Device (demo, waiting) or End (rose, in a session, transient states included, so there is always a way to end and never a Back that leaves a session running). In the viewer from 760, with the list a side panel, End leaves the corner for the left rail's foot, at the bottom left (section 7); the logo stays. The logo asks first, in the page (a popover card, never a native dialog, centered, `--r-stage` so its corners sit one step out from the 24 px pills): "End This Session?" (22/600) and "Your files leave this screen." (`--muted`), then Cancel and End Session (rose) side by side in two equal columns (stacked full width under 480, the rose on top, where two columns would crowd its label), so it never ends a session silently; it goes home at once, the end sent with `keepalive` so it outlives the page (if it fails, the session times out), and the page forgets its sid first, so the browser's Back cannot resume it. Back and End Session leave through one path; a page the browser restores from its back-forward cache reloads, since its socket is gone. "Session Ended" shows nothing else.
- **Waiting, truly centered.** The QR card: white, `--r-stage`, `--sh-frame`, no padding of its own: the QR's 4-module quiet zone is the padding (the QR at half the viewport height at most, and stacked no more than the title, the lines and the code row leave, so the room screen never scrolls; section 10). Its edge is the countdown: a 6 px `--robin-deep` stroke with round caps on the card's rounded edge (the card's own hairline is the track; an empty ring draws nothing, so no cap dot is left) (an SVG `rect`, `pathLength=100`, half outside the card, so it never touches a module) that starts at the top center and shortens toward it, clockwise, over the code's life (`stroke-dasharray` set once a second, a 1 s linear transition between steps; under reduced motion the safety net drops the transition, so it steps once a second; `aria-hidden`). Then two short lines, "Scan with your phone." / "Or enter the code at {host}/code.", and the code row: New Code, then the code card (house frame, Lucide `copy` then the code 22/600 tabular, +0.06em, centered in the card as one group, padding 16, as wide as its code). New Code comes first so it never moves when a code is wider or narrower than the last (where the row is start-aligned, from 900 landscape; centered, the row shifts by half the card's change).
  - **Wide (900 and up, landscape):** two columns, centered as a block on what they draw (the right column `fit-content(600px)`), gap 48 to 112: the QR card on the left, centered on the column's height; on the right the room name (`--display`), the two lines at 22 `--ink-2`, then the code row. 28 read too big beside a 79 px name; 22 is the card-title step, the next one down, and reads as a caption to the name at 1440 x 900, 1280 x 720 and 1024 x 768. Under that, one column, 24 apart: the room name 44, the card, the lines `--muted` at 15 at most (the card's width / 24, from 13: the longest line, "Or enter the code at {host}/code.", is about 23 em, so it holds one line within the QR card's width), the code row.
  - **No page scroll:** `/s` is the window's height and clips, the corner bar fixed; only the side list (and, under 760, the sheet's list) scrolls, inside its own box.
  - **New Code:** ends the waiting screen (`POST /api/screen/end`, which closes a waiting screen and frees its demo slot) and creates a new one by the boot path (fresh QR, code and full ring); `aria-disabled`, its arrow turning, until the new screen's view arrives, so it keeps focus; a second press meanwhile does nothing. Only the newest boot and channel act: a renew bumps a generation, and a view, error or frame from an older channel is dropped. A refused create shows the rate-limited state and retries as boot does.
  - **Copy:** writes the shown code ("K7M Q9X") and announces "Copied" in a polite live region; with no code yet it does nothing.
  - **Woken:** a background tab's timers sleep, so when the page becomes visible again it reads the state at once (and reconnects if the socket is down); an overdue code then rotates at once, so a woken room screen never shows an expired code. A read answered after a newer push is dropped (the channel counts state frames), so an old view never lies over a new one. The phone does the same.
- **Claimed:** the waiting layout in place, nothing moved at any width (measured at 834 and 1440): the title stays the room's name, so it never wraps or moves. The QR card stays where it was, blank of its QR (a reloaded claim no longer knows its code, so a live one hides its QR too: one look either way), and holds the match number: the digits the phone shows, in `--mono` 600 ink at 0.4 of the card, so they read across the room and compare at a glance (the one place bloop sets mono: a number to compare, not a label). No ring. The status is one line in the hint's place, the hint's size and `--ink-2`: "Waiting for Approval" (the code row keeps its height, hidden, so the block stays centered on the card). The line under the title, "Your phone shows 42.", stays for screen readers only. When this browser holds the claim too (it went to `/a` and came back), the status line is "Finish on this device.", with Back and Continue (primary, to `/a`, which resumes the pairing) in the code row's place.
- **Busy states** (live launch states, offline, service down, rate limited, error): the heading and line centered, no QR. In a session, offline and an error park the viewer: it is hidden and keeps its item, page, pictures and minted links. In full screen it stays full screen: the slide and the tap zones hide and the heading shows centered on the ink (22/600, `--surface`), so the slide resumes in place when the session state returns; leaving full screen while parked hides the stage. Only a real end leaves full screen (a hidden full-screen stage is a black room screen). Nothing repaints a parked viewer (a key, a relink, an image load) until the session state shows again.
- **Ended:** "Session Ended" at `--display`, centered with its end line and the demo's waitlist link as one group at the true center of the viewport (the page column is fixed over it, so the bar and footer never shift it), no bar controls. Under it, 16 down, the end line, when there is one: "Time's up." when the clock ended it (a Revoke from the phone says nothing more than "Session Ended") and what a live PC may still hold ("Close PowerPoint to take your slides off this PC.", "Delete {file} from Downloads before you leave.", the download's name in Downloads, from the link). A line, or the demo's "Join the Waitlist" (secondary, in the flow 24 under the heading; the landing's own link), holds the screen `ENDED_HOLD_MS` (10 s); with neither, a fresh code comes after `ENDED_QR_RETURN_MS` (3 s).
- **Footer line** on a live screen in every state: "Phone not with you? Sign in to this PC as usual." None on a demo screen, which has no PC to sign in to.
- **Under 600:** a live screen shows "Use the Room's Screen" (the title's 44, balanced) / 16 under it "Open this page there, then scan its code with your phone." / Enter the Code, centered as one group like every dead end, and starts nothing. A demo screen runs as the waiting screen does at any width, because a phone can be the share screen (handed to a friend to scan): the room name, the QR card with its ring, the two lines, the code row (New Code, the code card), and under it "Approve on This Phone" (primary), 24 apart, in one column. That button is not a corner pill: Back and a 220 px "Approve on This Device" cannot share the top row at 360, so the corner pill is hidden here and the button follows the code row, where the next step reads. "Or open {host}/demo on a laptop..." is gone: with the QR on the screen it said nothing the QR did not. Nothing scrolls: the QR takes the height that is left (at most the column and half the window), never below 205 px (41 modules at 5 px, about 5.4 cm on a phone, which a camera reads from arm's length; at 360 x 640 it is 205), and the lines are `--muted` at 13. A claim shows the match number in the card and "Waiting for Approval", as everywhere. Approving on this phone brings the tab straight back to the viewer.

**The viewer (`/s?mode=demo`, approved to open; `viewer.js`).** Built from the screen's view, so a reload shows it again; nothing launches.
- **Left rail (from 760, 2 items or more):** the logo chip at the top left, where it is on every screen state; the list under it, one `--inset` below, hugging its rows (at most down to End, `--inset` above it, then its own scroll), `--side` wide; End (rose, its normal size) alone at the bottom left, `--inset` from the window's edges. The list is a floating glass panel, `--r-list`, padding `--list-pad`, `--sh-pill`. iCloud Drive's cues: no visible header (the list is labeled "Items" for screen readers: the rows say what they are); item rows (section 6) as buttons; the selected row `--g-select` with `aria-current`, hover `--wash`, all instant. Links follow the files, set off by one hairline with the same 8 clear above and below it (measured from the rows' own fills), so they read as their own group. When the screen's focus would be lost (a scene change), it goes to the selected row, not to the visually hidden h1, with the ring only when the last input was a key (`focusVisible`), so no ring sits on a row nobody tabbed to, and a keyboard user keeps it (WCAG 2.4.7). The stage runs from the rail's right edge plus `--inset` to `--inset` from the right, and the full height between the top and bottom insets (the logo is only over the rail). The stage then carries no visible name and every item's top meets the sidebar's top line (the frame aligns to the start; centered only with no sidebar): the sidebar shows the name (the heading and line stay for screen readers).
- **Under 760:** the sidebar becomes a glass bottom sheet (`popover`, opened by a handle row under the actions: the current item's row, "4 items" and a chevron): full width, padding 20 16 16 (rows 16 from the edge, their thumbnails 24), `max-height:min(72dvh,600px)`, `--r-sheet` top corners, a 36 x 4 `--g1` grab bar, backdrop `rgba(0,0,0,.18)`, rising from below over 350 ms `cubic-bezier(0,0,0,1)` (`@starting-style`); light dismiss, Escape, or a pick closes it. The control pill sits 16 under the item (the phone keeps it under: a column would cost more width than it gains), the handle below the stage.
- **Stage:** with no sidebar, the item's name (22/600, one line, ellipsis) on top. The stage fills the height under the corner bar; the page or picture is the frame itself (`--r-list`, 24, as the list beside it, `--sh-frame`), at its own aspect ratio, as large as fits both ways (`max-width` and `max-height` 100% in a one-cell grid; the pill's room is padding only where it sits under the item and the item makes room), so nothing is ever cut or letterboxed, and a portrait page gets a portrait frame. A new page or item cross-fades in over 200 ms from scale .985; selection is instant and interruptible.
  - Deck or PDF (the demo account's): its pre-rendered pages (`public/img/demo-slide-*`, the same pages for both; alt "Slide 1 of 2" or "Page 1 of 2"); page 1 of every item is fetched ahead when the list is built. Landscape pages step one at a time: the slide's own left and right halves (sized to the picture by a `ResizeObserver`, so the paper beside it never pages) are invisible buttons, "Previous Slide" and "Next Slide", with the focus ring when focused and, on hover (fine pointer), a 40 px glass disc with a chevron at the slide's edge; hidden at either end. Portrait pages (page 1 taller than wide, `pageMode` in `core/demo.js`) scroll as one column, at most 860 wide, 24 apart; the page indicator follows an `IntersectionObserver`, never a scroll listener. The indicator sits inside the control pill, before Present: "1 / 2", 15/600 `--muted` tabular. Arrow keys and Page Up/Down step a page (a scrolling document scrolls to it), only while focus is not in the list or a field.
  - Image: its minted view link in an `<img>`, contained. The `<img>` is kept for the session and dropped at the end: the CSP has no `blob:`, and a second mint would spend the item's budget. Until the picture arrives, the row's thumbnail holds the stage at once (no fade), blurred on `--g1`, in the photo's own box at its fitted size (the demo photo's 3 : 2, by container units), so the picture replaces it with no jump; a refused mint shows the card.
  - Link: a white card, max 440, `--r-card`, padding 32, centered in the stage: the type tile, the host 22/600, the title 14 `--muted`, and "Open vevox.com" (primary, `target="_blank"`, `rel="noopener noreferrer"`, https only). Never a frame.
  - A guest's own file (no pages, no view): the same card with its kind and size.
- **Control pill,** one liquid glass pill (section 4 glass, `--glass-edge` then `--sh-pill`), 60 tall (8 + a 44 button + 8, so the button is concentric), padding 8, as wide as its contents (so the page indicator stays one line): the page indicator ("1 / 2", 15/600 `--muted` tabular, padding 0 8), then only the actions that apply: Present (secondary, white; for pages and any loaded image, on every device, since presenting needs no browser full screen) then Download (primary, ink; a file once the session has left `approved`; it mints that item's download link, or restarts one it started under a minute ago). On a live screen, the line "The copy stays in this PC's Downloads." sits under Download.
  - **Placement is a slot check, not a size comparison** (`fit()` in `viewer.js`, the decision `placeControls` in `core/demo.js`). Where the list is a side panel (from 760, two items or more) the item fills the stage, contained, and the controls never shrink it: they take the first free spot. (1) Under the item, the pill centered `--inset` below it, when the slack above and below the item holds the pill and that inset; item and pill are then centered together as one block (the frame's bottom padding is the pill's room, `is-under`). (2) At the stage's bottom right as a column `--stack` (140) wide, when the slack beside the centered item holds it and an inset (a tall item). (3) As the same column anchored to the rail's foot, its bottom edge on End's and its right edge on the list's right edge, when the free height between the list's bottom and the foot holds it and an inset (the list never shrinks to make room: a longer list falls to (4), and a list too long for the rail scrolls inside itself above End). (4) Otherwise, with the list full, the pill floats over the item's foot at bottom center, `--inset` above the stage's edge. Anywhere else (under 760, one item, a card, a scrolling document) the pill is `--inset` under the item and the item makes room (a scrolling document gets it at the stage's foot). The ratio is the file's own (the stand-in is 3 : 2), known once the image has loaded, and `fit()` re-runs when the list, the pill or End changes size. The column reads "1 / 2" when paged, then Present and Download at one width, in `--r-stage`. **Switching items is quiet:** the pane's entry animation plays once, when the viewer first appears, never on a switch; the controls are one node that stays put and runs no animation while their place and shape are the same. When the slot changes, or the shape (the page count appears, a pill becomes a column), or the item moves them, they glide there over 300 ms (a FLIP from where they were last drawn, translate and scale on the same node, the centering kept in `translate`); a window resize moves them instantly. The old item stays on the stage until the new one has decoded, then swaps at once (no fade from blank). Reduced motion: no glide.
  - **Presenting** (`present(on)` in `viewer.js`, the body class `is-presenting`, the one layout the phone remote reuses): the item fills the window edge to edge on `--ink` inside the safe-area insets, with no radius or shadow; the corner bar, the sidebar or sheet and its handle, the pill and the footer hide; Previous and Next stay as the tap zones, and a swipe pages on touch (over 50 px). A "Stop Presenting" pill (44 tall, centered on the window at the top, 16 down plus the safe area, `--glass-solid` with no blur, so a blue slide never tints it) is hidden when presenting starts and follows the pointer to the window's top: its opacity is 0 beyond 160 px from the top edge and rises to 1 within the top 64 px (or the pill's height plus its inset, if larger), set from `pointermove` through one animation frame and a `--stop-o` property, with no layout read beyond the pointer's `clientY`; it takes a click only from half opacity, fades in over 200 ms and out over 300 ms, and goes a second after the pointer rests outside the band or leaves the window; the cursor hides after 2 s idle. Reduced motion has no ramp and no fade: shown in the band, hidden outside it. A touch has no pointer to follow, so a tap on the slide (not Previous or Next) shows it for 3 s, and a swipe does not. Tab focus shows it fully and it stays while focused; Escape, and leaving browser full screen, also exit. Where `requestFullscreen` exists (a desktop), Present also takes the view full screen, so both look the same; where it does not (iPhone Safari has element full screen for video only), the layout is the page's own. Offline or an error while presenting holds the stage with the status line on the ink, as full screen did; only a real end leaves it.
- **One item:** no sidebar and no handle; a lone deck or PDF is the stage and its pill, a lone image the stage and its actions, a lone link the centered card.

| State | Heading | Line | Controls |
|---|---|---|---|
| waiting | Room 2.14 (or "Unregistered screen") `[V-7]`; Demo Room | (the code card and its line) | demo: Approve on This Device (a same-tab link to `/a?c=` the code) |
| scanned, choosing | the room name (Demo Room) | Waiting for Approval (in the hint's place; "Your phone shows 42." for screen readers; the 42 in the QR card) | Back = Start Over |
| scanned, choosing, this browser holds the claim | the room name | Finish on this device. | Back = Start Over, Continue |
| approved (live) | Approved | Opening Lecture 4.pptx. | End |
| opening (live) | Opening in PowerPoint | Lecture 4.pptx (when the launch needs a click: "Lecture 4.pptx. Click Open to start PowerPoint.") | End; Download It Instead (after 5 s); Open (primary) only when the launch had no user gesture or a popup was blocked |
| open (live) | Open in PowerPoint (only after a PowerPoint launch; otherwise "Opened") | Lecture 4.pptx. Ends by itself at 11:35. `[V-2]` | End, Download It Instead |
| demo, approved to open | the item on the stage | (the viewer) | End; Present, Download as they apply |
| open fallback | PowerPoint Didn't Open | Download the file, then open it from Downloads. | Download, Show as PDF Instead (text), End |
| PDF fallback | Showing as a PDF | Lecture 4.pptx. PowerPoint can't open it on this PC. Animations and videos won't play. | End |
| PDF file | Opened as a PDF | Lecture 4.pdf. (the file is a PDF, so nothing failed) | End |
| guest offer | Sent by a Guest | Talk.pptx. Open it here when you're ready. (the line under the title, at line size: only a claim's status takes the hint's place) | Open, Back = Start Over |
| guest file open (live) | Open in PowerPoint | Talk.pptx. bloop deletes its copy when this ends at 11:35. `[V-5]` | End |
| ended | Session Ended | the end line (above), or none | none; demo: Join the Waitlist (secondary, the site's waitlist link) |
| expired | no change: the code already refreshed; the phone explains | | |
| offline | This Screen Is Offline | Reconnecting. After 5 s add: Sign in to this PC as usual to open your file. In a session instead: Reconnecting. You can still end from your phone. | none (retry 5 s, backing off to 30 s) |
| service down | bloop Isn't Responding | Sign in to this PC as usual. | none |
| rate limited (creating the screen was refused, `rate_limited`) | Too Many Demos Right Now (`/s?mode=demo`); Too Many Screens Right Now (live) | Trying again by itself. | none (retries by itself: 5 s, 10 s, then every 30 s) |
| error | Unable to Open Your File | Try again on your phone, or sign in to this PC as usual. | none (new QR after 5 s) |

Each heading change is announced in a `role="status"` region; error uses `role="alert"`. A live screen keeps its PowerPoint launch ladder; the viewer is the demo's.

**Viewer deviations from the iCloud Drive model (each with its reason)**
| bloop | iCloud Drive | Why |
|---|---|---|
| floating glass sidebar, 280 wide, at `--inset` | flat full-height pane, 250, 1 px divider | the owner's ruling: one glass across the product; wider because rows carry larger type read from across a room |
| 56 px two-line rows, 40 px thumbnails, name 15/600 | 32 px one-line rows, 20 px glyphs; list rows 41 or 61 px, 24 px thumbnails, name 17/400 | read from a distance; kind and size fold into line 2 because a column layout needs 600 px or more; 600 because the system has only 400 and 600 |
| selected row `--g-select`, focused or not | gray5, tint fill when focused | an ink fill hid the row's glyph and shouted; one light fill reads the same from across a room |
| no visible header, no separators between rows, one inset rule before the links, 8 clear on each side | headers per section, 1 px separators | one section the screen reader names "Items"; rhythm and the fill tell rows apart, and a rule adds noise beside a selected row; the one rule marks where rows stop selecting and start opening a tab |
| no sort headers, no path bar, no name over the stage | sort menu, 35 px path bar | a fixed order (files A to Z, links last), and the selected row already names the item; 12 px is unreadable from the back of a room |
| bottom sheet under 760 | the pane slides in over the content | the stage must stay visible under the list |
| invisible left and right tap zones over the slide; the indicator in the control pill | (no stage) | buttons on or under the frame covered the slide or cost a row; halves of the slide are the largest targets that are plainly the slide's, and show nothing until hovered or focused |
| QR at half the viewport height, the match number in it at 0.4 of the card | spec draft: QR 240, digits 64 | the distance table in section 10: 240 px reads to about 1.5 m on a 65 inch display |
| the countdown is the QR card's own edge | spec draft: a 4 px bar under the QR | the owner's ruling: the frame is the timer, as a watch ring; the bar was one more thing under the code |
| reduced motion swaps at once | spec draft: a 150 ms cross-fade | the house safety net in `base.css` already turns every animation off; one rule, no exception |

### Phone page (`/a`, opened by the camera)
- **Frame** (`/a` and `/code` alike): the corner bar with Back alone (home, or back to `/s?mode=demo` when this tab is also the demo screen; no logo; hidden whenever a state's actions hold its way out, Done, Enter the Code or Revoke, so no state has two exits), then a column on paper, max 480, at least one viewport tall, padding `--pad` (at the sides at least the safe-area inset, so a large phone held landscape keeps the title and buttons clear of its sensor housing). The page itself scrolls. Under 640 wide, or under 600 tall below 900 wide (a phone held landscape; a short laptop window, and a large phone of 900 or more held landscape, keep the two columns), `/a`'s buttons stay at the foot, sticky in a glass band (section 4) with `--r-sheet` top corners (a sheet at every width up to 640, where it is narrower than the window), so they stay in reach of a long list; from 640, and on `/code` at every width, they sit 24 under the content; from 640 wide and 600 tall (and from 900 wide at any height) `/a`'s column is centered in the viewport when shorter than it, as the results are; from 900 under 600 tall the two columns keep only `--inset` under the list, so it shows more rows. Back, and Done on a state reached mid-claim (busy, empty, needs admin), let go of a claim not yet approved (claimed, choosing) first (`POST /api/cancel`), so the screen shows its code again at once, and a second tap meanwhile does nothing. Otherwise Back is a plain link (a modified click opens a tab) that keeps the pid, so a live session can still be revoked, and so does a cancel the server refuses (the approve landed first); Back during an approve is safe for the same reason: whichever lands first, the pid stays while a session needs it; Done forgets it. A page restored from the back-forward cache reloads, as `/s` does.
- **Desktop (900 and up, with a list):** two columns, max 1040, gap 64, centered in the whole viewport (padded the corner bar's height at the foot as at the top): the room title (48), its lines, the scope and the buttons side by side on the left (400); the list on the right, scrolling inside its own card (`overscroll-behavior:contain`).
- **Approve:** the title is the room (34/600, -0.035em, left, as the screen's room title; "Registered screen" 14 `--muted` under a registered room `[V-7]`); then the list, no label over it (`aria-label="Items"`): one row per item (section 6), in the one item order (files A to Z, then links), the same before and after approval; the whole row a checkbox on a demo phone, a radio on a live one (a live screen shows one file, so a live phone selects one file and sees no links), a trailing Lucide `check` on selected rows and nothing on the rest, press `--wash`; the last row "Add a File" (a `--paper` plus tile, no tick) opens the guest path. A demo room selects its whole catalog; a live phone starts with its newest file. Then the scope line (live only) and Cancel then Approve. The match digits ride on the primary, "Approve (42)" (and "Send (42)" for a guest), digits tabular at the label's weight, named "Approve, code 42 on the screen": the person compares them with the screen's "Your phone shows 42." before the tap that commits, so they sit where the eye already is. On the one-device demo the button is plain "Approve" (this tab is the screen: nothing to compare), and approving returns the tab to the viewer.
- **Approved:** "Approved for Demo Room", under the title, as status, "Ends in 59:12" (17 `--muted` tabular, counted down here from the view's `endsAt` and `now`; `--robin-ink` from 5 minutes left; " · Reconnecting" while the link is down) `[V-2]`; then the approved items read only, with no ticks (a record, not controls), and Revoke (rose), which ends the session as End did. Revoke is the one way out: no Back in a session (as the screen hides Back), so the control that keeps the person in charge is never one stray tap behind. Revoke is one tap with no confirm, on purpose: it is the safety control, and speed matters more than the rare wrong tap (the screen's logo asks first because it also leaves the page).
- **Pairing kept:** the pid lives in `localStorage` (`pidStore` in `core/store.js`), so a closed tab can come back to Revoke; it is dropped on every end the phone sees, on cancel and on every refusal, only when it is this tab's own, and dies with the session on the server. A result (Session Ended, Approval Canceled) is final: a refusal pushed after it (the screen dropping the pairing on its next code, a reconnect after the pid died) is ignored, closes the channel and drops the pid, never turning the result into "This Code Has Expired".

| State | Title | Body | Buttons |
|---|---|---|---|
| checking | (skeleton title bar) | Checking the code. | none |
| match | Room 2.14 | a skeleton list | continues to choose |
| choose (nothing selected) | Room 2.14 | the list | none besides the Add a File row |
| approve | Room 2.14 | the list; Only the file you select goes to the screen. The screen never gets your account. `[V-4]` | Cancel, Approve (42) |
| approve, demo | Demo Room | the list, the whole catalog selected | Cancel, Approve (42) |
| unregistered screen | as approve, plus one card (Lucide `triangle-alert`, sentence in `--ink` 600; no tint, no stripe) | This screen isn't registered. Only approve if you can see it in front of you. `[V-7]` | Cancel, Approve (42) |
| (choose, approve, unregistered screen, signed in to OneDrive) | as that state | as that state | Disconnect OneDrive (text) first: deletes bloop's stored access and signs out every phone (`POST /api/me/disconnect`), then shows first use |
| first use | Connect Your OneDrive | bloop reads your files from OneDrive. You do this once, on this phone. `[V-9]` | Add a File (text, the guest path) `[V-10]`, Cancel, Connect OneDrive |
| needs admin | Your IT Must Approve bloop | Ask your IT team, or sign in to the PC as usual. | Done |
| sign-in declined (`/auth/callback` page) | bloop wasn't given access. | bloop can't read your slides without it. Scan the code on the screen to try again. | Enter the Code |
| sign-in failed (`/auth/callback` page: state, issuer, exchange) | Couldn't sign you in. | Scan the code on the screen to try again, or sign in to the PC as usual. | Enter the Code |
| needs admin (`/auth/callback` page) | as needs admin | as needs admin | none |
| empty | No Files Found | Save a file to OneDrive, then scan again. | Add a File (text), Done |
| approving | as approve | | Cancel, Approving... (button loading) |
| opening, open | Approved for Room 2.14 | the items read only; Ends in 59:12 | Revoke (rose) |
| (opening, open and guest sent, when this tab is also the demo screen) | as that state | as that state | Revoke (rose), then See It on the Screen (primary, back to `/s?mode=demo`) |
| open fallback | PowerPoint Didn't Open | Tap Download on the screen to open it there. | Revoke |
| PDF fallback | Showing a PDF on Room 2.14 | PowerPoint can't open it there. Animations and videos won't play. | Revoke |
| PDF file | PDF Opened on Room 2.14 | Lecture 4.pdf | Revoke |
| ended | Session Ended, the screen's noun; title, line and Done centered in the viewport as one group, Done 24 under the line (under 640 the title and line are centered and Done stays in the band) | live: Close PowerPoint on the room PC and delete any download there. (until V-1 passes; then "The screen's link to your file has stopped working." `[V-1]`); demo: none (the title stands alone) | Done |
| canceled | Approval Canceled, laid out as ended | Nothing was shared. | Done (no Back: a terminal state has one way out) |
| expired | This Code Has Expired, laid out as ended (a dead end, a state with no list whose way out is Done or Enter the Code, centers its title, line and actions as a group; where the band shows (under 640 wide, or under 600 tall below 900) the actions keep it and the title and line are centered above; a session state with Revoke alone keeps the approved layout, since it is still live) (a page opened with no code and no pairing: Scan the Code / Point your phone camera at the code., which keeps Back: it was never a code) | Scan the new code on the screen. | Enter the Code (primary, the one exit: no Back) |
| taken | This Code Was Already Used | Scan the new code on the screen. | Enter the Code (primary, no Back) |
| typed wrong (a claim from the QR) | Check the Code | Check the code on the screen and try again. | Enter the Code (primary, no Back) |
| offline | You're Offline | Check your connection, then try again. | Try Again (in an approved session: Revoke, then Try Again, which only returns to the session since the failed call may have landed, and no Back, so the way out never leaves the session running; when Revoke itself failed, Revoke alone) |
| error | Unable to Open Your File | Check the file opens on your phone, then try again. | Try Again (as offline) |
| guest: choose | Send a File to Room 2.14? | Choose one .pptx or .pdf file from this phone. Only this file goes to the screen. ("this device" on one device; the types are said before the picker opens, so a refusal is never the first word of them; "Only this" is tied with a no-break space, so the second sentence never leaves its first word behind) | Cancel, Choose File (reached from a list by Add a File, Cancel goes back to the list, and Back stays the one way out) |
| guest: confirm | Send Talk.pptx to Room 2.14? | bloop deletes its copy when this ends. `[V-5]` | Cancel, Send (42) |
| guest: sending | Sending Talk.pptx | (progress bar) | Cancel |
| guest: file refused | This File Can't Be Sent | Choose a .pptx or .pdf file under {N} MB. `[V-10]` | Choose File (from the list's offer: Cancel, back to the list, then Choose File) |
| guest: sent | Sent to Room 2.14 | Open it on the screen when you're ready. | Cancel |
| guest: pass needed | Get a Guest Link First | Open it on this phone, then scan the code again. | Done |
| guest: off | This Screen Can't Take Files | Sign in to the PC as usual to open your file. (the room's guest drop is switched off) | Done |
| rate limited | Too Many Scans Right Now | Wait a minute, then scan the code again. | Done |
| busy (storage full, or this month's R2 operation cap reached) | bloop Can't Take Files Now | Try again in a few minutes, or sign in to the PC as usual. | Done |
| framed | Open This Page Directly | | none |

The page moves focus to the new title on each state change. "its copy" is deliberate: bloop's stored upload is deleted, but a downloaded copy on the PC is open item 1.

Typed code page (`/code`, the same frame, one column): title "Enter the Code"; one field 56 tall, `--r-field`, its `--g2` ring turning 2 px ink on focus (the one ring, no outline), the code 22/600 tracked +0.06em as the screen shows it (16 px or more keeps iOS from zooming), 6 characters, label "Code", `autocapitalize="characters"`, `autocomplete="one-time-code"`, `inputmode="text"`, shown in two groups of 3; Continue (primary) enabled at 6 characters; a failed claim shows one sentence beside the field (`typedError` in `copy.js`: "Check the code on the screen.", or the expired ("That code changed. Enter the new one."), used, offline and too-many-tries sentences, each one line at 390, so Continue never moves); a look-alike the alphabet leaves out says so as it is typed ("Codes don't use 0, 1, I, L, O or U."); the sentence's row is kept while empty (24), so the first bad letter never moves Continue; success goes to the match state.

### Security page (`/security`; `/it` answers 301 to it from `public/_redirects`)
h1 "Security", lead "What the room PC can and cannot reach." (its own line, not the landing's; also the description), then the panel (section 6): What the Screen Gets: "The items you approve", "A link to each, which expires"; What the Screen Never Gets: "Your account", "Your other files". Then three points in one wide topic card (the panel already says each link expires):
1. Each code works once for 60 seconds, and the phone shows the room before Approve. `[V-6]`
2. Each open ends by itself after 90 minutes, or 60 in the demo, and is logged for IT to export. `[V-2]`
3. A downloaded copy can stay on the PC. Every room is audited, and the results are published. `[V-1]` (until V-1 passes: "A downloaded copy can stay on the PC. See what can stay." linking `#stay`)

Then one topic card per row below (each `[V-5]` until the build confirms it), the row name as its h2 in Title Case ("What the PC Holds", "What bloop Keeps", "Permissions", "What Can Stay Behind", "Threat Model", "Removing Access", "Status"). Each fact is said once: the points own the 60 seconds and the 90 minutes, Removing Access owns the Disconnect, My Apps and Entra steps:
| Topic | Content |
|---|---|
| What the PC holds | A session ID and a link to each approved item, in the browser's session storage. While a file is open, PowerPoint holds the copy it opened. PowerPoint may also get a Microsoft download link for the file, which can work for up to 1 hour. (Last sentence: redirect mode only, threat model OPEN-03; delete it in stream mode.) |
| What bloop keeps | Your email, a OneDrive token, the ID of one folder, and a log of who opened which file where and when. No slide content, except a guest's upload, deleted when its session ends. |
| Permissions | bloop asks for read access to OneDrive. Microsoft grants that for the whole OneDrive; bloop reads one folder and logs every read. Where your tenant allows it, the app folder limits access at Microsoft's side, but then only files in that folder appear. |
| What can stay behind | A downloaded copy, recent file names and opened tabs with their history can stay until the profile is wiped. Each room is audited; results are published per room. `[V-1]` (the last sentence ships only once V-1 passes) |
| Threat model | QR relay: the phone also shows the screen's match code before Approve. Shoulder surfing: a seen code is spent or soon expires. Forgotten session: it ends by itself. Wrong screen: unregistered screens carry a warning. Lost phone: see Removing Access (a link to `#remove`). |
| Removing access | Once OneDrive is connected, tap Disconnect OneDrive on any phone while you approve: bloop deletes its stored access and every sign-in ends at once, a lost phone's included. You may also be able to remove bloop in My Apps (myapplications.microsoft.com); your IT team can remove it for everyone in Microsoft Entra. (the same sentences as Your Choices; the first covers a lost phone too; "Once OneDrive is connected" keeps them true while the file source is mock and no phone shows the button on `/privacy`. Disconnect is `POST /api/me/disconnect`: the grant and every phone session go at once. My Apps and Entra end only the refresh token, so they are not said to sign anyone out) |
| Status | No external audit yet. The source is public. Report a security issue: security.txt. |

### Privacy notice (`/privacy`, draft until the legal lane, OD-5)
`noindex`; the same nav, panel, topic cards and footer as `/security`; the retention table sits in a wide topic card. The retention rows restate `docs/threat-model.md` section 10; change both together.
| Slot | String |
|---|---|
| h1 | Privacy Notice |
| Draft line (the hero's lead) | This notice is a draft until **bloop**'s legal review. |
| Panel | as on `/security` |
| Who Is Responsible | **bloop** runs this service. Write to hi@bloop.here with any question about your data. |
| What bloop Keeps (table) | Your email and account ID: While you stay connected, then 30 days. / Your OneDrive access, encrypted: Until you disconnect (deleted at once) or remove bloop in My Apps or Entra (deleted the next time it fails), or 30 days unused. / A log of who opened which file, in which room, and when: 180 days. For the demo, 7 days. / A guest's file: Deleted when the talk ends, and after 1 day at most. / Your phone's sign-in: 30 days unused, 90 days at most. / Usage counts, with no names: 90 days, then daily totals for 2 years. / Waitlist: the email and answers you send: Kept to invite you to early access, until you ask for them to be deleted or the waitlist closes. / Waitlist: who handles the form: Tally (tally.so) runs the form for **bloop**. It collects your role, where you would use **bloop**, your organization, your next step, your timing and your email, and keeps them until you ask for deletion or the waitlist closes. |
| After the table | bloop keeps no slide content from your OneDrive. A guest's file is the one exception, and it is deleted when the talk ends. `[V-5]` |
| Why | To open the file you approve on the screen you choose, to keep the service safe, and to give your organization's IT team a record of what was opened where. |
| Where | Your data is stored in the EU on Cloudflare, except waitlist answers, which Tally holds. Cloudflare is a US company, and each request is handled at its nearest data center. (threat model DATA-03: never "UK only" or "never leaves") |
| Your Choices | Once OneDrive is connected, tap Disconnect OneDrive on any phone while you approve: **bloop** deletes its stored access and every sign-in ends at once, a lost phone's included. You may also be able to remove **bloop** in My Apps (myapplications.microsoft.com); your IT team can remove it for everyone in Microsoft Entra. To see or erase what **bloop** holds about you, write to the address above. |

`/.well-known/security.txt` (RFC 9116): `Contact` (hi@bloop.here), `Expires` (at most a year ahead), `Preferred-Languages: en`. Renewing it is in `docs/setup.md`.

## 8. Motion

One language: `--ease-out` for anything that appears or moves, `--ease-ui` for presses, linear for progress and opacity dips. Only `transform` and `opacity` animate, plus the FAQ's height and the nav's glass. A scene change on `/s` replays the enter keyframes on the page column by a class (no View Transitions: one path, and the bytes went to the v3.1 controls). Glass enters with the scene and nothing else: no refraction, no sheen.

| What | When | Duration | Easing |
|---|---|---|---|
| press | input | 150 ms | `--ease-ui` |
| stage tilt | scroll, at every width, not under reduced motion | sprung: stiffness 120, damping 30, mass .4 (CSS fallback: scroll-linked) | the spring |
| "Anywhere" sheen | from 0.3 s after load, repeating | 3.6 s a cycle: an orange band (`--robin-deep` edges, `--robin` core) sweeps left to right across the ink word through `background-position` in the first 1 s, then the word rests in ink for 2.6 s, and again, without end | `--ease-out` on the sweep |
| Try the Demo arrow | hover | 200 ms, 2 px to the right | `--ease-out` |
| FAQ open, close | toggle | 380 ms height, 250 ms fade, 300 ms "+" turn | `--ease-out` |
| nav scrolled | the top sentinel leaves or enters view | 240 ms glass and shadow | `--ease-out` |
| QR refresh | every 60 s | 150 ms out, 150 ms in | linear opacity |
| `/s` QR ring | each second | 1 s between steps | linear |
| viewer page or item | select, step | 200 ms opacity 0 and scale .985 to rest | `--ease-out` |
| New Code arrow | while the new screen loads | 0.8 s a turn | linear |
| `/s` scene change (a state, or the item on the stage) | enter | 380 ms opacity 0 and 12 px rise to rest | `--ease-out` |
| viewer bottom sheet | open | 350 ms from below | `cubic-bezier(0,0,0,1)` |
| page step, row selection, hover | input | instant | |

"Anywhere" rests in `--ink`, the color of the h1 and of Present, and an orange band sweeps across it every 3.6 s (`background-clip:text` over the same ink): a saturated `--robin-deep` band with a lighter `--robin` core, a 1 s sweep and then a rest. Why: presence without a halo; the one accent as a pulse, not a resting color (the old resting orange and the wash behind it read as decoration). A blurred glow muddied the letter edges, and a gradient at rest read as the gradient tell section 13 bans; the word at rest is ink, so contrast is the h1's own. The band runs only under `@supports` and with motion allowed; elsewhere the word is simply ink. Mid-sweep frames are not held to contrast: the band is a moving highlight.

Reduced motion (`prefers-reduced-motion:reduce`): the stage rests flat (the spring never starts); the sheen never plays and the word is ink like the rest of the h1; the FAQ switches instantly; the `/s` QR ring steps once a second with no glide; scene changes swap at once; the blanket rule in `base.css` is the safety net. Nothing autoplays except the sheen's pulse, which is decoration and stops under reduced motion; the QR refresh is essential (a code must expire), so it has no pause.

## 9. Logo and social image

- `public/favicon.svg` is the logo: a circle and one even-odd path for the "b" (stem, bowl and counter), traced by hand from the owner's artwork and checked against it at full size and at 16 px.
- `tools/render-og.py` renders from it: `public/og.png` (1200 x 630: the logo and wordmark, the h1 on one line at 90 px, the sub in `--muted`, on paper) and `public/apple-touch-icon.png` (180 px, the mark on paper, since iOS fills transparency with black). `tools/og.svg` is the editable source of the OG image.
- `og:image` and `og:url` are absolute URLs on the production host.

## 10. The QR

| Item | Spec |
|---|---|
| Library | an established generator, not a custom encoder: uqr 0.1.3 (MIT, an ESM port of Nayuki's generator; `encode(text, {ecc:'M', minVersion:4, maxVersion:4, border:4})` returns the matrix, drawn as one SVG path); vendored with its whole-line comments removed (the code is unmodified; `tools/trim-uqr.mjs`), in the JS budget; qrcode-generator is the alternative |
| Content | `https://{host}/a?c={code}`: the 6-character pairing code, in the query because camera apps may drop a fragment `[V-12]`. The phone strips it with `history.replaceState` when its modules load. The query can reach request logs and a Referer, which is bounded: a code works once and lives 60 seconds (10 s grace) |
| Mode, version | byte mode, level M, pinned to version 4 (33 x 33 modules) so the size never jumps |
| Quiet zone | 4 modules each side, inside the white panel: 41 modules across |
| Rendering | integer device pixels per module, `shape-rendering:crispEdges`, no CSS scaling after layout, square modules, #1D1D1F on #FFFFFF, never inverted, no logo, no rounded or colored modules, never animated while shown |
| Screen size | module = `floor(room * DPR / 41)` device px, room = half the viewport height, or less when stacked: the height the title, lines and code row leave (`qrSize`, `fitQr`); 1080p: 13 px, 533 px wide; 1366 x 768: 9 px, 369 px |
| Refresh | every 60 s; next code fetched at 50 s; the old code fades to white over `--d1`, then the new one in; the old code stays valid 10 s; a scanned code locks to that phone, which then has 2 minutes to approve |
| Match code | 2 digits, 00 to 99 (leading zero kept), on the screen after a scan, in the QR card (`--mono` 600 ink, 0.4 of the card; its line "Your phone shows 42." is for screen readers) and on the phone's Approve button; compared, not typed |
| Typed fallback | 6 characters of uppercase Crockford base32 in two groups of 3 ("K7M Q9X"), rotating with the QR, entered at `{host}/code`; on `/s` only, never on the landing |
| Accessibility | `role="img"`, `aria-label="QR code. Scan it with your phone camera to open bloop. Or enter the code K 7 M, Q 9 X at {host} slash code."`; the label updates silently |

Size by distance (width = distance / 8, a floor to confirm on site, open item 6): at 1080p a 65 inch display (0.75 mm/px) needs 167, 333 and 500 px at 1, 2 and 3 m; a 2.5 m wide projection (1.3 mm/px) needs 96, 192 and 288 px; a 24 inch monitor serves about 1.5 m. The 533 px default covers a 65 inch display to about 3.2 m and a projection to about 5.5 m.

## 11. Page performance

Stack and system architecture: `docs/architecture.md` and `docs/adr/`.

### Loading order (every page)
1. HTML with two CSS `<link>`s in the head, render-blocking in order: `base.css` (tokens, reset, buttons, glass: what every page uses), then the page's own, `site.css` or `app.css`. A page never loads the other side's rules, so each side's budget moves on its own. No inline scripts, `style` attributes or `<style>` elements (the CSP forbids them); CSSOM writes (`el.style.left = ...`) are allowed and are how the viewer sizes its tap zones.
2. Font preload for the one subset; the metric-matched fallback means the swap shifts nothing.
3. `<script type="module">`, deferred by default: `site.js` on the landing only; the task pages' own modules.
4. The hero stage's picture has its width and height, so it shifts nothing; it is the one image request (section 6).

### Budgets (internal targets; Google's "good" lines in brackets)
| Metric | Landing | `/s` | `/a` |
|---|---|---|---|
| First-view requests | 7 or fewer (HTML, 2 CSS, font, site.js, favicon, the stage picture) | 7 or fewer | 6 or fewer |
| CSS, font, browser JS, landing JS | the `size-limit` entries in `package.json`, the only owner. The v3.1 app pass raised browser JS and the CSS entry, after cutting the swipe handler, the View Transitions path and long header comments: the house frame, the QR ring, Copy and New Code, the match digits on Approve, and the approver's desktop layout cost more than the cuts gave back. The v3.2 room screen raised browser JS and the app CSS for the presenting layout, its swipe and the adaptive pill, and the demo photo and the hero fallback for the new photo (a 1280 wide grass photo, where the old one was a 750 wide portrait), each with about 2 percent of headroom | same | same |
| LCP | 1.2 s desktop, 1.8 s on slow 4G [2.5 s] | 1.5 s | 1.5 s on 4G |
| CLS | 0.02 [0.1] | 0 | 0.02 |
| INP | 100 ms [200 ms] | 100 ms | 100 ms |

## 12. Accessibility

### Contrast pairs
| Pair | Ratio | Use |
|---|---|---|
| `--ink` on `--paper` / white | 15.6 / 17.0:1 | text, pill labels inverted |
| `--paper` on `--ink` | 15.6:1 | primary pill label |
| `--muted` on `--paper` / white / `--g-select` / the wash | 5.2 / 5.8 / 4.62 / 4.67:1 | secondary text, a selected row's meta line, a hovered row (`test/unit/pages.test.ts` holds 4.6 on each) |
| `--lead` on `--paper` | 7.3:1 | the hero and page leads |
| `--robin-ink` on `--paper` / white | 5.0 / 5.6:1 | the name in body copy, 600 |
| `--g2` on `--paper` | 2.3:1 | rings only (the outline pill's label is ink), never text |
| QR #1E1E1C on white | 17.0:1 | modules |
| `--robin-deep` on white | 4.0:1 | the QR ring (a graphic: 3:1 needed) |
| `--rose-ink` on `--rose` | 5.6:1 | End and Revoke |
| `--ink` / `--muted` on glass over paper (#fafaf9) | 16.0 / 5.5:1 | the control pill, the phone's sticky actions |
| `--ink` on glass over an ink slide (#aaaaa9, the worst case) | 7.2:1 | the page count in the control pill |

### Rules
| Topic | Rule |
|---|---|
| Targets | two button heights: 52 for a page's actions (on `/s` too: Continue, Join the Waitlist), 44 in a pill (the viewer's) and the nav; 44 minimum for any hit area (nav links, the Waitlist pill and the menu button, footer links, FAQ summaries) |
| Focus | the ink ring on every interactive element; never on hidden UI (the closed menu sheet is `display:none`) |
| Keyboard | "Skip to Content" first; Tab follows reading order; summaries toggle with Enter and Space; Enter on `/a` activates Approve only when it is focused |
| Live regions | the `/s` heading in `role="status" aria-live="polite"`; failures `role="alert"`; `/a` moves focus to the new title |
| QR | label in section 10; the match code is announced with the scanned state |
| Images | logos are `alt=""` beside the visible name; icons and the How It Works stills are `aria-hidden`; the stage picture has alt text; the menu button is labeled Menu |
| Language and zoom | `<html lang="en-US">`; zoom never disabled; holds at 200 percent and reflows to 320 CSS px |
| Forms | the code field has a visible label, 16 px or more, errors beside it in text plus icon |

## 13. Quality bar (checklist for every screen)

A screen is done when every box passes; `test/unit/site-pages.test.ts` and `test/e2e/landing.spec.ts` check the measurable ones.

- [ ] **Hero:** at most 40 words; the h1 one sentence of at most 6 words, on one line from 640 (at most two under it); the sub names the QR code, the phone and presenting in at most 2 sentences and 30 words.
- [ ] **Whole landing:** 80 to 300 words (How It Works and the close add about 30), FAQ answers included; every sentence at most 20 words; at most 4 FAQ items; every heading and label at most 5 words.
- [ ] **Try the demo** is the hero's one button, in the first view, and opens `/demo`, the close repeats it; every Waitlist link opens the Tally form and carries `data-waitlist`.
- [ ] **Nav:** one `nav` landmark, the same on every site page; the menu works with no script; the scrolled look comes from an observer, never a scroll listener.
- [ ] **Stage:** flat at rest and under reduced motion; a framed screenshot with alt text; no Source link anywhere.
- [ ] **Never-say grep:** no hit from `tools/never-say.txt` in any page or string; no nothing-stays, no sign-in-is-gone, no runs-everywhere, no freshness claim.
- [ ] **Mobile (390):** no horizontal scroll, targets at least 44 px.
- [ ] **Contrast:** WCAG AA on every text and control; axe and Lighthouse accessibility 1.0 in CI.
- [ ] **Budgets:** section 11.
- [ ] **No tells:** no gradient, glow or glossy button, except the robin accents (the "Anywhere" sheen and the warm backdrop under the stills and the close panel, sections 5, 6 and 8); no eyebrow or mono kicker (the match number is not a kicker); no two-tone headline; no status dots or tinted icons; glass only on the surfaces section 4 lists, in its one recipe; no fake logos, testimonials or counts; no em or en dashes, exclamation marks or emoji.

### Coherence
One of each: type scale (600 and 400), card (flat white on paper), button shape (the pill in three roles), radius logic, shadow recipe (the stage frame, the QR card, glass), motion language, icon style (Lucide, stroke 2, only where it carries meaning), product pictures as real HTML fragments of the app in a `--paper` still. One voice (section 3); the same sentence for the same claim on every page.

## 14. Inspiration and credits

Nothing is copied (no copy, assets, fonts or code); each lesson is restated in bloop's own system.
| Site | Taken | Avoided |
|---|---|---|
| ample.computer | the paper and ink palette, the type scale, ink and outline pills, the neutral grid of icon, title and line, white FAQ cards, the footer (tagline, plain lines, a rule, the year) | its long scroll stories |
| opsis.app | the top glass nav pill and its menu sheet, a plain two-word h1, the scroll tilt of the hero stage and the spring that smooths it, the brand-color glow at the top of the page that tints the glass, the list card with status pills, the privacy panel; from `/compare`: the centered page hero, white topic cards with the heading beside the prose, and a tint panel framing white cards | its density, its glossy gradient buttons, a FAQ that jumps, the `/compare` table and its paintings |

Photo: the demo's Dog.jpg is Unsplash photo-1759721367037-232697bcd378 (Unsplash License), 1280 wide, progressive JPEG quality 50 by `cjpeg` (at the size it shows, 978 wide at 1440 and up to 1280 presenting, it is not told from quality 80), metadata stripped (`src/worker/seams/file-source/demo-files/demo-dog.jpg`, its thumbnail `public/img/demo-dog-thumb.webp` 120 x 120 around the dog).

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
