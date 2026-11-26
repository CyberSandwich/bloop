// The demo account's items for the Worker's demo.ts and the tests, derived from the catalog in public/js/core/demo.js
// (the owner of the names and the page count); a swapped demo file changes that, demo-files/ and the slide images only.
import { DECK_PAGES, DEMO_NAMES, demoId } from "../../public/js/core/demo.js";

const item = (index: number) => {
  const name = DEMO_NAMES[index] as string;
  return { id: demoId(name), name, slot: `i${index + 1}` };
};

export const DEMO_ITEMS = { deck: item(0), horizontal: item(1), vertical: item(2), link: item(3) };
/** The ids in list order. */
export const DEMO_IDS = DEMO_NAMES.map((_, i) => item(i).id);
export { DECK_PAGES, DEMO_NAMES };
