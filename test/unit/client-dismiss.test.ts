// The outside-tap dismiss (core/dismiss.js) over a fake window, and the class guard: every overlay on every page is a
// modal dialog (the page under it is inert) or a popover whose page loads the dismiss (design.md section 6, Overlays).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Fake = {
  timeStamp: number;
  target: unknown;
  eaten: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
};
const listeners = new Map<string, ((e: Fake) => void)[]>();
/** Loaded by path, as the pages load it: the module is browser JS outside the node tsconfig. */
const DISMISS = "../../public/js/core/dismiss.js";
let popovers: { id: string; open: boolean; contains(t: unknown): boolean; matches(): boolean; hidePopover(): void }[] =
  [];
let selector = "";

beforeAll(async () => {
  vi.stubGlobal("addEventListener", (type: string, fn: (e: Fake) => void, capture: boolean) => {
    expect(capture, `${type} listens in the capture phase, before any page listener`).toBe(true);
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  });
  vi.stubGlobal("document", {
    querySelectorAll: (s: string) => {
      selector = s;
      return popovers.filter((p) => p.open);
    },
  });
  const { guardDismiss } = await import(DISMISS);
  guardDismiss();
  guardDismiss();
});

const sheet = { id: "side", inside: { closest: () => null } };
const invoker = { closest: (s: string) => (s === '[popovertarget="side"]' ? {} : null) };
const slide = { closest: () => null };

beforeEach(() => {
  popovers = [
    {
      id: sheet.id,
      open: true,
      contains: (t) => t === sheet.inside,
      matches() {
        return this.open;
      },
      hidePopover() {
        this.open = false;
      },
    },
  ];
});

function fire(type: string, target: unknown, timeStamp: number): boolean {
  const e: Fake = {
    timeStamp,
    target,
    eaten: false,
    preventDefault() {},
    stopImmediatePropagation() {
      this.eaten = true;
    },
  };
  for (const fn of listeners.get(type) ?? []) fn(e);
  return e.eaten;
}

/** One tap at `t` ms: whether each of its pointerdown, pointerup and click reached the page. */
const tap = (target: unknown, t: number) => [
  !fire("pointerdown", target, t),
  !fire("pointerup", target, t + 40),
  !fire("click", target, t + 41),
];

describe("guardDismiss", () => {
  it("installs its three listeners once, however often a page asks", () => {
    expect([...listeners].map(([type, fns]) => `${type} ${fns.length}`).sort()).toEqual([
      "click 1",
      "pointerdown 1",
      "pointerup 1",
    ]);
  });

  it("a tap outside the open sheet only closes it: its pointer events and click reach nothing", () => {
    expect(tap(slide, 1000)).toEqual([false, false, false]);
    expect(popovers[0]?.open).toBe(false);
  });

  it("iOS's late click, within 350 ms of the closing pointerup, is the same tap's; one after it is a new tap's", () => {
    tap(slide, 1000);
    expect(fire("click", slide, 1040 + 349)).toBe(true);
    expect(fire("click", slide, 1040 + 351)).toBe(false);
  });

  it("a new tap ends the quiet: a fast tap back on the handle, or a key's click after it, still lands", () => {
    tap(slide, 1000);
    popovers = [];
    expect(tap(invoker, 1100)).toEqual([true, true, true]);
  });

  it("a tap in any open popover is that one's, even when another popover is open beside it", () => {
    const other = { closest: () => null };
    popovers.push({ ...popovers[0], id: "leave", contains: (t: unknown) => t === other } as (typeof popovers)[0]);
    expect(tap(other, 1000)).toEqual([true, true, true]);
  });

  it("with the sheet closed, a tap reaches the page", () => {
    popovers = [];
    expect(tap(slide, 5000)).toEqual([true, true, true]);
  });

  it("a tap inside the sheet, or on its own handle, is the sheet's: nothing is eaten", () => {
    expect(tap(sheet.inside, 9000)).toEqual([true, true, true]);
    expect(tap(invoker, 10000)).toEqual([true, true, true]);
    expect(popovers[0]?.open).toBe(true);
  });

  it("a manual popover (the library's toast) never light-dismisses, so it is never asked for", () => {
    tap(slide, 20000);
    expect(selector).toBe(":popover-open:not([popover=manual])");
  });
});

const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(`${PUBLIC}${dir}`, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? (d.name === "vendor" ? [] : walk(`${dir}${d.name}/`)) : [`${dir}${d.name}`],
  );
const files = walk("");
const read = (f: string) => readFileSync(`${PUBLIC}${f}`, "utf8");
/** The site menu: the landing's JS has no bytes left for the import (tools/size/core.json, landing JS). */
const PENDING = new Set(["nav-links"]);
const LOAD = 'import("./core/dismiss.js")';
/** The ids of a page's light-dismiss popovers: any `popover` value but manual, attributes in any order. */
const popoversOf = (html: string) =>
  [...html.matchAll(/<[a-z]+\s([^>]*)>/g)].flatMap(([, attrs = ""]) => {
    const value = attrs.match(/(?:^|\s)popover(?:="([^"]*)")?(?=\s|$)/);
    const id = attrs.match(/(?:^|\s)id="([^"]+)"/)?.[1];
    return value && value[1] !== "manual" && id ? [id] : [];
  });
const scriptsOf = (html: string) =>
  [...html.matchAll(/<script type="module" src="\/(js\/[^"]+)"/g)].map((m) => read(m[1] ?? ""));

describe("every overlay", () => {
  it("a light-dismiss popover's page loads the dismiss from its module script", () => {
    const missing: string[] = [];
    for (const page of files.filter((f) => f.endsWith(".html"))) {
      const html = read(page);
      const loads = popoversOf(html).length > 0 && scriptsOf(html).some((js) => js.includes(LOAD));
      for (const id of popoversOf(html)) if (!loads && !PENDING.has(id)) missing.push(`${page} #${id}`);
    }
    expect(missing).toEqual([]);
    // The check finds the room screen's two, whatever order a tag's attributes come in.
    expect(popoversOf(read("s.html")).sort()).toEqual(["leave", "side"]);
    expect(popoversOf('<p popover="hint" id="a"></p><p id="b" popover="manual"></p>')).toEqual(["a"]);
  });

  it("a popover made by script is a manual one: only markup popovers light-dismiss", () => {
    const bad = files
      .filter((f) => f.endsWith(".js"))
      .flatMap((f) =>
        [...read(f).matchAll(/\.popover = ([^;]+);|setAttribute\("popover", ([^)]+)\)|\bpopover: ([^,}]+)/g)].map(
          (m) => `${f}: ${m[1] ?? m[2] ?? m[3]}`,
        ),
      )
      .filter((line) => !line.includes('"manual"'));
    expect(bad).toEqual([]);
  });

  it("a dialog opens modal, never with show() or the open attribute: the page under it is inert, so its backdrop tap reaches nothing", () => {
    const bad: string[] = [];
    for (const f of files) {
      const text = read(f);
      if (f.endsWith(".html") && /<dialog [^>]*\bopen[\s>=]/.test(text)) bad.push(`${f}: an open dialog`);
      // A file that makes or finds a dialog; upload-pill's sheet.show() is upload-sheet's own showModal.
      if (/el\("dialog"|HTMLDialogElement/.test(text) && /\.show\(\)/.test(text)) bad.push(`${f}: show()`);
    }
    expect(bad).toEqual([]);
  });
});
