import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configFor } from "../../src/worker/config.ts";
import { effectivePolicy } from "../../src/worker/seams/guest-drop/index.ts";
import { cleanName, isValidName, NAME_MAX } from "../../src/worker/uploads/file-name.ts";
import { RATE_LIMIT_STUBS } from "../env-vars.ts";

describe("DROP-06 policy: which rooms take a drop", () => {
  it("a demo screen always takes one, whatever the configured policy", () => {
    expect(effectivePolicy(null, "demo", "off")).toBe("open");
    expect(effectivePolicy("pass", "demo", "off")).toBe("open");
  });

  it("a live room uses its own policy, else the configured one", () => {
    expect(effectivePolicy("pass", "live", "open")).toBe("pass");
    expect(effectivePolicy("off", "live", "open")).toBe("off");
    expect(effectivePolicy(null, "live", "open")).toBe("open");
    expect(effectivePolicy(null, "live", "pass")).toBe("pass");
  });
});

describe("DROP-08 xss: display names", () => {
  it("removes control, format and bidi characters and turns path separators into hyphens", () => {
    expect(cleanName("a\u0000b‮c.pptx")).toBe("abc.pptx");
    expect(cleanName("..\\..\\evil/x.pptx")).toBe("..-..-evil-x.pptx");
    expect(cleanName("  a   b \n c.pdf ")).toBe("a b c.pdf");
  });

  it("keeps markup as plain text for textContent to show, and keeps the extension when it cuts", () => {
    expect(cleanName("<img src=x onerror=alert(1)>.pptx")).toBe("<img src=x onerror=alert(1)>.pptx");
    const long = `${"a".repeat(300)}.pptx`;
    const cut = cleanName(long);
    expect(Array.from(cut)).toHaveLength(NAME_MAX);
    expect(cut.endsWith(".pptx")).toBe(true);
  });

  it("counts code points: 200 emoji stay whole, 201 are cut to 200 on upload and refused on rename", () => {
    const at = "😀".repeat(200);
    const over = "😀".repeat(201);
    expect(cleanName(at)).toBe(at);
    expect(Array.from(cleanName(over))).toHaveLength(NAME_MAX);
    expect(cleanName(`${over}.pdf`).endsWith(".pdf")).toBe(true);
    expect(isValidName(at)).toBe(true);
    expect(isValidName(over)).toBe(false);
    expect(isValidName("")).toBe(false);
  });

  it("keeps ZWJ sequences, subdivision flags and ZWNJ, and refuses bidi overrides and NUL, in one set for upload and rename", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    const persian = "می‌خواهم.pdf";
    for (const kept of [family, england, persian]) {
      expect(cleanName(kept)).toBe(kept);
      expect(isValidName(kept)).toBe(true);
    }
    for (const [refused, left] of [
      ["a‮b.pdf", "ab.pdf"],
      ["a\u0000b.pdf", "ab.pdf"],
      ["a​b.pdf", "ab.pdf"],
    ] as const) {
      expect(cleanName(refused)).toBe(left);
      expect(isValidName(refused)).toBe(false);
    }
  });

  it("is empty when nothing printable is left", () => {
    expect(cleanName("​\u0007 ")).toBe("");
  });
});

describe("DROP-01 size: configuration", () => {
  const env = {
    PUBLIC_ORIGIN: "https://bloop.example",
    HASH_PEPPER: "x".repeat(40),
    FILE_SOURCE: "mock",
    OPEN_PATH_MODE: "redirect",
    CODE_LENGTH: "6",
    CODE_TTL_SECONDS: "60",
    CODE_GRACE_SECONDS: "10",
    CLAIM_TIMEOUT_SECONDS: "300",
    UPLOAD_TIMEOUT_SECONDS: "900",
    SESSION_MAX_MINUTES: "90",
    DEMO_MAX_MINUTES: "10",
    DEMO_ENABLED: "true",
    GUEST_DROP: "open",
    ...RATE_LIMIT_STUBS,
  };
  const parse = (extra: Record<string, string>) => configFor({ ...env, ...extra });

  it("DROP-01 defaults to 25 MB live and demo for every type, and a 5 GiB budget", () => {
    const parsed = parse({});
    if (!parsed.ok) throw new Error(parsed.problems.join());
    expect(parsed.config).toMatchObject({
      guestMaxBytes: 26_214_400,
      demoGuestMaxBytes: 26_214_400,
      guestStorageBudgetBytes: 5_368_709_120,
    });
  });

  it("DROP-01 cap: the deployed single-PUT cap is at most 25 MB (a 60 MB streamed PUT was killed by the platform)", () => {
    const vars = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const live = Number(/"GUEST_MAX_BYTES":\s*"(\d+)"/.exec(vars)?.[1]);
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThanOrEqual(25 * 1024 * 1024);
  });

  it("refuses a cap over the platform's 100 MB body limit", () => {
    expect(parse({ GUEST_MAX_BYTES: String(101 * 1024 * 1024) }).ok).toBe(false);
    expect(parse({ DEMO_GUEST_MAX_BYTES: "0" }).ok).toBe(false);
  });
});
