// The Sample Deck's bytes: the demo's bundled deck. Kept apart from sample.ts so tests that import the insert logic do
// not need the bundler, which turns this import into a data module.
import deck from "../seams/file-source/demo-files/demo-deck.pptx";

export const sampleDeck = (): Uint8Array<ArrayBuffer> => new Uint8Array(deck);
