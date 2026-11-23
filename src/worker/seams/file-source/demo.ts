// The demo account's catalog, bundled as data: a real deck, its PDF export and a photo in demo-files/ (slimmed,
// author fields and photo metadata stripped; size budgets in package.json), plus one web link. The demo screen shows
// the deck and the PDF as pre-rendered images of their pages (public/img/demo-slide-*, tools/render-slides.py); the
// PDF is also the deck's rendition. Kept apart from mock.ts so unit tests can build a MockFileSource without the bundler.

import type { LinkEntry } from "../../../shared/protocol.ts";
import deck from "./demo-files/demo-deck.pptx";
import dog from "./demo-files/demo-dog.jpg";
import handout from "./demo-files/demo-handout.pdf";
import { MockFileSource } from "./mock.ts";

export const demoSource = (): MockFileSource =>
  new MockFileSource([
    {
      id: "demo-deck",
      name: "Sample deck.pptx",
      type: "pptx",
      bytes: new Uint8Array(deck),
      editedMinutesAgo: 10,
      pdfId: "demo-pdf",
    },
    {
      id: "demo-pdf",
      name: "Sample deck.pdf",
      type: "pdf",
      bytes: new Uint8Array(handout),
      editedMinutesAgo: 10,
      pdfId: null,
    },
    {
      id: "demo-dog",
      name: "Dog.jpg",
      type: "jpg",
      bytes: new Uint8Array(dog),
      editedMinutesAgo: 30,
      pdfId: null,
    },
  ]);

/** The demo account's links. One that fails `linkAllowed` is never listed (test/integration/demo.test.ts). */
export const DEMO_LINKS: readonly LinkEntry[] = [
  { kind: "link", id: "demo-vevox", url: "https://www.vevox.com/", title: "Vevox" },
];
