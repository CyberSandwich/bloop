import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A specifier in a variable: the node tsconfig has no DOM lib, so it must not follow this import into page code.
const FACE = "../../public/js/core/upload-face.js";
const { fitName, MIN_NAME_CHARS } = (await import(FACE)) as {
  fitName: (node: never) => void;
  MIN_NAME_CHARS: number;
};

const FONT_PX = 15;
/** The width 8 characters of this font take: a name with less room than this is dropped. */
const NEEDED = Math.ceil(MIN_NAME_CHARS * 0.55 * FONT_PX);

class Pill {
  classes = new Set<string>();
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
  };
  /** The room the name has when it is shown; a hidden name has none. */
  room = 200;
  head = {
    get clientWidth() {
      return pill.classes.has("bare") ? 0 : pill.room;
    },
  };
  querySelector(selector: string) {
    return selector === ".head" ? this.head : {};
  }
}
let pill: Pill;
let observed: unknown[];
let run: () => void;

beforeEach(() => {
  pill = new Pill();
  observed = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        run = cb;
      }
      observe(node: unknown) {
        observed.push(node);
      }
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: `${FONT_PX}px` }));
});
afterEach(() => vi.unstubAllGlobals());

describe("the name fit", () => {
  it("watches the text area and the status", () => {
    fitName(pill as never);
    expect(observed).toHaveLength(2);
  });

  it("keeps a name that has room for 8 characters, even a long one cut short to them", () => {
    fitName(pill as never);
    pill.room = NEEDED;
    run();
    expect(pill.classes.has("bare")).toBe(false);
  });

  it("drops a name with room for fewer than 8 characters, rather than ellipsize it to a stub", () => {
    fitName(pill as never);
    pill.room = NEEDED - 1;
    run();
    expect(pill.classes.has("bare")).toBe(true);
  });

  it("measures with the name shown, so a dropped name comes back when the room does", () => {
    fitName(pill as never);
    pill.room = 10;
    run();
    expect(pill.classes.has("bare")).toBe(true);
    pill.room = 200;
    run();
    expect(pill.classes.has("bare")).toBe(false);
  });
});
