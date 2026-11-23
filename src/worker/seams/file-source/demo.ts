// The demo account's files, bundled as data: a real deck and its PDF export in demo-files/ (slimmed losslessly,
// author fields blank; size budgets in package.json), plus one synthetic deck from test/fixtures/decks.
// Kept apart from mock.ts so unit tests can build a MockFileSource without the bundler.

import quarterly from "../../../../test/fixtures/decks/quarterly-review.pptx";
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
      id: "demo-review",
      name: "Quarterly review.pptx",
      type: "pptx",
      bytes: new Uint8Array(quarterly),
      editedMinutesAgo: 120,
      pdfId: "demo-pdf",
    },
    {
      id: "demo-pdf",
      name: "Sample handout.pdf",
      type: "pdf",
      bytes: new Uint8Array(handout),
      editedMinutesAgo: 600,
      pdfId: null,
    },
  ]);
