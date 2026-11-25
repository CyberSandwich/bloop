# Landing in both modes

`build-pages` emits both variants; the Worker serves one per request by `launch_mode` (plan Part 1, Two modes). S owns the pages; these are the layouts and strings.

## 1. Preview mode: today's page, exactly

Preview serves the landing as it is on main today, byte for byte: the nav (Features, Articles, Privacy, Terms, Security, then the Waitlist pill), the hero with Try the Demo as its one button, the stage, How It Works, the why, Features, Connect, the FAQ, the close and the footer (design.md sections 3, 5 and 6). No Sign In, no Present Live, no hint.

- The guard: a page test holds the preview variant equal to today's built landing (a golden copy taken when the variant build lands), so a change meant for open mode can never leak into preview (MODE-01). A deliberate preview change updates the golden copy in the same commit.
- Signed-in admins and testers in preview still see the preview landing (the mode is per site, not per user); they reach `/library` by typing it or from the email link. Why: preview must look exactly like what a visitor sees, so the owner checks the real thing.
- **The open variant stays unreachable in preview:**
  - `/open/*` (the build's subtree in `dist/`) is never a public path, in either mode: a request for it answers the 404 page. The Worker reads the variant from its assets internally; no URL names it.
  - In preview the Worker does no hint-cookie rewrite (the preview nav has no Sign In pill to rewrite), and `sitemap.xml`, `robots.txt` and `llms.txt` list no open-only page.
  - An e2e per mode guards all three: in preview, `/open/` and `/open/index.html` are 404, the landing equals the golden copy, and no open page is in the sitemap; in open, `/open/` is still 404 and the landing is the open variant.
- **View the Open Site** (admin only): a link on `/admin`'s Launch tab (account-admin.md section 2.5) serves the open variant of the landing to that admin while the site is in preview, so the owner can check it before switching. The Worker checks the admin cookie on every such request (not the hint cookie, and not a cached answer), and the response is `private, no-store`, so a shared cache never hands it to a visitor. Anyone else asking for it gets the preview page.

## 2. Open mode

### 2.1 Nav

```
1440 (two glass pills centered as a pair, as today)

        .-----------.     .------------------------------------------------.
        | (b) bloop |     |  Articles   Privacy   Terms     [ Sign In ]    |
        '-----------'     '------------------------------------------------'

390 (pills part; the links pill holds Sign In and the menu button)

  .-----------.                         .------------------------.
  | (b) bloop |                         |  [ Sign In ]   (menu)  |
  '-----------'                         '------------------------'
```

- Links: Articles, Privacy, Terms (listed in `content/site.json` per variant). Features leaves the nav (it is an article now, linked from Articles); Security moves to the footer and the Articles page; Waitlist leaves the nav (the hint and the end block carry it).
- **The pill** takes the Waitlist pill's place and look (design.md section 6, Buttons, waitlist: `--ink-2`, 44 tall, padding 0 16, 15 px): "Sign In" to `/signin`, or "Library" to `/library` when the `__Host-bloop_in` hint cookie is set.
- **Who sets the label:** the Worker, when it serves the page (one element rewritten from the hint cookie; the response gets `Vary: Cookie` and keeps `no-cache` with its ETag per variant). Why not `site.js`: a module runs after first paint, so a signed-in visitor would see Sign In flash to Library. Fallback without the rewrite (an HTML cache that ignored Vary): the link still works, because `/signin` redirects a signed-in visitor to `/library` at once.
- The pill keeps a fixed min-width (the wider of its two labels), so the pair's centering never shifts between visitors (the e2e that holds the two gaps within 1 px runs in both states).
- Under 760: the menu sheet lists Articles, Privacy, Terms; the pill stays beside the menu button, outside the sheet, since it is the one action.
- Focus order: logo, Articles, Privacy, Terms, Sign In (or Library); under 760: logo, Sign In, Menu.

### 2.2 Hero

```
1440 x 900 (the hero block centered in the first view, as today)

                              Present Anywhere
              Scan the QR code, approve on your phone, and present.

                  [[ Try the Demo -> ]]   [ Present Live ]

                      Invite only for now. Join the waitlist (arrow-down)

        +----------------------------------------------------------------------+
        |                         the stage (at the fold)                      |

390 x 844

          Present
          Anywhere
   Scan the QR code, approve on your
   phone, and present.

   [[ Try the Demo -> ]] [ Present Live ]

   Invite only for now. Join the waitlist (arrow-down)

320 (the two pills no longer fit side by side: stacked, primary on top, full width)

   [[     Try the Demo ->     ]]
   [        Present Live       ]
   Invite only for now. Join the waitlist (arrow-down)
```

- h1 and sub unchanged (design.md section 3). Actions: Try the Demo (primary, `/demo`, its trailing `arrow-right`) then Present Live (secondary, white pill with the hairline ring, to `/s`), 52 tall, gap 12, side by side while both fit on one line (390 fits: about 166 and 136 wide; 320 does not), stacked below that with Try the Demo on top (`flex-wrap` on a container query, not a breakpoint, so a larger system font stacks them too).
- **Present Live** is for the room PC: it opens the waiting screen with its QR. On a phone it still shows (README.md decision 8); `/s` answers a narrow window with "Use the Room's Screen". That state gains a second exit, Try the Demo (secondary, `/demo`) beside its Enter the Code, so a phone that tapped Present Live by mistake still reaches the product (README.md decision 13).
- **The hint:** "Invite only for now. Join the waitlist ↓" (the owner's wording, README.md decision 13; 15 `--muted`, 16 under the actions; the arrow is U+2193, in the Inter subset), a link to `#waitlist` (the end block). The whole line is the link (44 tall hit area); its underline only on hover and focus, as the site's text buttons. With smooth scroll allowed it scrolls; under reduced motion it jumps.
- Word caps (design.md section 13): the hero stays under 40 words (h1 2, sub 10, buttons 5, hint 7).
- The stage stays the Demo Room screenshot until S2 recaptures it showing the library flow.

### 2.3 Sections between hero and close (open mode)

Order: hero, stage, How It Works, the why, Connect Your Files, the FAQ, the waitlist block, footer.

- **How It Works:** unchanged steps and stills (they show the demo, which still works as drawn). Step 2's line stays "Choose your files, then tap Approve.", true for the demo and close enough for live, where the number tap approves; S2 revisits the stills with the recapture.
- **Features grid:** leaves the landing for the Features article (plan Part 1, decision 3). The why paragraph now leads straight into Connect.
- **Connect Your Files:** What You Can Share (Available) lists the common kinds the converter takes: Slides, Documents, PDFs, Spreadsheets, Photos, Videos, Links, each with its Lucide glyph (`presentation`, `file-text`, `file-text`, `file-spreadsheet`, `image`, `film`, `link`). PDFs and Documents share a glyph by design (both are pages). Integrations (Coming Soon) unchanged.
- **FAQ:** the same four questions. "Which files work?" becomes "Slides, documents, PDFs, spreadsheets, photos, videos and links." "Is it free?" stays "Yes, while **bloop** is in early access." `[V-20]`.

### 2.4 The waitlist block (end of page, `#waitlist`)

The close panel (design.md section 6, Close: the warm backdrop at `--r-stage`, one glass card) keeps its frame and gains a heading and a line, because in open mode the end of the page has a second job: the hint's target.

```
1440 (the stage's width; the card centered)

  +--------------------------------------------------------------------------------------+
  |  warm backdrop                                                                       |
  |                    .------------------------------------------------.                |
  |                    |                 (b) logo, 64                   |                |
  |                    |             Join the Waitlist                  |                |
  |                    |  bloop is invite only during early access.     |                |
  |                    |  Join the waitlist to get an invite.           |                |
  |                    |                                                |                |
  |                    |  [[ Join the Waitlist ]]   [ Try the Demo -> ] |                |
  |                    '------------------------------------------------'                |
  +--------------------------------------------------------------------------------------+

390

  +------------------------------------+
  | .--------------------------------. |
  | |          (b) logo, 64          | |
  | |       Join the Waitlist        | |
  | | bloop is invite only during    | |
  | | early access. Join the         | |
  | | waitlist to get an invite.     | |
  | | [[    Join the Waitlist     ]] | |
  | | [      Try the Demo ->      ]  | |
  | '--------------------------------' |
  +------------------------------------+
```

- The section is `id="waitlist"`, labeled by its h2 "Join the Waitlist" (the section h2 size, design.md section 4), so a jump lands on a heading. Line (the page lead's style, `--lead`, centered): "**bloop** is invite only during early access. Join the waitlist to get an invite."
- Actions: Join the Waitlist (primary, `https://tally.so/r/Yj4KAN?source=landing-end`, `data-waitlist`, same tab, as every waitlist link) and Try the Demo (secondary here: the hero already made it primary, and this block's job is the waitlist). Side by side from 480, stacked under it, primary on top.
- Focus: arriving by the hint moves focus to the h2 (`tabindex="-1"`, no ring on a heading), so a keyboard user continues from the block, not from the hero.
- Motion: the backdrop drifts as today; nothing new.

### 2.5 Footer

As today, with the open variant's links from `content/site.json`: Articles, Privacy, Terms, Security, Accessibility, Waitlist, and the address. Security is reachable here and from Privacy (plan Part 1, decision 3).

## 3. States

| State | What shows |
|---|---|
| no script | everything works: the hero links, the hint's anchor, the menu popover; the pill label is the Worker's |
| hint cookie stale (set, but the session expired) | the pill says Library; `/library` sends the visitor to `/signin?next=/library`, which clears the hint on its way. One extra hop, once |
| mode switched while the page is open | nothing changes until the next load; no polling |
| slow network | the page is static HTML, CSS and one font; the stage picture is the only heavy request and holds its box, as today |
| `/demo` busy | `/s?mode=demo` shows its own "Too Many Demos Right Now" state (design.md section 7) |

## 4. Strings (open variant)

| Slot | String |
|---|---|
| nav | Articles; Privacy; Terms; Sign In; Library |
| hero actions | Try the Demo; Present Live |
| hint | Invite only for now. Join the waitlist ↓ |
| share rows | Slides; Documents; PDFs; Spreadsheets; Photos; Videos; Links |
| FAQ answer | Slides, documents, PDFs, spreadsheets, photos, videos and links. |
| waitlist block | Join the Waitlist (h2); bloop is invite only during early access. Join the waitlist to get an invite.; Join the Waitlist; Try the Demo |
