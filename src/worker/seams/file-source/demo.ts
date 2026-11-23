// The demo account's files, bundled as data: a real deck and its PDF export in demo-files/ (both slimmed, author
// fields blank; size budgets in package.json). Only the deck is listed: the demo screen shows pre-rendered images of
// its slides (public/img/demo-slide-*, tools/render-slides.py), and the PDF serves only as its rendition.
// Kept apart from mock.ts so unit tests can build a MockFileSource without the bundler.

import deck from "./demo-files/demo-deck.pptx";
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
      renditionOnly: true,
    },
  ]);
