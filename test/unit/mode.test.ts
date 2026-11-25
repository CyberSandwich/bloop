import { describe, expect, it } from "vitest";
import { admitted, launchOf } from "../../src/worker/mode.ts";
import { RESTRICTIVE } from "../../src/worker/settings.ts";

describe("MODE-01 modes: the launch mode view", () => {
  it("MODE-01 modes: a missing row is preview with no lockout", () => {
    expect(launchOf({})).toEqual({ mode: "preview", lockout: false });
  });

  it("MODE-01 modes: open is exactly the value open; anything else is preview", () => {
    for (const value of ["OPEN", "open ", "true", "1", "", "preview"]) {
      expect(launchOf({ launch_mode: value }).mode, value).toBe("preview");
    }
    expect(launchOf({ launch_mode: "open" })).toEqual({
      mode: "open",
      lockout: false,
    });
  });

  it("MODE-01 modes: the lockout is set only by the value 1 and counts only in preview", () => {
    expect(launchOf({ preview_lockout: "1" })).toEqual({
      mode: "preview",
      lockout: true,
    });
    expect(launchOf({ preview_lockout: "yes" }).lockout).toBe(false);
    expect(launchOf({ preview_lockout: "1", launch_mode: "open" })).toEqual({
      mode: "open",
      lockout: false,
    });
  });

  it("MODE-01 modes: the restrictive settings are preview with the lockout", () => {
    expect(launchOf(RESTRICTIVE)).toEqual({ mode: "preview", lockout: true });
  });
});

describe("MODE-01 modes: who the lockout admits", () => {
  const account = {
    adminEmails: new Set(["admin@example.test"]),
    testEmails: new Set(["test@example.test"]),
  };
  const locked = { mode: "preview", lockout: true } as const;

  it("MODE-01 modes: with the lockout only the admin and test addresses pass", () => {
    expect(admitted(locked, account, "admin@example.test")).toBe(true);
    expect(admitted(locked, account, "test@example.test")).toBe(true);
    expect(admitted(locked, account, "member@example.test")).toBe(false);
  });

  it("MODE-01 modes: an Entra user (no email member) is never admitted", () => {
    expect(admitted(locked, account, null)).toBe(false);
    expect(admitted({ mode: "open", lockout: false }, account, null)).toBe(false);
  });

  it("MODE-01 modes: without the lockout every member passes", () => {
    expect(admitted({ mode: "preview", lockout: false }, account, "member@example.test")).toBe(true);
    expect(admitted({ mode: "open", lockout: false }, account, "member@example.test")).toBe(true);
  });
});
