# bloop design

The one source of truth for bloop's brand, visual design, UI and UX. It extends the house ui-design system (`tokens.css`, light values) with the overrides in section 4; where this file is silent, the house system applies, so this file holds only bloop's own decisions. Strings marked `[V-n]` depend on an unverified product property: ship the string only once open item n (section 15) passes, otherwise ship the fallback given there. Every screen passes the checklist in section 13 before it is called done.

## 1. Brand

### Idea
bloop puts your slides on a shared screen. You scan the code on the screen, choose your file on your phone and tap Approve; it opens in PowerPoint, and the screen never gets your account. The brand is the calm of a handover that just works: a quiet light page, one live code, and a large low-poly robin at the center of the story.

### Name and wordmark
| Rule | Value |
|---|---|
| Wordmark | the word `bloop`, lowercase, Inter 600, tracking -0.02em, `--t1`; no logotype, no icon lockup |
| Sizes | nav 21 px; footer 17 px; `/s` 21 px; OG image 40 px |
| Name-swappable | one build constant (`SITE_NAME`) injected into every page, title, meta tag and string; never baked into an image except the OG image, which a script regenerates; never in the favicon (the robin head) |
| In sentences | lowercase `bloop`, even at the start of a sentence |
| Never | a stylized letter, a gradient, a period after the wordmark, the name inside the QR |

### The robin
| Aspect | Rule |
|---|---|
| Role | the center of the page: the largest object in the hero and the explorer; the screen, the phone and the file arrange around it |
| Look | the CC0 low-poly robin (credit in section 14), flat-shaded in its own 8-color palette (section 9); proportions untouched |
| Its orange | the breast #FF7702 is a character color: it lives only inside the robin and never appears in CSS; the UI accent stays the pastel `--acc` |
| Behavior | still at rest; moves only with scroll, drag, a step control or a real session event (look toward the code, hop on scan, turn to the phone, carry the slide); at most one moving thing on screen at a time |
| Never | enlarged eyes, blinking, expressions, speech bubbles, text, hats or costumes, waving, idle loops, appearing in an error to soften it, more than one robin per screen |
| Size | hero and explorer: at least 40 percent of the viewport height at 1440 (section 5); compact: centered, 280 to 320 px; `/s`: 160 px poster |

## 2. Principles

| # | Principle | Test |
|---|---|---|
| 1 | Calming first. Light only, gray and white, one accent, restrained motion. | Squint: only the primary action and the robin's breast are orange, never side by side at the same size. |
| 2 | The robin is the hero. One large object carries the page; the product UI sits around it. | At 1440 and 390 the robin is the largest visual in the first two viewports. |
| 3 | Far less text. Apple-short, straight to the point. | Section 13 word caps pass on every viewport. |
| 4 | Relevant. Every element is about the handover (code, phone, approval, file, screen). | Delete any element that would make sense on another product's page. |
| 5 | Looks finished. Real copy, real states, real product UI, designed empty, loading and error states. | No lorem, no "Coming soon", no unstyled state, no painted fake UI. |
| 6 | Concentric geometry. Inner radius = outer radius minus inset. | Every nested corner passes the formula in section 4. |
| 7 | Coherence over collage. Each borrowed pattern is restated in this one system or dropped. | Section 13 coherence list passes. |

### The five decisions
| Decision | Value |
|---|---|
| Accent | house pastel orange on the one primary action, the selection marker and the focus ring; its two tints on the stage and story-card grounds |
| Type roles | display 64, title 48, headline 28, lead 21, body 17, small 14; weights 400 and 600 |
| Layout concept | a centered two-beat headline over a big rounded stage where the robin stands with the screen, phone and file around it |
| Signature element | the large robin at the center of the handover |
| Tone | plain and short; lecturers on the landing, IT on its own page |

## 3. Voice and copy

### Rules
| Rule | Example |
|---|---|
| Name the object, then the payoff, each a short sentence with a period. | "Your slides. On any screen." |
| Headlines at most 8 words; one sentence of at most 20 words per section (section 13). | |
| Lead with slides for lecturers; security leads only for IT. | |
| Security as concrete never-statements: actor, verb, specific thing. "X, never Y" is allowed; "not X, but Y" is not. | "One file, never an account." |
| Conditions go in a footnote or on `/it`, never into the marketing sentence. | |
| Plain beats clever: no puns, no analogy on the landing, no unexplained noun. | |
| "session", "token" and "tenant" stay off every user-facing screen; only `/it` may use them. | "End", "Ended." |
| Contractions yes. Never "we", "our team", "oops", "uh-oh". | |
| Errors: what happened, no blame, what to do, one verb button. | "Unable to open your slides." |
| Digits for all numbers, units tight: 60 s, 90 minutes, 1 file. | |
| Sentences in sentence case with a period; UI labels (buttons, nav, chips, toasts) in Title Case. | "Try the Demo", "How It Works" |
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
| meta description | Scan the code with your phone and choose your file. It opens in PowerPoint. The screen never gets your account. |
| `<title>` `/it`, `/s`, `/a` | bloop for IT and AV; bloop screen; Approve on bloop |

**Hero**
| Slot | String |
|---|---|
| h1 | Your slides. On any screen. |
| Sub | Scan the code with your phone and choose your file. It opens in PowerPoint. The screen never gets your account. `[V-4]` |
| Actions, desktop | Try the Demo (primary: scrolls to and focuses the live code in the stage); How It Works (secondary) |
| Actions, touch | Send Me the Link (primary); Enter a Code (text) |
| Nav | links How It Works, For IT; CTA Try the Demo (desktop) or Send Me the Link (touch) |
| Share sheet text | Try bloop on a computer: {url} |

**Demo states in the stage screen**
| State | Heading | Line |
|---|---|---|
| waiting | Demo screen | Scan with your phone camera to try it. |
| scanned | Check your phone. | It should show 42. |
| approved | Approved. | Opening the sample deck. |
| open | The sample deck is open. | This page has no account. It was shown one file. Action: Run It Again (text) |
| ended | Ended. | Scan the new code to try again. |
| error | Unable to start the demo. | Action: Try Again |

**How it works (pose explorer)**
| Slot | String |
|---|---|
| Heading | Choose on your phone. Present on the screen. |
| Scan | Point your phone camera at the code on the screen. |
| Check | Your phone shows the room name and a 2-digit number, so you know it's the right screen. `[V-7]` |
| Present | Choose your file and tap Approve. It opens in PowerPoint on the screen. `[V-8]` |
| End | Tap End on your phone or on the screen, or it ends by itself after 90 minutes. `[V-2]` |
| Control row | Drag to turn the robin. Buttons: Turn Left, Turn Right |

**Facts (diagonal)**: heading "What the screen gets."
| Numeral | Caption |
|---|---|
| 1 file | Only the file you choose. `[V-4]` |
| 0 accounts | The screen never gets your account. `[V-4]` |
| 60 s | Each code works once, then a new one appears. `[V-6]` |

**Story cards**
| Headline | Sentence | Product UI inside |
|---|---|---|
| Between lectures | Walk in, scan the code and choose this week's slides on your phone. | `/a` choose file, Lecture 4.pptx ticked |
| Guest speakers | No account needed. A guest sends one file from their phone, it opens on the screen, and bloop deletes its copy when the talk ends. `[V-10]` `[V-5]` | `/a` guest confirm with Send |
| For IT | One file, never an account. See exactly what the screen receives on the IT page. | `/s` open state; the card links to `/it` |

**Closing and footer**
| Slot | String |
|---|---|
| Closing | Try it in your lecture room. / Early access is free while bloop is being tested. `[V-20]` / button Ask for Early Access (mailto to the role address `[V-13]`) |
| Footer line | Your slides on any screen with a web browser and PowerPoint. |
| Footer links | How It Works, For IT, Read the Source, Report a Security Issue |
| Credit, legal | Robin model: CC0 (credit in section 14). / © 2026 bloop. |
| 404 | This page isn't here. / Check the address, or go to the home page. / button Go to the Home Page |
| No JavaScript | stage "The live demo needs JavaScript."; `/s` "This screen needs JavaScript to show a code."; `/a` "Approving needs JavaScript. Turn it on, then scan again." |

State strings for `/s` and `/a` are in section 7 with their screens.

## 4. Tokens

### Override table (everything else is house `tokens.css`, light block, as is)
| Token or rule | House | bloop | Reason |
|---|---|---|---|
| Themes | light, dark, sepia | light only: delete the dark media block, `[data-theme=dark]`, `[data-theme=sepia]`; `color-scheme:light` | fixed decision |
| `--font` | system stack with Inter | `"Inter","Inter Fallback",Arial,sans-serif`, self-hosted | one face on every device, Windows lecterns included; never rely on a local install |
| Mono | Geist Mono | not loaded; codes use Inter with `tabular-nums` | one font file |
| Type scale | house 11 to 34, display 48+ at 700 | the scale below, 400 and 600 only, body 17 | no 700 |
| Eyebrow | banned | banned on every page | house rule and the hero word cap |
| Bold lead-ins | banned as inline headers | only the open explorer card's label and a fact numeral | the pose explorer pattern |
| Selection marker | graphite inversion | `--acc-ink` fill (active explorer marker, file tick) | accent on selection is a fixed decision |
| Plain links | `--acc-ink` allowed | `--t1`, underlined | accent stays on action, selection and focus |
| Nav glass | `blur(6px) saturate(180%)` | `--glass-solid` (white .82) with `blur(20px) saturate(180%)`; white .96 without `backdrop-filter` | text and the robin scroll under the nav |
| Containers | 440, 720, 960 | add `--w-wide:1200px` | the stage and the explorer |
| Compact margin | 16 | 24 | calmer at 390 |
| Radius | 10, 14, 20, 24, pill | add `--r-stage:32px` (stage, story cards) and `--r-device:48px` (phone mock) | one large-container radius; device frame |
| Cards | 20 cards, 24 sheets | one card treatment: `--card`, `--r-card` 20, `--sh1` plus hairline | one card style per site |
| Tints | none | `--tint:#FFF5EE`, `--tint-2:#FFEFE4` (the accent mixed into white at 14 and 22 percent) | the story-card tint rule |
| Status colors | `--ok`, `--warn`, `--err` | not used | a state is a plain sentence in `--t1` plus the object changing |
| Buttons | capsule, 14 when stacked | every button is a pill, stacked ones included | one button shape per site |
| Shadow | `--sh1..3` | add `--sh-float:0 0 0 1px rgba(29,29,31,.06),0 30px 60px -30px rgba(29,29,31,.35)` | one deep shadow under a device |
| Section rhythm | none | `--sec` 128 / 96 / 80 px by tier | the reference rhythm |
| Motion | 150, 250, 400, 500 | kept; add `--rise:12px` | entrance rise |
| QR module | none | `--qr-mod` 6 px, 5 px when the viewport is under 760 px tall | the code fits the fold |
| Robin box | none | `--robin-hero:clamp(320px,60vh,560px)`; `min(80vw,320px)` under 600 | bar 7 |

The accent is the house orange (`--acc:#FFB783`, `--on-acc:#4E2600`, `--acc-ink:#8D4F1B`). White on orange fails AA and never ships. Tokens live in `assets/site.css` after house `tokens.css`; this file is the source and the CSS restates it.

### Story-card tint rule
- One tint family, drawn from the accent: `--tint` and `--tint-2` only. No second hue, no gradient, no tinted text, no tinted shadow, no deeper step (`--t2` fails AA on the next one).
- A tint is a ground for real product UI. A tinted shape holding no product UI is decoration and is banned.
- The hero stage uses `--tint`; the three story cards run `--tint`, `--tint-2`, `--tint`. Nothing else on the site is tinted.

### Type scale
| Role | Large (1200+) | Medium | Compact (under 600) | Line height | Tracking (L / M / C) | Weight |
|---|---|---|---|---|---|---|
| display (h1) | 64 | `clamp(46px,2.9vw + 22px,58px)` | 40 | 1.06 | -0.032 / -0.03 / -0.026em | 600 |
| title (h2) | 48 | 40 | 32 | 1.1 | -0.028 / -0.026 / -0.022em | 600 |
| headline (h3, story and explorer labels) | 28 | 24 | 22 | 1.22 | -0.021 / -0.019 / -0.018em | 600 |
| lead (hero sub) | 21 | 19 | 19 | 1.43 | -0.017 / -0.015 / -0.015em | 400 |
| body | 17 | 17 | 17 | 1.53 | -0.013em | 400 |
| button, chip label | 17 | 17 | 17 | 1 | -0.013em | 600 |
| small | 14 | 14 | 14 | 1.43 | -0.006em | 400 |
| micro | 12 | 12 | 12 | 1.33 | 0 | 400 |
| fact numeral | 80 | 64 | 48 | 1 | -0.032em | 600 |
| code (typed fallback, match code) | context size | | | 1 | +0.06em, `tabular-nums` | 600 |

Measure 60 to 72 characters (`max-width:36em`). Nothing under 12 px. Headings `text-wrap:balance`.

### Font
- `@font-face` "Inter" from `/assets/inter-latin.woff2?v=1`, `font-weight:400 600`, `font-display:swap`, the Latin `unicode-range` (U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD).
- "Inter Fallback": `local("Arial")`, `size-adjust:107.1%`, `ascent-override:90.4%`, `descent-override:22.5%`, `line-gap-override:0%` (starting metrics; open item 11).

### Radii, elevation, layers
| Group | Values |
|---|---|
| Radii | `--r-sm` 10 (skeletons), `--r-card` 20 (every card), `--r-sheet` 24 (true sheets), `--r-stage` 32, `--r-device` 48, `--rr` pill (buttons, chips, nav) |
| Concentric rule | `r_inner = r_outer - inset`, inset equal on every side, floored at 4 px; a bar holding a pill is a pill. Nav 52 with 8 inset holds a 36 pill; phone mock 48 with 8 bezel gives a 40 screen; a sheet inset 8 in that screen takes 32; a panel filling a story card at 24 inset takes 8. Devices placed freely on a stage are objects, not nested panels, and keep their device radii |
| Hairline | `box-shadow:0 0 0 1px var(--bdr)` (never a border, so no layout shift) |
| Shadows | `--sh1` cards; `--sh2` nav and toasts; `--sh3` sheets; `--sh-float` devices |
| Blur | nav 20 px; scrim 3 px; nothing else; never animated |
| Z-layers | stage objects 1, robin 2, nav 50, toast 60, scrim 70, sheet 80, skip link 90 |
| Breakpoints | compact under 600, medium 600 to 1199, large 1200+; check at 390, 834, 1440 |

## 5. Layout

| Tier | Width | Container | Margin | Grid |
|---|---|---|---|---|
| compact | 390 | 100% minus margins | 24 | 1 column, 16 gap |
| medium | 834 | `min(100% - 48px, 960px)` | 24 | 8 columns, 24 gap |
| large | 1440 | `min(100% - 48px, 1200px)` | 120 at 1440 | 12 columns, 24 gap |

- One grid per page; every section uses the same columns. Hero text is centered; every later section is left-aligned on the grid.
- Text blocks never exceed 720 px or 72 characters; the hero sub is capped at 600 px.
- The hero has no entrance animation and no `min-height:100vh`.
- Landing order: nav, hero with stage, how it works (explorer), facts, story cards, closing, footer.

### Hero fold check at 1440 x 723
| Item | Top | Height | Bottom |
|---|---|---|---|
| nav (12 offset + 52) | 0 | 64 | 64 |
| gap, h1 (2 lines at 64/1.06) | 64 | 40 + 136 | 240 |
| gap, sub (2 lines at 21/30) | 240 | 16 + 60 | 316 |
| gap, actions (48) | 316 | 28 + 48 | 392 |
| gap, stage top edge | 392 | 40 | 432 |
| robin box (434 at 723), right side, 25 percent above the stage edge | 323 | 434 | 757 |

The robin's head and body sit in the first viewport; the stage's screen and phone come up within the first 300 px of scroll. The stage is 1200 wide and `max(560px, 76vh)` tall.

### Nav centering rule
The nav pill's center and its link group's center each sit within 1 px of the viewport's center (`document.documentElement.clientWidth / 2`, scrollbar excluded) at every width from 360 to 1920, measured by a script in 10 px steps, never judged by eye. Build: the pill is centered with `margin-inline:auto`; its content is a grid `1fr auto 1fr` (wordmark start, links center, CTA end), so a wider wordmark or CTA never shifts the links; the CTA keeps its space while hidden.

## 6. Components

All components are house components restyled by tokens, except the stage and the robin. Shared states: hover is an 8 percent `currentColor` overlay under `@media (hover:hover)` only (links thicken the underline to 2 px); focus is `outline:2px solid var(--acc-ink);outline-offset:2px` on `:focus-visible`, never removed; active is `scale(.97)` on buttons and `.985` on cards over `--d1`; disabled is content opacity .38 with no hover; loading swaps the leading icon for a 16 px spinner with a progressive label ("Approving...") and a locked width.

### Floating nav pill
| Property | Value |
|---|---|
| Position | `position:sticky;top:12px`, centered per the centering rule, `z-index:var(--z-nav)` |
| Size, shape | height 52 (48 under 600); width `min(100% - 24px, 1024px)` compact, `min(100% - 48px, 1024px)` above; `--rr`; padding 8 (6 under 600) |
| Surface | `--nav-bg`, `backdrop-filter:blur(20px) saturate(180%)`, hairline, `--sh2`; solid under `prefers-reduced-transparency` |
| Content | wordmark start; 2 links center (17 px 400 `--t1`, 44 px hit area, underline on hover only); CTA end |
| CTA | primary pill 36 tall, padding 0 16; 44 hit area via a `::before` inset of -4 px. Hidden (`visibility:hidden;opacity:0`, space kept, `tabindex="-1"`) while the hero actions are in view, so the first view never shows two primary buttons; fades in over `--d1` after |
| Compact | wordmark plus CTA; links live in the footer; no hamburger |
| Current page | `aria-current="page"` link in 600 weight |

### Buttons
| Type | Fill / label | Size | Use |
|---|---|---|---|
| primary | `--acc` / `--on-acc`, `--sh1` | 48 tall, padding 0 24, pill; full width on compact | the one primary action per view |
| secondary | `--bg2` / `--t1` | 48 tall, pill | How It Works, End, Cancel |
| text | none / `--t1` 600, underline on hover | 44 hit area | Enter a Code, Run It Again, Download It Instead |
| stacked (phone pages) | primary then secondary, full width, 52 tall, gap 8 | | Approve, Cancel |

No destructive variant: no bloop action destroys data.

### Hero stage (the orbit)
The opsis stage and the ample orbit in one component: a big rounded `--tint` ground holding real product UI, with the robin as the center the other objects arrange around.
| Part | Spec |
|---|---|
| Ground | `--tint`, `--r-stage` 32, no shadow, no border, full container width, `max(560px, 76vh)` tall |
| Robin | the largest object: a `--robin-hero` square at the stage's right, feet on the stage floor line, top 25 percent above the stage edge; poster first, then the live renderer (section 9) |
| Screen | a display mock (thin `--t1` bezel, 20 outer, 12 inner) at the stage's left showing the real `/s` component in its demo state with the live code at `41 x --qr-mod`; `/s` runs full screen in a room, so the mock has no browser chrome |
| Phone | the phone mock at the robin's left, overlapping the screen's lower right corner by 48 px, showing the real `/a` sheet in sync with the demo state |
| File | one file row as a floating `--card` pill between phone and screen: "Sample deck.pptx" |
| Orbit | the three objects sit on an ellipse around the robin; their places are fixed and change only with demo state (the file row moves from the phone to the screen on approved, over `--d3`); nothing circles or loops |
| Live demo | desktop only (`(hover:hover) and (pointer:fine)`): scanning drives the demo states in section 3; the robin reacts per section 8; one change at a time |
| Touch | no live code; the screen shows the open state; the robin centered, with the screen and phone side by side below it at 0.8 scale |
| Height lock | every state swaps in place inside fixed boxes (no CLS) |

### Phone mock
A CSS device frame: 240 x 492 (280 x 574 on the stage at large), `--r-device` 48, 8 px `#1D1D1F` bezel drawn as an inner ring, screen radius 40, `--sh-float`, a 72 x 20 pill at the top center. The screen renders the real `/a` components scaled with `transform:scale()` from a 390 px layout; its text is `aria-hidden` with a visually hidden summary.

### Window chrome rule
Window chrome (title bar, traffic-light dots, tabs) is allowed only on a faithful mock of a real app window showing bloop's real UI, matching its platform (macOS dots only on a macOS window). It is banned as decoration: fake terminal art, code-editor panels, dots on a box that is not an app window. The room screen mock has none.

### Pose explorer (how it works)
| Part | Spec |
|---|---|
| Layout (large) | columns 1 to 5: the open card and the collapsed chips; columns 6 to 12: the robin in a 560 box, no frame. A sticky scroll scene: 100vh plus 3 x 60vh of scroll, the inner stage pinned |
| Open card | the card treatment, padding 24: label 28 px 600 ("Scan."), one sentence 17 px 400 `--t1`, then the control row: "Drag to turn the robin." 14 px `--t2` with two 44 px round `--bg2` buttons, Lucide `rotate-ccw` and `rotate-cw`, labeled Turn Left and Turn Right (30 degrees per press) |
| Collapsed chips | pill 48 tall, `--bg2`, a 24 px plus icon in a 32 circle, then the label in 600; tapping opens it |
| Active marker | the open card's 32 circle filled `--acc-ink` with a white minus |
| Scroll link | scroll progress picks the step (4 equal bands) and drives the robin's pose blend through `setPose` (section 9); tapping a chip scrolls to its band, so scroll and chips never disagree |
| Change | card height and radius over `--d2`; within a band only the robin's blend moves; the card swaps when the band changes |
| Drag | turns the robin's yaw only and eases back to the step's yaw over `--d4`; Turn Left and Turn Right do the same (WCAG 2.5.7) |
| Compact | no pin; the robin centered on top (280 box), the chips as a scroll-snap row, the open card below |
| Keyboard | chips are `role="tab"` in a `tablist`, the open card is the `tabpanel`; arrows, Home, End; Tab leaves the group |
| Fallback | without JS, without scroll timelines or under reduced motion: no pin; all four cards open as a list, each with its still |

### Fact devices (diagonal)
- Three devices staggered on a diagonal: columns 1 to 4, 5 to 8, 9 to 12, each 96 px lower than the one before; compact is one column with no stagger.
- Each device shows the real UI that proves its fact (1 file: `/a` choose file with one file ticked; 0 accounts: `/s` open state; 60 s: `/s` waiting with the code), then the numeral at the fact size, 600 `--t1`, then the caption 17/26 `--t2`, at most two lines, max 280 px.
- No card, icon or border around a numeral; it sits on `--bg` and never counts up.

### Story card
- `--tint` or `--tint-2` ground, `--r-stage` 32, padding 24, no shadow. Three in a row at large (columns 1 to 4, 5 to 8, 9 to 12); a scroll-snap row below that, the next card peeking 32 px.
- Headline 28 px 600 `--t1`, sentence 17 px `--t2`, then a device with the product UI named in section 3, bleeding off the card's bottom edge and clipped by the card's corners.
- The For IT card is one link to `/it` (whole card, one focus ring); the others are not interactive.

### File row (phone)
In a grouped list (the card treatment, hairlines inset 20). Row 60 tall: Lucide `presentation` 24 in `--t2`; file name 17 px 600, one line, middle ellipsis; second line 14 px `--t2` "Edited 10 min ago"; trailing 24 px tick circle, filled `--acc-ink` with a white check when selected, a 1.5 px `--bdr-ui` ring when not. Up to 5 rows (the most recently edited .pptx files), the first selected; loading shows 5 skeleton rows.

### Status chip, toast, data flow, footer
- **Status chip** (`/s` only): `--bg2` pill, 28 tall, padding 0 12, 14 px 600 `--t1`, text only, never a dot or a tint, shown only after the object itself shows the state: Scanned; Lucide `check` 14 then Approved; Lucide `wifi-off` 14 then Offline. If removing it loses no information, remove it.
- **Toast**: bottom center, 24 above the safe area, `max-width:min(360px,100% - 48px)`, pill, `--card`, hairline, `--sh2`, 15 px `--t1`, 4 s, paused on hover or focus, `role="status"`. Strings: "Link Copied", "New Code Ready".
- **Data-flow panel** (`/it` only): one `--card` panel, padding 24, three labeled nodes on one hairline with arrowheads: "Phone: you choose and approve", "bloop: keeps your Microsoft sign-in, encrypted", "Screen: gets one file link". One diagram, not three cards.
- **Footer**: top hairline, padding 48 0 calc(48px + safe area), 14/20 `--t2`; large: wordmark and line (columns 1 to 4), links (6 to 9), credit and legal (10 to 12); compact: stacked, links in 44 px rows.

## 7. Screens

### Which story a visitor gets
`(hover:hover) and (pointer:fine)` gets the desktop story (the live demo code in the stage; the session JS starts only then). Everything else gets the touch story (Send Me the Link, Enter a Code, the stage in its open state, no QR, no backend call). Both ship in the HTML and CSS shows one; h1 and sub are identical.

### Landing, 1440
```
          ( bloop            How It Works   For IT            [Try the Demo] )  CTA hidden in hero
                                 Your slides.
                                On any screen.
            Scan the code with your phone and choose your file.
              It opens in PowerPoint. The screen never gets your account.
                         [Try the Demo]   (How It Works)
+--------------------------------------------------------------------[  ROBIN  ]---------+
| tint stage  +------------------------+   ( Sample deck.pptx )      [ 434-560 ]         |
|             | Demo screen  [ QR ]    |   +-------+                 [  px     ]         |
|             +------------------------+   | phone |                                     |
+--------------------------------------------------------------------------------------- +
 Choose on your phone. Present on the screen.     (pinned)       [ robin 560, setPose ]
 [ - Scan. Point your phone camera at...   Drag to turn the robin. (<) (>) ]
 ( + Check )  ( + Present )  ( + End )
 What the screen gets.   [phone] 1 file   [screen] 0 accounts   [screen] 60 s   (diagonal)
 [ Between lectures ]  [ Guest speakers ]  [ For IT ]   tinted, real UI inside
 Try it in your lecture room.   [Ask for Early Access]          footer
```
At 834 the order holds: the stage at 0.8 scale with the robin at 52vh, facts in two staggered columns, story cards scrolling. At 390: h1 in 2 lines, sub, Send Me the Link (full width) and Enter a Code, then the stage with the robin centered (about 300 px) above the screen and phone; the explorer with the robin centered, the chip row and the open card; facts in one column; story cards as a snap row.

Send Me the Link calls `navigator.share({title, text, url})`; without it, it copies the URL and shows "Link Copied"; without clipboard access it opens `mailto:?subject=bloop&body={url}`.

### Screen page (`/s`, the room PC), 1440 and up
- No nav pill (a kiosk page); wordmark top left at 32 inset; status chip top right.
- Left: the QR panel (card treatment, quiet zone inside) at 50 percent of the viewport height, with the robin's 160 px poster perched on its top edge (poster only, CSS hop on scan). Right, 64 px away, vertically centered: heading 48, line 28/34 400, the refresh capsule (a 48 x 8 pill whose `--acc-ink` fill grows linearly over the code's 60 s, `aria-hidden`, no seconds counter), then "Can't scan? On your phone, go to {host}/code and enter" with the typed code at 34 px 600.
- Footer line in every state: "Phone not with you? Sign in to this PC as usual." 17 px `--t2`.
- 834: stacked, QR first. Under 600: no QR; "This page is for the room's screen." / "Scan the code on the screen with your phone." / Enter a Code.

| State | Heading | Line | Controls |
|---|---|---|---|
| waiting | Room 2.14 (or "Unregistered screen") `[V-7]` | Scan with your phone camera to present your slides. | none |
| scanned | Check your phone. | It should show 42. (QR at .12, match code 120 px over it, chip Scanned) | none |
| choosing | Check your phone. | Choose a file, then tap Approve. | none |
| approved | Approved. | Opening Lecture 4.pptx. (64 px check for 400 ms) | none |
| opening | Opening Lecture 4.pptx | in PowerPoint on this PC. | Download It Instead (text, after 5 s); Open (primary) only when the launch had no user gesture or a popup was blocked |
| open | Lecture 4.pptx is open in PowerPoint. | Ends by itself at 11:35. `[V-2]` | End (secondary), Download It Instead |
| open fallback | PowerPoint didn't open. | Download the file, then open it from Downloads. | Download, Show as PDF Instead (text), End |
| PDF fallback | Showing Lecture 4.pptx as a PDF. | PowerPoint can't open it on this PC. Animations and videos won't play. | End |
| guest file open | Talk.pptx is open in PowerPoint. | bloop deletes its copy when this ends at 11:35. `[V-5]` | End |
| ended | Ended. | Scan the new code to present. (QR returns after 3 s) | none |
| expired | no change: the code already refreshed; the phone explains | | |
| offline | This screen is offline. | Reconnecting. After 5 s add: Sign in to this PC as usual to open your slides. | none (retry 5 s, backing off to 30 s) |
| service down | bloop isn't responding. | Sign in to this PC as usual. | none |
| error | Unable to open Lecture 4.pptx. | Try again on your phone, or sign in to this PC as usual. | none (new QR after 5 s) |

Each heading change is announced in a `role="status"` region; error uses `role="alert"`.

### Phone page (`/a`, opened by the camera), 390
Top to bottom: wordmark 17 px centered; title 28/34 600; room row (Lucide `monitor` 24, room name 17 px 600, second line 14 `--t2` "Registered screen" `[V-7]`); match code (label "Code on the screen", digits 48 px 600 tabular, "Check it matches the screen."); the file group; the scope line with Lucide `lock` 14; stacked actions above `env(safe-area-inset-bottom)`. On a computer the page sits in a 440 px centered column under "This page is meant for your phone. You can approve here too."

| State | Title | Body | Buttons |
|---|---|---|---|
| checking | (skeleton title bar) | Checking the code | none |
| match | Open slides on this screen? | Room 2.14, Lectern PC. Code on the screen: 42. Check it matches the screen. | continues to choose |
| choose file | Choose your slides. | Your recent slides (file rows) | a tick selects one |
| approve | Open Lecture 4.pptx on Room 2.14? | Only this file goes to the screen. The screen never gets your account. `[V-4]` | Approve, Cancel |
| approve, demo | Open the sample deck here? | This is a demo. You don't need an account. | Approve, Cancel |
| unregistered screen | as approve, plus one card (Lucide `triangle-alert` 20, sentence in `--t1` 600; no tint, no stripe) | This screen isn't registered. Only approve if you can see it in front of you. `[V-7]` | Approve, Cancel |
| (any of choose file, approve, unregistered screen, signed in to OneDrive) | as that state | as that state | plus Disconnect OneDrive (text): deletes bloop's stored access and signs this phone out, then shows first use |
| (any of choose file, approve, approve demo, unregistered screen, first use, empty) | as that state | as that state | plus Send a File Instead (text, before Disconnect OneDrive): the guest path, for a phone with no OneDrive to choose from `[V-10]` |
| first use | Connect your OneDrive. | bloop reads your slides from OneDrive. You do this once, on this phone. `[V-9]` | Connect OneDrive, Cancel |
| needs admin | Your organization needs to approve bloop. | Ask your IT team, or sign in to the PC as usual. | Done |
| empty | No slides found. | Save a .pptx file to OneDrive, then scan again. | Done |
| approving | | | Approving... (button loading) |
| opening | Opening on Room 2.14. | Lecture 4.pptx | none |
| open | Open on Room 2.14. | Lecture 4.pptx. Ends by itself at 11:35. `[V-2]` | End |
| open fallback | PowerPoint didn't open on the screen. | Tap Download on the screen to open it there. | End |
| PDF fallback | Showing as a PDF on Room 2.14. | PowerPoint can't open it there. Animations and videos won't play. | End |
| ended | Ended. | The screen's link to your file has stopped working. `[V-1]` (96 px "away" still) | Done |
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
| rate limited | Too many tries. | Wait a minute, then scan the code again. | Done |
| busy (storage full) | bloop can't take files right now. | Try again in a few minutes, or sign in to the PC as usual. | Done |
| framed | Open this page directly to approve. | | none |

The page moves focus to the new title on each state change. "its copy" is deliberate: bloop's stored upload is deleted, but a downloaded copy on the PC is open item 1.

Typed code page (`/code`): title "Enter the code on the screen."; one field of 16 px or more, 6 characters, label "Code", `autocapitalize="characters"`, `autocomplete="one-time-code"`, `inputmode="text"`, shown in two groups of 3; Continue (primary) enabled at 6 characters; a wrong code shows "Check the code on the screen and try again." beside the field; success goes to the match state.

### IT page (`/it`)
h1 "The PC gets one file. Never an account." `[V-4]`, then the data-flow panel, then four points:
1. The PC holds a link to one file, and the link expires.
2. Each code works once for 60 seconds, and the phone shows the room before Approve. `[V-6]`
3. Each open ends by itself after 90 minutes and is logged for IT to export. `[V-2]`
4. A downloaded copy can stay on the PC. Every room is audited, and the results are published. `[V-1]`

Then the detail table (each row `[V-5]` until the build confirms it; compact stacks every row), with the phone mock beside the first two rows at large and no robin:
| Row | Content |
|---|---|
| What the PC holds | A session ID and a link to one file, in the browser's session storage. The link expires. While the file is open, PowerPoint holds the copy it opened. |
| What bloop keeps | Your email, a OneDrive token, the ID of one folder, and a log of who opened which file where and when. No slide content, except a guest's upload, deleted when its session ends. |
| Permissions | bloop asks for read access to OneDrive. Microsoft grants that for the whole OneDrive; bloop reads one folder and logs every read. Where your tenant allows it, the app folder limits access at Microsoft's side, but then only files in that folder appear. |
| What can stay on the PC | A downloaded copy in Downloads and the file name in recent lists, until the profile is wiped. Each room is audited; results are published per room. |
| Threat model | QR relay: the phone shows the room name and a match code before Approve. Shoulder surfing: the code works once and lasts 60 seconds. Forgotten session: it ends by itself after 90 minutes. Wrong screen: unregistered screens carry a warning. Lost phone: disconnect bloop from any device. |
| Revoking access | The user disconnects bloop; an admin removes the app in Entra. |
| Status | No external audit yet. The source is public. Report a security issue: security.txt. |

## 8. Motion

One motion language: the house durations (`--d1` 150, `--d2` 250, `--d3` 400, `--d4` 500, exits half) and one easing family (`--ease`, `--ease-enter`, `--ease-exit`; linear for opacity, progress and scroll-linked values; no springs, no overshoot). At most one thing moves at a time. Motion explains a state change or follows the visitor's own scroll or drag; nothing loops. Only `transform` and `opacity` animate.

| What | When | Duration | Easing | Notes |
|---|---|---|---|---|
| hover, color, press | input | `--d1` | `--ease` | |
| chip expand, disclosure, chip swap | input or state | `--d2` | `--ease` | |
| stage and `/s` state swap | session event | `--d2` | linear opacity | boxes fixed |
| approved check | approval | holds `--d3`, fades over `--d1` | `--ease-enter` | |
| file row move on the stage | approved | `--d3` | `--ease` | the robin holds still meanwhile |
| QR refresh | every 60 s | `--d1` out, `--d1` in | linear opacity | dip to white, never overlapping codes |
| robin poster to canvas | first WebGL frame | `--d3` | linear opacity | |
| robin event pose (look, turn, carry) | session event | `--d3` | `--ease` | a `setPose` tween |
| robin hop | code scanned | `--d4`: up 14 px over 250, down over 250 | `--ease-enter`, `--ease-exit` | once per scan |
| robin scroll blend | explorer scroll | follows scroll | linear | one band, one blend |
| robin drag | drag | follows input | | yaw only; back to the rest yaw (-0.7 rad) over `--d4` |
| robin tilt | pointer over the stage (fine pointer) | follows, returns over `--d4` | `--ease` | max 6 degrees yaw, 4 pitch; off while any other motion runs |
| sheet | open, close | `--d3` in, 200 out | `--ease-enter` / `--ease-exit` | |
| section reveal | 15 percent visible | `--d4` | `--ease-enter` | opacity and `translateY(var(--rise))`; facts and story cards only, at most 3 items, 80 ms stagger; never the hero or task pages |
| nav CTA appear | hero actions leave view | `--d1` | `--ease` | space kept |
| toast | show, hide | `--d2` in, 125 out | `--ease-enter` / `--ease-exit` | |

### Scroll-driven animation
- DOM motion tied to scroll (the explorer's pin and card swap) uses CSS `animation-timeline: view()` or `scroll()` on `transform` and `opacity`, inside `@supports (animation-timeline: view())`. The final state is the default style, so without support the page shows it with no motion.
- The robin's blend reads the same progress (`ViewTimeline` in JS where supported) in a `requestAnimationFrame` loop that runs only while the explorer is in view; without it, an `IntersectionObserver` with 4 thresholds steps the pose with a `--d3` tween. Never a `scroll` event listener.
- One pinned scene per page (the explorer). Nothing changes speed after a scroll ends.

### Reduced motion (`prefers-reduced-motion:reduce`)
- Still poses everywhere (section 9 stills); no pin, no scroll-linked transforms, no autoplay, no WebGL download, no hop or tilt.
- Every remaining change is a `--d1` opacity fade; reveals are off; the `/s` capsule updates in 10 s steps.
- The house blanket rule in `tokens.css` stays as the safety net; the `--d1` fades opt back in with a more specific `!important` rule on those elements only.

### WCAG 2.2.2 and 2.5.7
- Nothing auto-advances on the landing; any future autoplay over 5 s needs a visible Pause.
- The QR refresh is essential (a code must expire), so it has no pause; it limits no visitor, who can scan any current code.
- The renderer's idle breathing bob is off on every page.
- Every drag has a single-pointer alternative: Turn Left and Turn Right, plus the chips for poses; no press-and-hold.

## 9. The robin and 3D

### Why custom here
The robin is the one place bloop builds instead of reusing (the decision record lives in `docs/adr/`). The hand-written renderer is 3.1 KB gzip and the packed mesh 15.2 KB gzip, about 18 to 20 KB in total, against OGL at 33.4 KB gzip as a full package plus a 57 KB gzip GLB, or three.js at 181 KB gzip. The job is small and fixed (one static mesh, one light, a few poses), and the poster is a safe fallback.

### Asset pipeline (repo paths)
| Step | Tool | Output | Budget |
|---|---|---|---|
| 1. Source | the CC0 low-poly robin GLB: 5,968 non-indexed float32 vertices, 1,990 triangles, a 341-byte palette PNG, 204,948 bytes | `src/robin.glb` (not served) | |
| 2. Pack | `tools/pack.py`: dedupes to 1,022 vertices quantized to int16, 1,990 triangles with uint16 indices, one palette index per face, the 8-color palette; normals from faces at draw time, so no decoder and no glTF loader | `assets/robin.bin` (format BLP1) | 20,122 bytes raw, 15,155 gzip; budget 16 KB gzip |
| 3. Poses | Blender: rotate the wing face groups about a shoulder pivot and the head about the neck (no rig); vertex count and order identical to the base; pack positions only | `assets/robin-{look,turn,carry,away}.bin` | about 6 KB raw each (estimate); 20 KB gzip for all four |
| 4. Prop | the slide card, a flat 16:9 card of at most 12 triangles, white with a #FFB783 title bar, carry pose only | part of `robin-carry.bin` | |
| 5. Stills | each pose from the same renderer in headless Chrome, same camera and light, transparent, at 2x (`tools/render-stills`) | PNG masters | |
| 6. Encode | AVIF (quality about 60) with a WebP fallback | `assets/img/robin-{pose}-{w}.avif/.webp` | see Stills |

### Palette (the robin's own colors)
light plumage #E4C399; mid plumage #B89572; back #895E34; wing #9E7457; dark details #704A2D; breast #FF7702; belly #F5E4C8; warm shade #BE7634. The breast is not recolored toward `#FFB783` (the pastel would wash the bird out against `--bg`); it stays under 10 percent of the robin box, the robin never sits beside the primary button at the same size, and `#FF7702` never appears in CSS.

### Stills
| Still | Pose | Where | Box (CSS) | Widths | Budget each |
|---|---|---|---|---|---|
| perch (poster, LCP) | three-quarter view (-0.7 rad) | hero stage, `/s` | `--robin-hero`; `/s` 160 | 640, 960, 1120 (`/s` 320) | AVIF 36 KB at 1120 (target), WebP 54 KB |
| look | head toward the code | explorer Scan | 560 (compact 280) | 560, 1120 | AVIF 30 KB |
| turn | body toward the viewer | explorer Check | 560 | 560, 1120 | AVIF 30 KB |
| carry | wings up, slide card in the beak | explorer Present | 560 | 560, 1120 | AVIF 30 KB |
| away | wings spread, gliding up and right | explorer End; `/a` ended (96) | 560 | 560, 1120 | AVIF 30 KB |

### Loading
- Poster: `<img width height fetchpriority="high" decoding="async">` in a fixed `aspect-ratio:1` box, preloaded, never lazy; it is the LCP element and the fallback for every failure.
- Desktop (fine pointer): once the stage is in view, on `requestIdleCallback` (timeout 2000 ms, `setTimeout` fallback) and never before LCP, import the renderer and fetch `robin.bin`; pose files load when the explorer is within 400 px of view. Skip under reduced motion or `saveData`.
- Touch: the poster carries a 44 px round `--bg2` button at its lower right (Lucide `rotate-3d`, label "Turn the Robin"); tapping it loads the renderer in place.
- Any failure (no WebGL, context lost, fetch or parse error) leaves the poster or still in place.

### Renderer (`assets/robin.js`)
| Item | Spec |
|---|---|
| API | ES module: `mountRobin(canvas, src, {yaw})` returns `{setPose(pose, {t, yaw}), hop(), stop()}`. `pose` is `perch`, `look`, `turn`, `carry` or `away`; `t` in 0 to 1 blends from the current pose by lerping positions in the vertex shader (two position attributes, same topology); without `t` it tweens over `--d3`. The page calls `setPose` from scroll, chips, Turn buttons and session events, and `hop()` on `bloop:scanned` |
| Size | 3.1 KB gzip measured before `setPose`; budget 4 KB gzip with it |
| Graphics | WebGL 1, one program, one draw call; flat shading from per-face normals; one key light plus ambient; transparent canvas |
| Camera, canvas | fixed framing matching the poster pixel for pixel; rest yaw -0.7 rad; the poster's box at `min(devicePixelRatio, 2)` |
| Frames | capped at 30 fps; none at rest; stops off-screen (`IntersectionObserver`) and on a hidden tab (`visibilitychange`) |
| Input | pointer events with `touch-action:pan-y`, so page scroll works over the robin |
| Durations | read from the motion tokens, not hard-coded |
| Accessibility | canvas and poster are decorative (`alt=""`, `aria-hidden="true"`); nothing depends on the robin |
| Swap | if the device matrix (open item 21) shows quirks: OGL with its glTF loader, then three.js tree-shaken |

### Placement
At most one prop (the slide card, carry pose only); phones, screens and files are real bloop UI, never 3D props. Landing hero: the stage's center object, poster then live, event poses on desktop. Explorer: live with scroll-linked `setPose`, stills under reduced motion. `/s`: perch poster 160 with a CSS hop on scan, never WebGL. `/a`: only the 96 px away still on Ended. Facts, story cards, closing, footer, `/it` and 404: none. Favicon: the robin's head in profile, flat SVG, 3 palette colors. OG image: perch still at right, h1 at left.

## 10. The QR

| Item | Spec |
|---|---|
| Library | an established generator, not a custom encoder: uqr 0.1.3 (MIT, an ESM port of Nayuki's generator; `encode(text, {ecc:'M', minVersion:4, maxVersion:4, border:4})` returns the matrix, drawn as one SVG path); 7.8 KB gzip unminified, in the JS budget; qrcode-generator is the alternative |
| Content | `https://{host}/a#{id}`: 12 characters of lowercase Crockford base32 (60 bits), single use, after the fragment so it never reaches the static host's logs `[V-12]` |
| Mode, version | byte mode, level M, pinned to version 4 (33 x 33 modules) so the size never jumps |
| Quiet zone | 4 modules each side, inside the white panel: 41 modules across |
| Rendering | integer device pixels per module, `shape-rendering:crispEdges`, no CSS scaling after layout, square modules, #1D1D1F on #FFFFFF, never inverted, no logo, no rounded or colored modules, never animated while shown |
| Landing size | 41 x `--qr-mod`: 205 or 246 px |
| Screen size | module = `floor(0.5 * viewport height * DPR / 41)` device px; 1080p: 13 px, 533 px wide; 1366 x 768: 9 px, 369 px |
| Refresh | every 60 s; next code fetched at 50 s; the old code fades to white over `--d1`, then the new one in; the old code stays valid 10 s; a scanned code locks to that phone, which then has 2 minutes to approve |
| Match code | 2 digits, 10 to 99, on the screen after a scan (120 px on `/s`, 96 px on the stage) and on the phone (48 px); compared, not typed |
| Typed fallback | 6 characters of uppercase Crockford base32 in two groups of 3 ("K7M Q9X"), rotating with the QR, entered at `{host}/code`; on `/s` only, never on the landing |
| Accessibility | `role="img"`, `aria-label="QR code. Scan it with your phone camera to open bloop. Or enter the code K 7 M, Q 9 X at {host} slash code."`; the label updates silently |

Size by distance (width = distance / 8, a floor to confirm on site, open item 6): at 1080p a 65 inch display (0.75 mm/px) needs 167, 333 and 500 px at 1, 2 and 3 m; a 2.5 m wide projection (1.3 mm/px) needs 96, 192 and 288 px; a 24 inch monitor serves about 1.5 m. The 533 px default covers a 65 inch display to about 3.2 m and a projection to about 5.5 m.

## 11. Page performance

Stack and system architecture: `docs/architecture.md` and `docs/adr/`.

### Loading order (every page)
1. HTML with the one CSS `<link>` in the head; no inline styles or scripts (the CSP forbids them).
2. Font preload (`<link rel="preload" as="font" type="font/woff2" crossorigin>`) for the one subset: `fonttools varLib.instancer` to `wght=400:600` (keep `opsz` if the file stays under 55 KB), then `pyftsubset` to the section 4 range; the metric-matched fallback means the swap shifts nothing.
3. Poster preload with `fetchpriority="high"` (landing and `/s`).
4. `<script type="module">` app glue, deferred by default.
5. After LCP, on idle: the renderer and `robin.bin`; near the explorer: pose files and stills (the first lazy, the others prefetched on idle within 400 px).
6. Below the fold: `<picture>` AVIF then WebP with `width`, `height`, `sizes`, `decoding="async"`, `loading="lazy"`.

Every late element (poster, canvas, code, stage UI, stills) has a reserved box. A budget miss fails the build check.

### Budgets (internal targets; Google's "good" lines in brackets)
| Metric | Landing | `/s` | `/a` |
|---|---|---|---|
| First-view requests | 6 or fewer (HTML, CSS, font, poster, app.js, favicon) | 6 or fewer | 5 or fewer |
| First-view transfer | 165 KB or less | 120 KB | 100 KB |
| HTML (gzip) | 14 KB | 6 KB | 6 KB |
| CSS (gzip, shared file) | 12 KB | same | same |
| Font | 1 file, 55 KB or less | same | same |
| JS before interaction (gzip) | 30 KB: glue plus the QR library; excludes the robin | 30 KB | 20 KB |
| Robin renderer (deferred, never before LCP) | 4 KB (3.1 measured) | not loaded | not loaded |
| Robin mesh `robin.bin` (deferred) | 16 KB (15.2 measured) | none | none |
| Robin poses (deferred, near the explorer) | 20 KB for four | none | none |
| Poster | AVIF 36 KB | AVIF 14 KB | none |
| Full scroll, everything | 400 KB | | |
| LCP | 1.2 s desktop, 1.8 s on slow 4G [2.5 s] | 1.5 s | 1.5 s on 4G |
| CLS | 0.02 [0.1] | 0 | 0.02 |
| INP | 100 ms [200 ms] | 100 ms | 100 ms |
| Robin first frame | under 50 ms of main thread after the mesh arrives (124 ms from load measured on localhost) | | |

## 12. Accessibility

### Contrast pairs
| Pair | Ratio | Use |
|---|---|---|
| `--t1` #1D1D1F on #FAFAFA / `--tint-2` | 16.8 / 15.0:1 | text, story headlines |
| `--t2` #6E6E73 on #FAFAFA / #FFFFFF / `--bg2` | 4.9 / 5.1 / 4.54:1 | secondary text, captions, chip text |
| `--t2` on `--tint` / `--tint-2` | 4.72 / 4.52:1 | story-card sentences |
| `--on-acc` on `--acc` | 7.7:1 | primary label |
| `--acc-ink` on #FFFFFF / `--bg2` | 6.4 / about 5.8:1 | focus ring, selection (3:1 needed) |
| `--t3` #8E8E93 on #FAFAFA | 3.3:1 | never text |
| QR #1D1D1F on #FFFFFF | 16.9:1 | modules |

### Rules
| Topic | Rule |
|---|---|
| Targets | 48 px buttons; 44 minimum for any hit area (Turn buttons, nav links, text buttons) |
| Focus | the house ring on every interactive element; never on hidden UI (the hidden nav CTA is `tabindex="-1"` and `aria-hidden`) |
| Keyboard | "Skip to Content" first; Tab follows reading order; explorer arrows, Home, End; Esc closes any sheet and returns focus; Enter on `/a` activates Approve only when it is focused |
| Live regions | the stage screen and the `/s` heading in `role="status" aria-live="polite"`; failures `role="alert"`; `/a` moves focus to the new title |
| QR | label in section 10; the match code is announced with the scanned state |
| Images | robin images and canvas are decorative; device mocks are `aria-hidden` with a visually hidden summary ("Your phone shows the room name, a code and an Approve button.") |
| Language and zoom | `<html lang="en-US">`; zoom never disabled; holds at 200 percent and reflows to 320 CSS px |
| Forms | the code field has a visible label, 16 px or more, errors beside it in text plus icon |

## 13. Quality bar and AI tells (checklist for every screen)

One list. A screen is done when every box passes; `audit`, `contrast` and the greps are run, not assumed.

### The bar
- [ ] **Hero viewport:** at most 40 words outside product UI, nav included; h1 at most 6 words in two beats, each ending with a period.
- [ ] **First viewport says what it does:** the sub names the phone, the screen and the file, and the verbs a person does, in at most 2 sentences and 30 words.
- [ ] **Any later viewport:** at most 40 words outside product UI; the whole landing 150 to 250 words.
- [ ] **One beat per section:** one heading (at most 8 words), one sentence (at most 20 words), one visual subject.
- [ ] **No analogy on the landing;** a future analogy sits under the plain claim, never alone, never implying a carried copy, offline use or plugging in.
- [ ] **Plain over clever:** a hurried lecturer can read every heading aloud and say what it means; no wordplay, no mystery, no unexplained noun.
- [ ] **Robin is the hero object:** the largest visual in the hero at 1440 (at least 40 percent of viewport height, at the side) and centered at 390; it reacts to scroll and drag; at most one thing moves at a time.
- [ ] **Real product UI:** the stage, fact devices and story cards render bloop's own `/s` and `/a` components, never painted fakes; window chrome only per the window chrome rule.
- [ ] **Story cards:** one tint family from the palette, product UI inside, never decoration.
- [ ] **Nav centered:** pill and link-group centers within 1 px of the viewport center at every width, measured by script.
- [ ] **Never-say grep:** no hit from `tools/never-say.txt` or the house banned words in any page or string.
- [ ] **Drag has an alternative;** every control is keyboard reachable with a visible focus.
- [ ] **Reduced motion:** still poses, no scroll-linked transforms, nothing autoplaying.
- [ ] **Mobile (390):** no horizontal scroll, h1 at most 3 lines, the primary action in the first viewport, targets at least 44 px.
- [ ] **Contrast:** WCAG AA on every text and control (`contrast`).
- [ ] **Budgets:** section 11 passes (LCP 1.2 s desktop, 1.8 s slow 4G; CLS 0.02; renderer never before LCP).
- [ ] **Same voice everywhere:** `/s`, `/a`, `/it` and every error state pass the beat, plain-language and never-say items too.
- [ ] The house `audit` and `contrast` scripts pass on every HTML and CSS file.

### AI tells (banned)
- [ ] No purple, indigo or violet; no gradients; no gradient text; no glow, blob or mesh backgrounds.
- [ ] No eyebrow or pill badge above the headline, in any form.
- [ ] No centered hero with Get Started and Learn More; bloop's centered hero says Try the Demo and How It Works, and the stage under it carries the live code.
- [ ] No three identical icon cards; steps are the explorer, facts are numerals with devices, and each story card holds different product UI.
- [ ] No bento grid; one grid on every page.
- [ ] No fade-up on everything; reveals only on facts and story cards, at most 3 items each.
- [ ] No glass in the content layer; glass on the nav only.
- [ ] No fake logos, testimonials, counts or "Trusted by"; facts are product rules marked `[V-n]`.
- [ ] No stock illustration or abstract 3D; the only 3D is the robin; devices show real bloop UI.
- [ ] No banned words: the house list in `references/ai-tells.md` (powerful, unlock, elevate, empower, transform and the rest) and `tools/never-say.txt`.
- [ ] No "not X, but Y", "no X, no Y, just Z", rhetorical questions in body copy, "whether you're", signposting ("Here's how it works").
- [ ] No em or en dashes, exclamation marks or emoji in any string.
- [ ] No claim that sign-in is gone, no runs-on-every-screen claim, no nothing-stays claim, no freshness promise; no claim without a `[V-n]` check.
- [ ] No two security claims that disagree; `/it` and the landing use the same sentences.
- [ ] No QR on phones; no two competing primary buttons in the first view; no autoplay without a pause.
- [ ] No placeholder links, template names or lorem in the footer.
- [ ] Cover the wordmark: the robin with the live code still says which product this is.

### Vibe-coded defaults (banned)
A pattern is banned when it is a default nobody chose. Each line names what bloop does instead.
- [ ] No status dot, pulsing dot or tinted status pill ("● Live"); state is a sentence plus the object changing; chips are text only.
- [ ] No green, amber or red status palette; no tinted icon squares or circles; icons are plain Lucide in `currentColor`, only where they name an action or a state.
- [ ] No accent stripe (a colored `border-left` or `border-top` on a card, callout or toast); depth comes from the one card.
- [ ] No mono kicker or tracked uppercase label ("// IN SHORT", "FEATURES", "01 / 02"); labels are sentence case Inter; mono only for literal codes and paths.
- [ ] No "in short" boxes: a summary is the first paragraph; an aside is a plain `--t2` paragraph.
- [ ] No decorative numbering or middle-dot meta strings; numbers only where order is real.
- [ ] No check lists in green circles, "Most popular" pills, number tickers or stat banners; numerals are static, in context, with a two-line caption.
- [ ] No shadcn or Tailwind slate defaults, cards inside cards, or one radius on every box.
- [ ] No noise, grid or dot backgrounds, radial spotlights, cursor glow, shimmer or beam borders, conic rings, tilted 3D cards or marquees.
- [ ] No traffic-light window dots or terminal art as decoration; window chrome only on a faithful real-app mock (section 6).
- [ ] No tinted panel without product UI in it; tints only per the story-card tint rule.
- [ ] No hover lift on anything that does not act; no typed-out headline; no scroll reveal that hides text.
- [ ] No tracking tighter than -0.02em under 28 px; tracking tightens only as size grows.
- [ ] No chip for a fact: a chip is a control or a live state, never a label.

Kept on purpose, each with its condition: concentric radii from one set; the pill button in three roles; glass on the floating nav only; the two-layer shadow plus one deep shadow under a device; the hairline as a ring; big static numerals with a caption; the tinted stage and story cards holding real UI; window chrome on a faithful app mock; real bloop UI around the robin as the hero visual.

### Coherence
The site reads as one designed product, not a collage of its references.
- [ ] One of each: type scale (headings 600, body 400), heading treatment per level, card (plus the two tinted grounds), button shape (the pill in three roles; no square, outlined or ghost variants), chip, radius logic, shadow recipe, motion language (one reveal, one pinned scene), icon style (Lucide, stroke 2), illustration language (the low-poly robin).
- [ ] One voice: section 3; the same sentence for the same claim on every page.
- [ ] One accent: `--acc` on action, `--acc-ink` on selection and focus, its two tints on grounds; the robin's breast stays inside the robin.
- [ ] Review each screen for two treatments doing one job; merge them.

## 14. Inspiration and credits

Nothing is copied (no copy, assets or code); every lesson is restated in bloop's own system.
| Site | Taken | Warned against |
|---|---|---|
| opsis | the two-beat centered h1 with periods, one plain sub, two actions, then a big rounded stage holding the real product | faint color washes; sections blank until revealed |
| Apple (iPhone Duo, Continuity) | the pose explorer (one open card, "+" chips, one big object, a direct drag control); the diagonal of staggered devices with big numerals and two-line captions; few sizes, two weights, one action color | megabytes of media; late banners shifting the page |
| ample | story cards (a soft tinted card holding real app UI); the orbit (one mark at the center, the parts around it) | framework weight for a static page |
| asterline | one object can carry a whole page, drawn in kilobytes | slow blurred reveals on text people must read |
| grab3d | 3D starts as a picture and loads on intent; the robin model is its CC0 asset (grab3d.com, no attribution required; credited in the footer as a courtesy) | free orbit and zoom as the main interaction |
| a mascot counterexample | a mascot works when it does something | stacked chrome, several illustration languages, a grid per section, many loops at once |

Font: Inter (SIL OFL 1.1), subset from the official `InterVariable.woff2`, license shipped with it.

## 15. Open items (settle during the build)

| # | Item | Fallback until settled |
|---|---|---|
| 1 | What the PC still holds after End (expired link, open PowerPoint window, Downloads copy, recent lists), per room | `/a` ended shows "Ended." only; `/it` point 4 becomes "The IT page lists what can stay on the PC." |
| 2 | Automatic end after 90 minutes; End from phone and screen | drop "after 90 minutes" and the "Ends by itself" lines |
| 3 | A file edited minutes earlier opens as edited | no copy promises freshness either way |
| 4 | The screen holds only a session ID and one short-lived file link; the account never reaches it | the sub ends at "It opens in PowerPoint."; fact 2 and the approve line dropped |
| 5 | bloop stores no slide content except guest uploads, deleted at the end; what bloop keeps and how long | the "deletes its copy" lines dropped; `/it` rows hidden |
| 6 | QR scan distance and module size on real displays at 1, 2 and 3 m; 60 s life; 10 s grace | keep the spec; fact 3 drops "works once" if single use slips |
| 7 | Room registration, room name format, unregistered warning | "This screen" as the room name |
| 8 | Opening in installed PowerPoint (Protected View, download blocks, license prompts); the PDF fallback | Download It Instead visible from the start |
| 9 | Phone account needs (connect once, admin consent, sign-in lifetime) | first-use body "bloop reads your slides from OneDrive." |
| 10 | Guest flow and its file size limit `{N}` | story card 2 and the guest states removed |
| 11 | Inter subset size with `opsz` kept; fallback metrics measured against it | pin `opsz=14`; keep the starting metrics |
| 12 | Camera apps keep the `#id` fragment (iOS, Android, common in-app scanners) | move the id into a path on the API origin |
| 13 | Final name, host and a public role address | keep `SITE_NAME` and `{host}` placeholders out of production |
| 14 | API origin; WebSocket allowed on campus networks | long-polling every 2 s |
| 15 | Clickjacking of `/a` without `frame-ancestors` | the JS frame guard (the framed state) |
| 16 | The host gzips `.bin` | accept the raw sizes inside the robin total |
| 17 | Demo flow: the phone's demo path, the sample deck, rate limits | the demo states as written |
| 18 | Match code as compare-only passes a security review | as written |
| 19 | The hero passes a 5-second test with 5 people ("you scan the screen with your phone and your slides open, and the screen never gets your account") | rewrite the sub, not the layout |
| 20 | Free early access wording stays within the rules for offering it | remove the closing line, keep the button |
| 21 | Robin device matrix: iOS Safari, Android Chrome, Windows Edge on a room PC, Firefox (first frame, drag with page scroll, pause on hidden tab, context loss, `setPose` blend) | OGL, then three.js; the poster meanwhile |
| 22 | uqr minified gzip size; its version 4, level M codes read by two phone cameras | qrcode-generator |
| 23 | Pose meshes: Blender wing edits keep the base topology so `setPose` can blend | the explorer with the perch still plus whole-object yaw turns |
| 25 | "Any screen" needs its condition visible; the footer line carries it | add "A screen with a web browser and PowerPoint." under the stage |
