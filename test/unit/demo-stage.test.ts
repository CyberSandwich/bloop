import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { phoneCopy } from "../../public/js/core/copy.js";
import { demoPose, isPoseName } from "../../public/js/core/robin-pose.js";
import { phoneMockKey, stageCopy, stageState } from "../../public/js/demo/stage.js";

const STATES = ["waiting", "scanned", "approved", "open", "ended", "busy", "error"] as const;

describe("the stage's demo states (design.md section 6)", () => {
  it("DEMO-01 flow: maps every screen state key to a stage state, and a dropped socket to none", () => {
    expect(stageState("waiting")).toBe("waiting");
    expect(["scanned", "choosing", "guest_open"].map((k) => stageState(k as never))).toEqual(Array(3).fill("scanned"));
    expect(["approved", "opening"].map((k) => stageState(k as never))).toEqual(["approved", "approved"]);
    expect(["open", "open_fallback", "pdf_fallback"].map((k) => stageState(k as never))).toEqual(Array(3).fill("open"));
    expect(stageState("ended")).toBe("ended");
    expect(stageState("offline")).toBeNull();
    expect(stageState("rate_limited")).toBe("busy");
    expect(["error", "service_down", "phone_width"].map((k) => stageState(k as never))).toEqual(Array(3).fill("error"));
  });

  it("DEMO-01 flow: writes the strings the design gives, with the match digits in the scanned line", () => {
    expect(stageCopy("waiting", null)).toEqual({
      heading: "Demo screen",
      line: "Scan with your phone camera to try it.",
      action: null,
    });
    expect(stageCopy("scanned", "42")).toMatchObject({ heading: "Check your phone.", line: "It should show 42." });
    expect(stageCopy("approved", null)).toMatchObject({ heading: "Approved.", line: "Opening the sample deck." });
    expect(stageCopy("open", null)).toEqual({
      heading: "The sample deck is open.",
      line: "This page has no account. It was shown one file.",
      action: "Run It Again",
    });
    expect(stageCopy("ended", null)).toMatchObject({ heading: "Ended.", line: "Scan the new code to try again." });
    expect(stageCopy("error", null)).toEqual({ heading: "Unable to start the demo.", line: "", action: "Try Again" });
    expect(stageCopy("busy", null)).toEqual({
      heading: "Too many demos open right now.",
      line: "Try again in a few minutes.",
      action: null,
    });
  });

  it("DEMO-01 flow: offers an action only where the design has one", () => {
    expect(STATES.filter((s) => stageCopy(s, null).action !== null)).toEqual(["open", "error"]);
  });

  it("DEMO-01 flow: echoes the real phone sheets, and shows none before a scan or after an error", () => {
    expect(STATES.map(phoneMockKey)).toEqual([null, "approve_demo", "opening", "open", "ended", null, null]);
    expect(phoneCopy("approve_demo", { room: "Demo room", file: null, endsAt: null }).title).toBe(
      "Open the sample deck here?",
    );
  });

  it("never says a phrase on the never-say list", () => {
    const never = readFileSync(new URL("../../tools/never-say.txt", import.meta.url), "utf8")
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"));
    const text = STATES.flatMap((s) => Object.values(stageCopy(s, "42")))
      .join(" ")
      .toLowerCase();
    for (const phrase of never) expect(text, phrase).not.toContain(phrase);
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("robin reactions to the demo (design.md section 8)", () => {
  it("looks at the code while waiting, turns to the phone on a scan, carries the slide, then rests", () => {
    expect(["waiting", "scanned", "approved", "open", "ended", "error"].map(demoPose)).toEqual([
      "look",
      "turn",
      "carry",
      "carry",
      "perch",
      "perch",
    ]);
  });

  it("always answers with a real pose, even for a state it does not know", () => {
    for (const state of [...STATES, "nonsense", ""]) expect(isPoseName(demoPose(state))).toBe(true);
  });
});
