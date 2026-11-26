// The presenter's notes on the phone (core/notes.js) and the hook in the remote (core/remote-ui.js) that loads it:
// the notes for a page, a deck with none, text kept as text, the scroll back to the top, and the fold of the list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";
import type { Item, PhoneView, Shown } from "../../src/shared/protocol.ts";
import { doc, FakeNode } from "./client-notes-dom.ts";

// core/ui.js listens for keys as it loads, and there is no window here.
vi.hoisted(() => {
  (globalThis as { addEventListener?: () => void }).addEventListener = () => {};
});
// The stylesheet's load never finishes without a browser.
vi.mock("../../public/js/core/lazy.js", () => ({ styled: async () => {}, refused: () => () => {} }));

// By path in a variable: these modules touch the DOM, which this config's types do not have.
const NOTES_JS = "../../public/js/core/notes.js";
const REMOTE_UI = "../../public/js/core/remote-ui.js";
interface Page {
  view: PhoneView | null;
  pid: string | null;
}
const { createBox, hasNotes, loadNotes, mount, noteFor } = (await import(NOTES_JS)) as {
  createBox: () => { box: FakeNode; show: (note: string, slide: string) => void };
  hasNotes: (notes: string[]) => boolean;
  loadNotes: (
    api: { get: (path: string, auth?: string | null) => Promise<unknown> },
    pid: string | null,
    item: string,
  ) => Promise<string[] | null>;
  mount: (c: Page, at: () => Shown | false | null, preview: FakeNode, place: () => void) => () => void;
  noteFor: (notes: string[], page: number) => string;
};
const { mount: mountRemote } = (await import(REMOTE_UI)) as {
  mount: (c: Page, onView: (view: PhoneView) => void) => (on: boolean) => void;
};

const deck: Item = { kind: "file", id: "i1", name: DEMO_ITEMS.deck.name, type: "pptx", size: 1 };
const photo: Item = { kind: "file", id: "i2", name: DEMO_ITEMS.horizontal.name, type: "jpg", size: 1 };
const view = (over: Partial<PhoneView> = {}) =>
  ({
    state: "open",
    mode: "demo",
    kind: "owner",
    items: [deck, photo],
    shown: null,
    seq: 0,
    v: 0,
    now: 1,
    ...over,
  }) as PhoneView;

const NOTES = ["First note.\nSecond line.", "", "Third <b>note</b>", "Fourth", "Fifth"];
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "X-Bloop": "1" } });
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((done) => setTimeout(done, 0));
};

let narrow = true;
let calls: { url: string; auth: string | undefined }[] = [];
/** The notes the server answers per item id; a function can throw like a dead network. */
let answers: Record<string, () => Response | Promise<Response>> = {};

beforeEach(() => {
  narrow = true;
  calls = [];
  answers = { i1: () => reply({ notes: NOTES }) };
  vi.stubGlobal("Element", FakeNode);
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return narrow;
    },
  }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
    const id = new URL(url, "https://x.test").searchParams.get("item") ?? "";
    return answers[id]?.() ?? reply({ notes: [] });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.root = doc.active = null;
});

/** The phone's column as the notes touch it: the list with a row per item, the preview, the floating panel. */
function scene() {
  const column = new FakeNode("main");
  doc.root = column;
  const list = new FakeNode("ul");
  list.setAttribute("id", "file-list");
  const rows = [deck, photo].map((item) => {
    const li = new FakeNode("li");
    const row = new FakeNode("button");
    row.setAttribute("class", "row");
    row.setAttribute("data-id", item.id);
    li.append(row);
    list.append(li);
    return row;
  });
  const preview = new FakeNode("div");
  preview.setAttribute("class", "preview");
  const panel = new FakeNode("div");
  panel.setAttribute("class", "actions");
  column.append(list, preview, panel);
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "file-list" ? list : null),
    querySelector: (selector: string) => (selector === ".column > .actions" ? panel : null),
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_: string, tag: string) => new FakeNode(tag),
    get activeElement() {
      return doc.active;
    },
  });
  return { column, list, rows, preview, panel };
}

const phone = (v = view()): Page => ({ view: v, pid: "pid-1" });
const boxOf = (column: FakeNode) => column.querySelector(".notes") as FakeNode;
const textOf = (box: FakeNode) => (box.querySelector(".notes-text") as FakeNode).textContent;
const pillOf = (box: FakeNode) => box.querySelector(".notes-none") as FakeNode;

describe("noteFor and hasNotes", () => {
  it("a page's note is its entry, counted from page 1", () => {
    expect(noteFor(NOTES, 1)).toBe("First note.\nSecond line.");
    expect(noteFor(NOTES, 5)).toBe("Fifth");
  });
  it("a page with no entry, an empty one or only blanks has no note", () => {
    expect(noteFor(NOTES, 2)).toBe("");
    expect(noteFor(NOTES, 6)).toBe("");
    expect(noteFor(NOTES, 0)).toBe("");
    expect(noteFor(["  \n\t"], 1)).toBe("");
    expect(noteFor([], 1)).toBe("");
  });
  it("a note keeps its newlines and its spaces", () => {
    expect(noteFor(["  one\n\n two  "], 1)).toBe("  one\n\n two  ");
  });
  it("a deck has notes when any page has one; all empty, blanks or none at all is a deck with none", () => {
    expect(hasNotes(NOTES)).toBe(true);
    expect(hasNotes(["", "", "x"])).toBe(true);
    expect(hasNotes(["", " ", "\n"])).toBe(false);
    expect(hasNotes([])).toBe(false);
  });
});

describe("loadNotes", () => {
  const asApi = (get: (path: string, auth?: string | null) => Promise<unknown>) => ({ get });

  it("asks for the item's notes with the pid alone, the id escaped", async () => {
    const seen: unknown[] = [];
    const got = await loadNotes(
      asApi(async (path, auth) => {
        seen.push(path, auth);
        return { ok: true, value: { notes: ["a"] } };
      }),
      "pid-9",
      "i 1&x",
    );
    expect(got).toEqual(["a"]);
    expect(seen).toEqual(["/api/notes?item=i%201%26x", "pid-9"]);
  });
  it("a failed call, a refusal or an answer that is not a list is no notes", async () => {
    expect(
      await loadNotes(
        asApi(async () => ({ ok: false, error: "offline" })),
        "p",
        "i1",
      ),
    ).toBeNull();
    expect(
      await loadNotes(
        asApi(async () => ({ ok: true, value: {} })),
        "p",
        "i1",
      ),
    ).toBeNull();
    expect(
      await loadNotes(
        asApi(async () => ({ ok: true, value: { notes: "x" } })),
        "p",
        "i1",
      ),
    ).toBeNull();
    expect(
      await loadNotes(
        asApi(async () => ({ ok: true, value: null })),
        "p",
        "i1",
      ),
    ).toBeNull();
  });
  it("an entry that is not text is an empty note", async () => {
    const got = await loadNotes(
      asApi(async () => ({ ok: true, value: { notes: ["a", 3, null, "b"] } })),
      "p",
      "i1",
    );
    expect(got).toEqual(["a", "", "", "b"]);
  });
  it("an item with no notes answers a list with none, which is no notes either", async () => {
    expect(
      await loadNotes(
        asApi(async () => ({ ok: true, value: { notes: [] } })),
        "p",
        "i3",
      ),
    ).toEqual([]);
  });
});

describe("the notes box", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: (tag: string) => new FakeNode(tag) });
  });

  it("holds the note as text, newlines kept, and hides the pill", () => {
    const { box, show } = createBox();
    show("one\ntwo", "i1:1");
    const text = box.querySelector(".notes-text") as FakeNode;
    expect(text.textContent).toBe("one\ntwo");
    expect(text.hidden).toBe(false);
    expect((box.querySelector(".notes-none") as FakeNode).hidden).toBe(true);
    expect(box.classList.contains("notes-blank")).toBe(false);
  });
  it("is a labeled region a keyboard can scroll", () => {
    const { box } = createBox();
    expect(box.getAttribute("role")).toBe("region");
    expect(box.getAttribute("aria-label")).toBe("Notes");
    expect(box.getAttribute("tabindex")).toBe("0");
  });
  it("a page with no note shows the glass pill in the same box", () => {
    const { box, show } = createBox();
    show("a note", "i1:1");
    show("", "i1:2");
    const pill = box.querySelector(".notes-none") as FakeNode;
    expect(pill.textContent).toBe("No Notes for This Slide");
    expect(pill.classes).toContain("glass");
    expect(pill.hidden).toBe(false);
    expect((box.querySelector(".notes-text") as FakeNode).hidden).toBe(true);
    expect(box.classList.contains("notes-blank")).toBe(true);
    show("again", "i1:3");
    expect(pill.hidden).toBe(true);
    expect(box.classList.contains("notes-blank")).toBe(false);
  });
  it("text that looks like markup stays text: no element is made, and innerHTML is never touched", () => {
    const { box, show } = createBox();
    const attack = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    show(attack, "i1:1");
    const text = box.querySelector(".notes-text") as FakeNode;
    expect(text.textContent).toBe(attack);
    expect(text.kids).toEqual([]);
    expect(box.querySelectorAll("img, script")).toEqual([]);
  });
  it("a different slide starts at the top; the same one, painted again, keeps its place", () => {
    const { box, show } = createBox();
    show("long", "i1:1");
    box.scrollTop = 300;
    show("long", "i1:1");
    expect(box.scrollTop).toBe(300);
    show("other", "i1:2");
    expect(box.scrollTop).toBe(0);
    box.scrollTop = 120;
    show("", "i1:3");
    expect(box.scrollTop).toBe(0);
    box.scrollTop = 50;
    show("x", "i2:3");
    expect(box.scrollTop).toBe(0);
  });
});

describe("the notes layout", () => {
  const at = (page: number, present = true, item = "i1"): Shown => ({ item, page, present });

  async function run(shown: () => Shown | false, v = view()) {
    const s = scene();
    s.rows[0]?.setAttribute("aria-current", "true");
    // The remote's own place ends in the notes' update; a tap on the row reaches it through here.
    let places = 0;
    const update = mount(phone(v), shown, s.preview, () => {
      places++;
      update();
    });
    update();
    await flush();
    return { ...s, update, places: () => places };
  }

  it("fetches the deck's notes with the pid when Present is on, then folds the list and places the box", async () => {
    const { column, list, rows, preview, panel } = await run(() => at(1));
    expect(calls).toEqual([{ url: "/api/notes?item=i1", auth: "Bearer pid-1" }]);
    expect(list.classList.contains("notes-folded")).toBe(true);
    // Preview, then the notes, then the panel they run under.
    expect(column.kids).toEqual([list, preview, boxOf(column), panel]);
    expect(textOf(boxOf(column))).toBe("First note.\nSecond line.");
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(rows[0]?.querySelector(".notes-chevron")).not.toBeNull();
    expect(rows[1]?.querySelector(".notes-chevron")).toBeNull();
  });

  it("does nothing until Present is on, and asks nothing", async () => {
    const { column, list } = await run(() => at(1, false));
    expect(calls).toEqual([]);
    expect(list.classList.contains("notes-folded")).toBe(false);
    expect(boxOf(column)).toBeNull();
  });

  it("asks only for a paged item, and only on a narrow phone", async () => {
    const onPhoto = await run(() => at(1, true, "i2"));
    expect(calls).toEqual([]);
    expect(boxOf(onPhoto.column)).toBeNull();
    narrow = false;
    const wide = await run(() => at(1));
    expect(calls).toEqual([]);
    expect(wide.list.classList.contains("notes-folded")).toBe(false);
  });

  it("a deck with no note on any page keeps today's layout: no fold, no box, no chevron", async () => {
    for (const body of [{ notes: [] }, { notes: ["", "", "", "", ""] }, { notes: [" ", "\n"] }]) {
      answers.i1 = () => reply(body);
      const { column, list, rows } = await run(() => at(1));
      expect(list.classList.contains("notes-folded")).toBe(false);
      expect(boxOf(column)).toBeNull();
      expect(rows[0]?.querySelector(".notes-chevron")).toBeNull();
      expect(rows[0]?.getAttribute("aria-expanded")).toBeNull();
    }
  });

  it("a failed fetch is no notes: the plain layout and no error; the next Present asks again", async () => {
    answers.i1 = () => {
      throw new Error("offline");
    };
    let shown: Shown | false = at(1);
    const { column, list, update } = await run(() => shown);
    expect(list.classList.contains("notes-folded")).toBe(false);
    expect(boxOf(column)).toBeNull();
    // Paints during this Present do not ask again.
    update();
    await flush();
    expect(calls).toHaveLength(1);
    answers.i1 = () => reply({ notes: NOTES });
    shown = at(1, false);
    update();
    shown = at(1);
    update();
    await flush();
    expect(calls).toHaveLength(2);
    expect(list.classList.contains("notes-folded")).toBe(true);
  });

  it("a refusal or an answer that is not JSON is no notes too", async () => {
    answers.i1 = () => reply({ code: "pairing_invalid" }, 401);
    const refused = await run(() => at(1));
    expect(boxOf(refused.column)).toBeNull();
    answers.i1 = () => new Response("<html>blocked</html>", { status: 200, headers: { "X-Bloop": "1" } });
    const blocked = await run(() => at(1));
    expect(boxOf(blocked.column)).toBeNull();
    expect(blocked.list.classList.contains("notes-folded")).toBe(false);
  });

  it("holds the notes: a second Present does not ask again", async () => {
    let shown: Shown | false = at(1);
    const { update } = await run(() => shown);
    shown = at(1, false);
    update();
    shown = at(2);
    update();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("a page turn changes the text and sends the notes back to the top", async () => {
    let shown: Shown | false = at(1);
    const { column, update } = await run(() => shown);
    const box = boxOf(column);
    box.scrollTop = 240;
    update();
    expect(box.scrollTop).toBe(240);
    shown = at(3);
    update();
    expect(boxOf(column)).toBe(box);
    expect(textOf(box)).toBe("Third <b>note</b>");
    expect(box.scrollTop).toBe(0);
  });

  it("a page with no note keeps the same box and shows the pill", async () => {
    let shown: Shown | false = at(1);
    const { column, update } = await run(() => shown);
    const box = boxOf(column);
    shown = at(2);
    update();
    expect(boxOf(column)).toBe(box);
    expect(pillOf(box).hidden).toBe(false);
    expect(pillOf(box).textContent).toBe("No Notes for This Slide");
    expect(textOf(box)).toBe("");
    expect(column.kids.filter((k) => k === box)).toHaveLength(1);
    shown = at(3);
    update();
    expect(pillOf(box).hidden).toBe(true);
  });

  it("Stop gives the plain layout back, and the next Present folds it again", async () => {
    let shown: Shown | false = at(1);
    const { column, list, rows, update } = await run(() => shown);
    shown = at(1, false);
    update();
    expect(list.classList.contains("notes-folded")).toBe(false);
    expect(boxOf(column)).toBeNull();
    expect(rows[0]?.querySelector(".notes-chevron")).toBeNull();
    expect(rows[0]?.getAttribute("aria-expanded")).toBeNull();
    shown = at(1);
    update();
    expect(list.classList.contains("notes-folded")).toBe(true);
    expect(boxOf(column)).not.toBeNull();
  });

  it("the remote leaving (the session ended) takes the box and the fold with it", async () => {
    let shown: Shown | false = at(1);
    const { column, list, update } = await run(() => shown);
    shown = false;
    update();
    expect(boxOf(column)).toBeNull();
    expect(list.classList.contains("notes-folded")).toBe(false);
  });

  it("a rotation to a wide window gives the plain layout back", async () => {
    const { column, list, update } = await run(() => at(1));
    narrow = false;
    update();
    expect(boxOf(column)).toBeNull();
    expect(list.classList.contains("notes-folded")).toBe(false);
  });

  describe("the row on screen is the fold's handle", () => {
    it("a tap opens the list, drops the box and sends no command; another tap folds it again", async () => {
      const { column, list, rows, places } = await run(() => at(1));
      let commands = 0;
      list.addEventListener("click", () => commands++);
      (rows[0] as FakeNode).click();
      expect(commands).toBe(0);
      // The fold changes the column's height, so the remote places the preview again.
      expect(places()).toBe(1);
      expect(list.classList.contains("notes-folded")).toBe(false);
      expect(boxOf(column)).toBeNull();
      expect(rows[0]?.getAttribute("aria-expanded")).toBe("true");
      expect(rows[0]?.querySelector(".notes-chevron")).not.toBeNull();
      (rows[0] as FakeNode).click();
      expect(list.classList.contains("notes-folded")).toBe(true);
      expect(boxOf(column)).not.toBeNull();
      expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
      expect(commands).toBe(0);
    });

    it("another row, while open, is the remote's own tap", async () => {
      const { list, rows } = await run(() => at(1));
      (rows[0] as FakeNode).click();
      let commands = 0;
      list.addEventListener("click", () => commands++);
      (rows[1] as FakeNode).click();
      expect(commands).toBe(1);
    });

    it("a new item folds again, and one with no notes leaves the plain layout", async () => {
      let shown: Shown | false = at(1);
      const { column, list, rows, update } = await run(() => shown);
      (rows[0] as FakeNode).click();
      expect(list.classList.contains("notes-folded")).toBe(false);
      // The screen moves to another file: its row is the one marked.
      rows[0]?.removeAttribute("aria-current");
      rows[1]?.setAttribute("aria-current", "true");
      shown = at(1, true, "i2");
      update();
      await flush();
      expect(list.classList.contains("notes-folded")).toBe(false);
      expect(boxOf(column)).toBeNull();
      rows[1]?.removeAttribute("aria-current");
      rows[0]?.setAttribute("aria-current", "true");
      shown = at(1);
      update();
      expect(list.classList.contains("notes-folded")).toBe(true);
      expect(rows[1]?.querySelector(".notes-chevron")).toBeNull();
    });

    it("a tap when nothing is folded is the remote's own", async () => {
      const { list, rows } = await run(() => at(1, false));
      let commands = 0;
      list.addEventListener("click", () => commands++);
      (rows[0] as FakeNode).click();
      expect(commands).toBe(1);
    });
  });
});

describe("the remote's hook", () => {
  /** The remote as remote-ui.js builds it, over a template with the parts it reads. */
  function remote(v = view()) {
    const s = scene();
    const part = (tag: string, attrs: Record<string, string>) => {
      const n = new FakeNode(tag);
      for (const [k, val] of Object.entries(attrs)) n.setAttribute(k, val);
      return n;
    };
    const parts = new FakeNode("template");
    const preview = part("div", { class: "preview" });
    const count = part("span", { class: "count" });
    preview.append(count);
    const bubbles = part("fieldset", { class: "bubbles" });
    const buttons = {
      back: part("button", { "data-step": "-1" }),
      present: part("button", { "data-present": "" }),
      ahead: part("button", { "data-step": "1" }),
      play: part("button", { "data-play": "" }),
      sound: part("button", { "data-sound": "" }),
    };
    bubbles.append(...Object.values(buttons));
    parts.append(preview, part("p", { "data-note": "" }), bubbles);
    // The remote places its own preview; the scene's stand-in only keeps the column's shape.
    s.preview.remove();
    const doc2 = (globalThis as unknown as { document: Record<string, unknown> }).document;
    vi.stubGlobal("document", {
      ...doc2,
      getElementById: (id: string) => (id === "remote-parts" ? { content: parts } : id === "file-list" ? s.list : null),
      querySelector: (selector: string) => (selector === ".column > .actions" ? s.panel : null),
    });
    const c = phone(v);
    answers.control = () => reply({});
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const path = new URL(url, "https://x.test");
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      if (path.pathname === "/api/control") {
        const sent = JSON.parse(init.body as string);
        return reply({ ...c.view, shown: sent, v: (c.view?.v ?? 0) + 1 });
      }
      return answers[path.searchParams.get("item") ?? ""]?.() ?? reply({ notes: [] });
    });
    const paint = mountRemote(c, (next) => {
      c.view = next;
      paint(true);
    });
    s.rows[0]?.setAttribute("aria-current", "true");
    paint(true);
    return { ...s, c, paint, preview, ...buttons };
  }

  it("Present on a deck with notes folds the list and shows the notes under the preview", async () => {
    const r = remote();
    expect(calls).toEqual([]);
    expect(r.list.classList.contains("notes-folded")).toBe(false);
    r.present.click();
    await flush();
    expect(calls.map((x) => x.url)).toContain("/api/notes?item=i1");
    expect(r.list.classList.contains("notes-folded")).toBe(true);
    const box = boxOf(r.column);
    expect(textOf(box)).toBe("First note.\nSecond line.");
    expect(r.column.kids.indexOf(box)).toBe(r.column.kids.indexOf(r.preview) + 1);
  });

  it("Present on a deck with no notes leaves the list and asks once", async () => {
    answers.i1 = () => reply({ notes: [] });
    const r = remote();
    r.present.click();
    await flush();
    expect(calls.filter((x) => x.url.startsWith("/api/notes"))).toHaveLength(1);
    expect(r.list.classList.contains("notes-folded")).toBe(false);
    expect(boxOf(r.column)).toBeNull();
  });

  it("a failed notes fetch leaves the list as it is", async () => {
    answers.i1 = () => {
      throw new Error("offline");
    };
    const r = remote();
    r.present.click();
    await flush();
    expect(r.list.classList.contains("notes-folded")).toBe(false);
    expect(boxOf(r.column)).toBeNull();
  });

  it("asks nothing before Present, nor for a photo", async () => {
    const r = remote(view({ shown: { item: "i2", page: 1, present: false } }));
    await flush();
    expect(calls).toEqual([]);
    r.present.click();
    await flush();
    expect(calls.filter((x) => x.url.startsWith("/api/notes"))).toEqual([]);
  });
});
