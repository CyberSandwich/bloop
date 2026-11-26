// The demo account's catalog: the one owner of its names, ids and the deck's page count, for the Worker's
// demo.ts, the viewer's demo.js and every test (test/unit/demo-catalog-rules.test.ts fails a literal copy).
// A swapped demo file changes this file, the bytes in demo-files/ and the slide images, and nothing else.

export const DEMO_ITEMS = {
  deck: { id: "demo-deck", name: "Deck.pptx", slot: "i1" },
  horizontal: { id: "demo-horizontal", name: "Horizontal.jpg", slot: "i2" },
  vertical: { id: "demo-vertical", name: "Vertical.jpg", slot: "i3" },
  link: { id: "demo-vevox", name: "Vevox", slot: "i4" },
};

/** The ids in list order (files A to Z, then links), as a phone approves them. */
export const DEMO_IDS = [DEMO_ITEMS.deck.id, DEMO_ITEMS.horizontal.id, DEMO_ITEMS.vertical.id, DEMO_ITEMS.link.id];
/** The names in list order. */
export const DEMO_NAMES = [DEMO_ITEMS.deck, DEMO_ITEMS.horizontal, DEMO_ITEMS.vertical, DEMO_ITEMS.link].map(
  (i) => i.name,
);
/** The deck's pre-rendered page count: public/img/demo-slide-1..N (tools/render-slides.py). */
export const DECK_PAGES = 5;
