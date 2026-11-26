// The demo account's catalog: the one owner of its item names and its video. The page count and the id slug are in
// public/js/core/demo.js, which the pages ship; this file is for the Worker and the tests, so the names add nothing to
// a page's first load. test/unit/demo-catalog-rules.test.ts fails a literal copy of a name or id anywhere else.
import { DECK_PAGES, demoId } from "../../public/js/core/demo.js";

/**
 * In list order, the order a phone is given slots i1.. in: files A to Z, then links by title. The server sorts the
 * approved list the same way (`orderItems`), so a link goes in its title's place here or its slot would shift.
 */
export const DEMO_NAMES = [
  "Deck.pptx",
  "Horizontal.jpg",
  "Vertical.jpg",
  "How to Get and Evaluate Startup Ideas | Startup School",
  "Vevox",
];

/** The YouTube video of the second link card; its thumbnail is served from this origin (PREVIEW-01). */
export const DEMO_VIDEO_ID = "Th8JoIan4dg";

/** `id` is the name's own slug unless given: the video's title is a sentence, so its entry id is set here. */
const item = (index: number, id?: string) => {
  const name = DEMO_NAMES[index] as string;
  return { id: id ?? demoId(name), name, slot: `i${index + 1}` };
};

/** In list order, which is the order of the keys. */
export const DEMO_ITEMS = {
  deck: item(0),
  horizontal: item(1),
  vertical: item(2),
  video: item(3, "demo-video"),
  link: item(4),
};
/** The ids in list order. */
export const DEMO_IDS = Object.values(DEMO_ITEMS).map((i) => i.id);
export { DECK_PAGES };
