import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { linkFileName, MAX_BASE, slugBase } from "../../public/js/shared/names.js";
import { parseConfig } from "../../src/worker/config.ts";
import type { FileRef } from "../../src/worker/machine.ts";
import {
  clientClass,
  type LinkRecord,
  MAX_LINK_CHARS,
  mintLink,
  nameBudget,
  parseToken,
  protocolUri,
  refusal,
} from "../../src/worker/seams/open-path/links.ts";

const REF = "AAAAAAAAAAAAAAAAAAAAAA";
const PRODUCTION = "https://bloop.dsap.workers.dev";
/** The longest origin config.ts accepts. */
const LONGEST_ORIGIN = `https://${"a".repeat(120 - "https://".length)}`;
const OFFICE_URI_LIMIT = 256;

const deck = (name: string, type: "pptx" | "pdf" = "pptx"): FileRef => ({ source: "mock", ref: "x", name, type });

describe("OPEN-06 names: the name segment is a safe slug (F7)", () => {
  it("keeps letters and digits, joins words with one hyphen and drops the extension it replaces", () => {
    expect(slugBase("Lecture 4 - Intro.pptx")).toBe("Lecture-4-Intro");
    expect(linkFileName("Lecture 4.PPTX", "pptx")).toBe("Lecture-4.pptx");
    expect(linkFileName("Handout.pdf", "pdf")).toBe("Handout.pdf");
  });

  it("removes every character the Office URI rules ban, plus percent, hash and the dots of ..", () => {
    for (const ch of ["\\", "/", ":", "?", "<", ">", "|", '"', "*", "%", "#", "\0", "\n", "‮"]) {
      expect(slugBase(`a${ch}b`)).toBe("a-b");
    }
    expect(slugBase("../../etc/passwd")).toBe("etc-passwd");
    expect(slugBase("..")).toBe("file");
    expect(slugBase("a|ofv|u|https://evil.example/x.pptx")).not.toMatch(/[|:/.]/);
  });

  it("folds accents and leaves nothing for a name with no Latin letters or digits", () => {
    expect(slugBase("Café Münchën")).toBe("Cafe-Munchen");
    expect(slugBase("講義スライド")).toBe("file");
    expect(slugBase("")).toBe("file");
    expect(slugBase("---")).toBe("file");
  });

  it("caps the base at the limit without ending on a hyphen", () => {
    expect(slugBase("a".repeat(500))).toHaveLength(MAX_BASE);
    expect(slugBase(`${"a".repeat(59)} b`)).toBe("a".repeat(59));
    expect(slugBase("abcdef", 3)).toBe("abc");
    expect(slugBase("abcdef", 0)).toBe("a");
  });

  it("property: any name gives 1 to 60 characters of [A-Za-z0-9-], never starting or ending with a hyphen", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (name) => {
        const slug = slugBase(name);
        expect(slug).toMatch(/^[A-Za-z0-9]([A-Za-z0-9-]{0,58}[A-Za-z0-9])?$/);
      }),
    );
  });
});

describe("OPEN-06 names: the whole Office URI stays under 256 characters", () => {
  const longest = `${"Ünïcode name | with * every ? bad : char ".repeat(30)}.pptx`;

  for (const [label, origin] of [
    ["the production origin", PRODUCTION],
    ["the longest origin config accepts", LONGEST_ORIGIN],
  ] as const) {
    it(`with the longest possible name on ${label}`, async () => {
      for (const [purpose, file] of [
        ["protocol", deck(longest)],
        ["download", deck(longest)],
        ["pdf", deck(longest)],
        ["protocol", deck(longest.replace(".pptx", ".pdf"), "pdf")],
      ] as const) {
        const link = await mintLink(REF, file, purpose, origin);
        expect(link.url.length).toBeLessThanOrEqual(MAX_LINK_CHARS);
        expect(protocolUri(link.url).length).toBeLessThanOrEqual(OFFICE_URI_LIMIT);
        expect(link.url).toMatch(/^https:\/\/[a-z.]+\/f\/[A-Za-z0-9_-]{54}\/[A-Za-z0-9-]+\.(pptx|pdf)$/);
      }
    });
  }

  it("a name at the budget gets exactly the 200 character link on the longest origin", async () => {
    const link = await mintLink(REF, deck("x".repeat(200)), "protocol", LONGEST_ORIGIN);
    expect(link.url.length).toBeLessThanOrEqual(MAX_LINK_CHARS);
    expect(nameBudget(LONGEST_ORIGIN, 4)).toBeGreaterThanOrEqual(1);
  });

  it("config refuses an origin so long that the budget would vanish", () => {
    const env = {
      PUBLIC_ORIGIN: `https://${"a".repeat(130)}.example`,
      HASH_PEPPER: "p".repeat(32),
      CODE_LENGTH: "6",
      CODE_TTL_SECONDS: "60",
      CODE_GRACE_SECONDS: "10",
      CLAIM_TIMEOUT_SECONDS: "300",
      UPLOAD_TIMEOUT_SECONDS: "900",
      SESSION_MAX_MINUTES: "90",
      DEMO_SESSION_MINUTES: "10",
      DEMO_ENABLED: "true",
      GUEST_DROP: "open",
    };
    const parsed = parseConfig(env);
    expect(parsed.ok).toBe(false);
    const good = parseConfig({ ...env, PUBLIC_ORIGIN: PRODUCTION });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    // defaults: redirect mode and the limits ADR 0003 states
    expect(good.config.openPathMode).toBe("redirect");
    expect(good.config.links).toEqual({
      firstFetchSeconds: 600,
      fetchWindowSeconds: 120,
      maxFetches: 10,
      maxMints: 5,
      binding: "log",
    });
    const tuned = parseConfig({ ...env, PUBLIC_ORIGIN: PRODUCTION, OPEN_PATH_MODE: "stream", LINK_MAX_FETCHES: "3" });
    expect(tuned.ok && [tuned.config.openPathMode, tuned.config.links.maxFetches]).toEqual(["stream", 3]);
    expect(parseConfig({ ...env, PUBLIC_ORIGIN: PRODUCTION, OPEN_PATH_MODE: "proxy" }).ok).toBe(false);
    expect(parseConfig({ ...env, PUBLIC_ORIGIN: PRODUCTION, LINK_BINDING_DEFAULT: "strict" }).ok).toBe(false);
  });
});

describe("mintLink", () => {
  it("builds https://<host>/f/<screenRef><32 chars>/<slug>.<ext> and hashes the token", async () => {
    const link = await mintLink(REF, deck("Lecture 4.pptx"), "protocol", PRODUCTION);
    expect(link.token).toHaveLength(54);
    expect(link.token.startsWith(REF)).toBe(true);
    expect(link.url).toBe(`${PRODUCTION}/f/${link.token}/Lecture-4.pptx`);
    expect(link.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(link.tokenHash).not.toContain(link.token);
    expect(protocolUri(link.url)).toBe(`ms-powerpoint:ofv|u|${link.url}`);
  });

  it("draws a fresh secret every time", async () => {
    const a = await mintLink(REF, deck("a.pptx"), "protocol", PRODUCTION);
    const b = await mintLink(REF, deck("a.pptx"), "protocol", PRODUCTION);
    expect(a.token).not.toBe(b.token);
  });

  it("names the PDF rendition of a deck .pdf, and turns a PDF file's launch into the inline view", async () => {
    expect((await mintLink(REF, deck("Lecture 4.pptx"), "pdf", PRODUCTION)).url).toMatch(/\/Lecture-4\.pdf$/);
    const own = await mintLink(REF, deck("Handout.pdf", "pdf"), "protocol", PRODUCTION);
    expect(own.purpose).toBe("pdf");
    expect(own.url).toMatch(/\/Handout\.pdf$/);
    expect((await mintLink(REF, deck("Handout.pdf", "pdf"), "download", PRODUCTION)).purpose).toBe("download");
  });
});

describe("parseToken", () => {
  it("accepts exactly 54 base64url characters and returns the screen ref", () => {
    expect(parseToken(`${REF}${"b".repeat(32)}`)).toEqual({ screenRef: REF });
    for (const bad of ["", REF, `${REF}${"b".repeat(31)}`, `${REF}${"b".repeat(33)}`, `${REF}${"b".repeat(31)}=`]) {
      expect(parseToken(bad)).toBeNull();
    }
  });
});

describe("OPEN-01 link-life rules", () => {
  const limits = {
    firstFetchSeconds: 600,
    fetchWindowSeconds: 120,
    maxFetches: 10,
    maxMints: 5,
    binding: "log",
  } as const;
  const rec = (over: Partial<LinkRecord> = {}): LinkRecord => ({
    tokenHash: "h",
    purpose: "protocol",
    item: 0,
    mintedAt: 1000,
    firstFetchAt: null,
    fetches: 0,
    revoked: false,
    ...over,
  });

  it("an unused link lives first-fetch seconds, then expires", () => {
    expect(refusal(rec(), 1000 + 599_999, limits)).toBeNull();
    expect(refusal(rec(), 1000 + 600_000, limits)).toBe("link_expired");
  });

  it("after the first fetch it lives the window, whatever the mint time says", () => {
    const fetched = rec({ firstFetchAt: 500_000, fetches: 1 });
    expect(refusal(fetched, 500_000 + 119_999, limits)).toBeNull();
    expect(refusal(fetched, 500_000 + 120_000, limits)).toBe("link_expired");
  });

  it("allows ten fetches and refuses the eleventh as exhausted", () => {
    expect(refusal(rec({ firstFetchAt: 1000, fetches: 9 }), 2000, limits)).toBeNull();
    expect(refusal(rec({ firstFetchAt: 1000, fetches: 10 }), 2000, limits)).toBe("link_exhausted");
  });

  it("a revoked link is revoked first, before any other reason", () => {
    expect(refusal(rec({ revoked: true, fetches: 10 }), 9_999_999, limits)).toBe("link_revoked");
  });
});

describe("clientClass", () => {
  it("separates Office, a browser and the rest, and never needs the raw header stored", () => {
    expect(clientClass("Microsoft Office PowerPoint/16.0")).toBe("office");
    expect(clientClass("Mozilla/4.0 (compatible; ms-office; MSOffice 16)")).toBe("office");
    expect(clientClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36")).toBe("browser");
    expect(clientClass("curl/8.0")).toBe("other");
    expect(clientClass(null)).toBe("other");
  });
});
