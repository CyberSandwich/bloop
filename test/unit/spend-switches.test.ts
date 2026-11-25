import { describe, expect, it } from "vitest";
import {
  effectiveAll,
  effectiveSwitch,
  isAllowedValue,
  isStricter,
  isSwitchName,
  mostRestrictiveValue,
  restrictiveness,
  SWITCH_NAMES,
  SWITCHES,
} from "../../src/worker/spend/switches.ts";

describe("switch registry", () => {
  it("lists the fifteen switches, each default allowed, each var named SWITCH_<NAME> and unique", () => {
    expect(SWITCH_NAMES).toHaveLength(15);
    const vars = SWITCH_NAMES.map((n) => SWITCHES[n].var);
    expect(new Set(vars).size).toBe(15);
    for (const n of SWITCH_NAMES) {
      expect(SWITCHES[n].var).toBe(`SWITCH_${n.toUpperCase()}`);
      expect(SWITCHES[n].values).toContain(SWITCHES[n].default);
    }
  });

  it("pins every default: all least restrictive, except launch_mode (preview) and convert (account_only)", () => {
    const defaults = Object.fromEntries(SWITCH_NAMES.map((n) => [n, SWITCHES[n].default]));
    expect(defaults).toEqual({
      launch_mode: "preview",
      guest_files: "on",
      guest_drop: "open",
      demo: "on",
      demo_drop: "on",
      uploads: "on",
      convert: "account_only",
      convert_video: "on",
      email: "on",
      signin_code: "on",
      invites: "on",
      file_origin: "workers_dev",
      export: "on",
      previews: "on",
      breaker: "auto",
    });
  });

  it("pins the allowed values in order, least restrictive first", () => {
    expect(SWITCHES.convert.values).toEqual(["on", "account_only", "off"]);
    expect(SWITCHES.uploads.values).toEqual(["on", "readonly", "off"]);
    expect(SWITCHES.email.values).toEqual(["on", "admin_only", "off"]);
    expect(SWITCHES.guest_drop.values).toEqual(["open", "pass", "off"]);
    expect(SWITCHES.file_origin.values).toEqual(["workers_dev", "main", "off"]);
    expect(SWITCHES.guest_files.values).toEqual(["on", "stopped"]);
    expect(SWITCHES.breaker.values).toEqual(["auto", "alert_only"]);
  });

  it("knows names and values", () => {
    expect(isSwitchName("convert")).toBe(true);
    expect(isSwitchName("toString")).toBe(false);
    expect(isAllowedValue("convert", "off")).toBe(true);
    expect(isAllowedValue("convert", "maybe")).toBe(false);
    expect(isAllowedValue("nope", "on")).toBe(false);
    expect(restrictiveness("convert", "off")).toBe(2);
    expect(restrictiveness("convert", "maybe")).toBe(-1);
    expect(mostRestrictiveValue("uploads")).toBe("off");
  });

  it("isStricter compares by position", () => {
    expect(isStricter("convert", "off", "account_only")).toBe(true);
    expect(isStricter("convert", "account_only", "account_only")).toBe(false);
    expect(isStricter("convert", "on", "off")).toBe(false);
    expect(isStricter("convert", "bogus", "on")).toBe(false);
  });
});

describe("effective switch: the more restrictive of the var and the row", () => {
  it("uses the default when there is no row and no var", () => {
    expect(effectiveSwitch("convert", undefined, undefined)).toBe("account_only");
    expect(effectiveSwitch("uploads", undefined, undefined)).toBe("on");
  });

  it("a row alone sets the value, in either direction from the default", () => {
    expect(effectiveSwitch("convert", undefined, "on")).toBe("on");
    expect(effectiveSwitch("convert", undefined, "off")).toBe("off");
  });

  it("the var is a floor: a row cannot loosen it, and a stricter row wins over it", () => {
    expect(effectiveSwitch("uploads", "readonly", "on")).toBe("readonly");
    expect(effectiveSwitch("uploads", "readonly", undefined)).toBe("readonly");
    expect(effectiveSwitch("uploads", "readonly", "off")).toBe("off");
    expect(effectiveSwitch("uploads", "off", "readonly")).toBe("off");
  });

  it("a var at the least restrictive value, or empty, is no floor", () => {
    expect(effectiveSwitch("convert", "on", undefined)).toBe("account_only");
    expect(effectiveSwitch("convert", "on", "on")).toBe("on");
    expect(effectiveSwitch("convert", "", "on")).toBe("on");
  });

  it("a value the switch does not allow counts as the most restrictive, in the row or the var", () => {
    expect(effectiveSwitch("uploads", undefined, "garbage")).toBe("off");
    expect(effectiveSwitch("uploads", "garbage", "on")).toBe("off");
    expect(effectiveSwitch("demo", "OFF", undefined)).toBe("off");
  });

  it("a one-line var flip stops a feature even when D1 says otherwise", () => {
    expect(effectiveSwitch("email", "off", "on")).toBe("off");
  });

  it("effectiveAll reads every switch from vars and rows, ignoring non-string vars", () => {
    const all = effectiveAll({ SWITCH_UPLOADS: "readonly", SWITCH_DEMO: 7 }, { convert: "off", uploads: "on" });
    expect(all.uploads).toBe("readonly");
    expect(all.convert).toBe("off");
    expect(all.demo).toBe("on");
    expect(Object.keys(all).sort()).toEqual([...SWITCH_NAMES].sort());
  });
});
