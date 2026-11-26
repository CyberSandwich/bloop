// The demo account's catalog, bundled as data: a deck and two photos in demo-files/ (the deck slimmed by
// tools/slim-deck.py, author fields stripped; size budgets in tools/size/core.json), plus two web links. The demo screen
// shows the deck as pre-rendered images of its pages (public/img/demo-slide-*, tools/render-slides.py). Kept apart from mock.ts so unit tests can build a MockFileSource without the bundler.

import { DEMO_ITEMS, DEMO_VIDEO_ID } from "../../../shared/demo-catalog.ts";
import type { LinkEntry } from "../../../shared/protocol.ts";
import { previewId, previewPath } from "../../yt-thumb.ts";
import deck from "./demo-files/demo-deck.pptx";
import horizontal from "./demo-files/demo-horizontal.jpg";
import notes from "./demo-files/demo-notes.json";
import vertical from "./demo-files/demo-vertical.jpg";
import { MockFileSource } from "./mock.ts";

export const demoSource = (): MockFileSource =>
  new MockFileSource([
    {
      id: DEMO_ITEMS.deck.id,
      name: DEMO_ITEMS.deck.name,
      type: "pptx",
      bytes: new Uint8Array(deck),
      editedMinutesAgo: 10,
      pdfId: null,
      notes,
    },
    {
      id: DEMO_ITEMS.horizontal.id,
      name: DEMO_ITEMS.horizontal.name,
      type: "jpg",
      bytes: new Uint8Array(horizontal),
      editedMinutesAgo: 30,
      pdfId: null,
    },
    {
      id: DEMO_ITEMS.vertical.id,
      name: DEMO_ITEMS.vertical.name,
      type: "jpg",
      bytes: new Uint8Array(vertical),
      editedMinutesAgo: 30,
      pdfId: null,
    },
  ]);

/**
 * The demo account's links, in catalog order (titles A to Z, as `orderItems` sorts the approved list). One that
 * `allowedLink` refuses is never listed (test/integration/demo.test.ts). The video's `preview` is its thumbnail on this
 * origin; its id is also the only one the thumbnail route serves (`DEMO_THUMB_IDS`).
 */
export const DEMO_LINKS: readonly LinkEntry[] = [
  {
    kind: "link",
    id: DEMO_ITEMS.video.id,
    url: `https://www.youtube.com/watch?v=${DEMO_VIDEO_ID}`,
    title: DEMO_ITEMS.video.name,
    preview: previewPath(DEMO_VIDEO_ID),
  },
  { kind: "link", id: DEMO_ITEMS.link.id, url: "https://www.vevox.com/", title: DEMO_ITEMS.link.name },
];

/** The video ids the thumbnail route may fetch: those of the catalog's own previews, nothing a request names. */
export const DEMO_THUMB_IDS: ReadonlySet<string> = new Set(
  DEMO_LINKS.map((l) => previewId(l.preview ?? "")).filter((id): id is string => id !== null),
);
