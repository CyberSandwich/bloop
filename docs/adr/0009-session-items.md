# ADR 0009: a session holds a list of items

Status: accepted as built.

## Context
A session used to carry one file. A presenter wants a deck, its PDF, a photo and a poll link in one approval, shown in one viewer. The screen must still learn nothing beyond what the phone approved (SRC-01), mint nothing but links for approved files (PAIR-11), and a stored session from the old shape must survive a deploy.

## Decision
- **One `Item` union** in `src/shared/protocol.ts`: `FileItem {kind: "file", name, type, size}` or `LinkItem {kind: "link", url, title}`. Views carry `items: Item[]`; the phone's list is `Entry[]` (an item plus its opaque id). Why: one shape for every page and every approval path. Replaces: `fileName`, `fileType`, `fileSize` on the views and `FileEntry` alone. Remove: back to one `FileItem`.
- **Server-side order and index:** the machine stores items as `orderItems` sorts them (files by name, then links by title), and a link mint or an `open` frame names an item by its index in that list. The first file is the launched one; a session of links only mints nothing.
- **Cap:** `MAX_ITEMS` (12) in `src/worker/items.ts`, checked by the approve route's schema and again by the machine.
- **Types:** `FileType` gains `jpg`, `png` and `webp`; `OpenMode` gains `view` (an image inline). `effectivePurpose` maps a requested purpose to what the type can serve, so an image is never launched and a PDF is always its own view. Images stream with a fixed `image/*` type under `nosniff` and the `file-image` header policy (IMG-01).
- **Links:** https only, host on `LINK_HOSTS` (`items.ts`, a constant, not a config variable: adding a host is a reviewed code change), checked by URL parse at listing and at approve (LINK-01). Only the demo account has links (`DEMO_LINKS`); Graph offers none. Remove: drop `LinkItem`, `LINK_HOSTS` and `DEMO_LINKS`.
- **Schema step:** the Screen object's storage gets a `schemaVersion` key (`do/schema.ts`). Version 1 had none; step 2 turns `session.file` into a one-item `session.items` and gives every link record `item: 0`. A new object is written at the current version. Each later change is one more numbered step.
- **Demo catalog:** Sample deck.pptx, Sample deck.pdf (no longer a rendition only, so `MockFixture.renditionOnly` is gone), Dog.jpg and the Vevox link. The deck and the PDF share the pre-rendered page images (`tools/render-slides.py`).
- **Item ids (protocol change, Phase D):** `FileItem` and `LinkItem` carry a server-assigned `id` ("i1", "i2", ... by place in the ordered list), written once at approval (a guest's file at `upload.done`) and never recomputed, so a command names an item by id and never by an index a re-sort could move (the phone's remote, `POST /api/control`, and the screen's report, `POST /api/screen/shown`; PAIR-13). Views also carry `shown`. Why: an index command lands on the wrong item when the list reorders. Replaces: a client identity helper (kind, name, same-name ordinal). Schema step 5 adds ids and `shown` to a stored session. Remove: drop `id` and `shown`, and the two routes.
- **Guest drop is unchanged:** one file, pptx or pdf; its session is a one-item list.

## Consequences
- The open path, the ledger and the audit row are per item: a link record carries its item index; the audit `fileName` lists every item's name or title in one field.
- An old screen page that posts `{purpose}` without `item` still works: the default is the launched file.
- **The mint budget is per item:** each item's first link is free (the approval's launch link, or the first one the screen asks for), then `LINK_MINTS_PER_ITEM` (5, at least 1) more, counted per index in `session.minted` (schema steps 3 and 4). One file is exposed exactly as before (6 links), and a full list allows at most 72. Why: a session-wide cap ran out while a viewer moved between items. Replaces: `LINK_MINTS_PER_SESSION`. Remove: one counter again.
