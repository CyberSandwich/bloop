// A tap anywhere but a link, or Enter, cuts Session Ended short; the listeners load with the first Session Ended.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A non-literal specifier: a literal would make the node tsconfig typecheck page code, which needs the DOM lib.
const SKIP = "../../public/js/core/skip-ended.js";

class El {}
class Anchor extends El {}
const listeners: Record<string, (e: unknown) => void> = {};
const tap = (inLink: boolean) => ({
  target: Object.assign(new El(), { closest: (sel: string) => (inLink && sel === "a" ? {} : null) }),
});

describe("the Ended skip listens once and skips on a tap or Enter outside a link", () => {
  const skip = vi.fn();
  let listen: (skip: () => void) => void;

  beforeEach(async () => {
    vi.resetModules();
    skip.mockReset();
    vi.stubGlobal("Element", El);
    vi.stubGlobal("HTMLAnchorElement", Anchor);
    vi.stubGlobal("document", {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn;
      },
    });
    listen = (await import(SKIP)).listen;
  });

  it("a tap outside a link skips, and a tap on a link does not", () => {
    listen(skip);
    listeners.click?.(tap(false));
    expect(skip).toHaveBeenCalledTimes(1);
    listeners.click?.(tap(true));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("Enter skips unless it repeats or lands on a link", () => {
    listen(skip);
    listeners.keydown?.({ key: "Enter", repeat: false, target: new El() });
    expect(skip).toHaveBeenCalledTimes(1);
    listeners.keydown?.({ key: "Enter", repeat: true, target: new El() });
    listeners.keydown?.({ key: "Enter", repeat: false, target: new Anchor() });
    listeners.keydown?.({ key: "a", repeat: false, target: new El() });
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("a second Session Ended adds no second pair of listeners", () => {
    const add = vi.fn();
    vi.stubGlobal("document", { addEventListener: add });
    listen(skip);
    listen(skip);
    expect(add).toHaveBeenCalledTimes(2);
  });
});

describe("the screen page loads the skip with the first Session Ended only", () => {
  const page = readFileSync(new URL("../../public/js/screen.js", import.meta.url), "utf8");

  it("only import() reaches it, from the Ended branch of onView", () => {
    expect(page).not.toMatch(/^import .*skip-ended/m);
    expect(page).toMatch(
      /view\.state === "ended" && s\.view\?\.state !== "ended"[\s\S]*?import\("\.\/core\/skip-ended\.js"\)/,
    );
  });

  it("a failed load leaves the hold to run its length: the import has no required result", () => {
    expect(page).toMatch(/import\("\.\/core\/skip-ended\.js"\)\.then\(\(m\) => m\.listen\(skipEnded\)\)/);
  });
});
