// The demo account's files: the sample decks from test/fixtures/decks, bundled as data (tools/make-fixtures.mjs
// writes them). Kept apart from mock.ts so unit tests can build a MockFileSource without the bundler.

import quarterly from "../../../../test/fixtures/decks/quarterly-review.pptx";
import deck from "../../../../test/fixtures/decks/sample-deck.pptx";
import handout from "../../../../test/fixtures/decks/sample-handout.pdf";
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
