import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cleanName, isValidName, NAME_MAX } from "../../public/js/shared/file-name.js";

const ZWJ = "\u200d";
const ZWNJ = "\u200c";
const FLAG = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
const FAMILY = ["\u{1F468}", "\u{1F469}", "\u{1F467}", "\u{1F466}"].join(ZWJ);
const PERSIAN = `می${ZWNJ}خواهم.pdf`;

describe("DROP-08 xss: the one refused set, upload and rename", () => {
  it("keeps a ZWJ sequence, a subdivision flag and a ZWNJ name whole", () => {
    for (const kept of [FAMILY, FLAG, PERSIAN, `a${FLAG}.pdf`]) {
      expect(cleanName(kept)).toBe(kept);
      expect(isValidName(kept)).toBe(true);
    }
  });

  it("refuses the invisible and blank characters, each one", () => {
    const refused = [
      0x0000, 0x0007, 0x00ad, 0x180e, 0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x202e, 0x2066, 0xfeff, 0xfff9,
      0xfffa, 0xfffb, 0x115f, 0x1160, 0x3164, 0xffa0, 0xe0001,
    ];
    for (const code of refused) {
      const name = `a${String.fromCodePoint(code)}b.pdf`;
      expect(cleanName(name), code.toString(16)).toBe("ab.pdf");
      expect(isValidName(name), code.toString(16)).toBe(false);
    }
  });

  it("strips exactly the reference set, checked over every code point (the u-flag class equals the v-flag one)", () => {
    // The v flag is only this test's reference; the tsconfig target predates it, so the flag is not a literal.
    const setFlag: string = "v";
    const reference = new RegExp(
      "[[\\p{C}--[\\u200C\\u200D\\u{E0020}-\\u{E007F}]]\\u115F\\u1160\\u3164\\uFFA0]",
      setFlag,
    );
    const wrong: string[] = [];
    const strippedIn = (char: string) => cleanName(`a${char}b`) === "ab";
    // Most code points are unassigned, so the expected-stripped ones go through cleanName in chunks (one call per
    // 2000, `-` between pieces so nothing composes across them); a chunk that differs is re-read one by one. A walk of
    // 1.1M single calls took 1.4 s idle and passed the 5 s default only by luck on a loaded runner.
    const CHUNK = 5000;
    const want = Array(CHUNK).fill("ab").join("-");
    let chunk: number[] = [];
    let text = "";
    const flush = () => {
      if (cleanName(text, Number.MAX_SAFE_INTEGER) !== want.slice(0, chunk.length * 3 - 1))
        for (const c of chunk) if (!strippedIn(String.fromCodePoint(c))) wrong.push(c.toString(16));
      chunk = [];
      text = "";
    };
    for (let code = 0; code <= 0x10ffff; code++) {
      const char = String.fromCodePoint(code);
      const expected = reference.test(char) || (code >= 0xe0020 && code <= 0xe007f);
      if (!expected) {
        if (strippedIn(char)) wrong.push(code.toString(16));
        continue;
      }
      chunk.push(code);
      text += `${chunk.length > 1 ? "-" : ""}a${char}b`;
      if (chunk.length === CHUNK) flush();
    }
    flush();
    expect(wrong).toEqual([]);
  });

  it("keeps a joiner only between visible characters and a tag only inside a flag", () => {
    for (const hidden of [ZWJ, ZWNJ, `${ZWJ}${ZWNJ}`, "\u{E0067}", "\u{E007F}", FLAG.slice(2), ` ${ZWJ} `]) {
      expect(cleanName(hidden), JSON.stringify(hidden)).toBe("");
      expect(isValidName(hidden)).toBe(false);
    }
    expect(cleanName(`a ${ZWJ} b`)).toBe("a b");
    expect(cleanName(`a${ZWJ}`)).toBe("a");
    expect(cleanName(`${ZWNJ}a`)).toBe("a");
    expect(cleanName(`a\u{E0067}b`)).toBe("ab");
    expect(cleanName(`\u{1F3F4}\u{E0067}b`)).toBe("\u{1F3F4}b");
  });

  it("refuses on rename what cleaning would change, so no name is stored that upload would not store", () => {
    for (const odd of [" a ", "a  b", "é", "a/b", "a\\b", "a\tb"]) expect(isValidName(odd), odd).toBe(false);
    expect(isValidName("é")).toBe(true);
    expect(isValidName("a".repeat(NAME_MAX))).toBe(true);
    expect(isValidName("a".repeat(NAME_MAX + 1))).toBe(false);
  });

  it("cuts without splitting a flag or leaving a trailing space, keeping the extension", () => {
    const cut = cleanName(`${FLAG.repeat(40)}.pdf`, 20);
    expect(cut).toBe(`${FLAG.repeat(2)}.pdf`);
    expect(cleanName(`${"a".repeat(7)} ${"b".repeat(9)}.pdf`, 12)).toBe("aaaaaaa.pdf");
    expect(cleanName("é".repeat(300))).toBe("é".repeat(200));
  });

  it("cleaning is idempotent and its output is always a valid name, whatever the input", () => {
    const pool = [
      "a",
      "b",
      " ",
      "  ",
      "/",
      "\\",
      ".",
      ".pdf",
      "\u00e9",
      "e\u0301",
      "\u0301",
      ZWJ,
      ZWNJ,
      "\u{1F468}",
      "\u{1F3F4}",
      "\u{E0067}",
      "\u{E007F}",
      "\u0000",
      "\u202e",
      "\u00ad",
      "\u3164",
      "\t",
      "\u{1F600}",
      FLAG,
      "-",
    ];
    const names = fc.array(fc.constantFrom(...pool), { maxLength: 60 }).map((parts) => parts.join(""));
    fc.assert(
      fc.property(names, fc.integer({ min: 1, max: 40 }), (raw, max) => {
        for (const limit of [NAME_MAX, max]) {
          const once = cleanName(raw, limit);
          expect(cleanName(once, limit)).toBe(once);
          expect(Array.from(once).length).toBeLessThanOrEqual(limit);
          if (limit === NAME_MAX && once !== "") expect(isValidName(once)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe("browser floor: syntax names.js and its siblings must load on", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const path = join(dir, f);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".js") ? [path] : [];
    });

  it("no public script builds a regex with the v flag or a lookbehind (design.md floor: Safari 15.4)", () => {
    const offenders: string[] = [];
    for (const path of files(join(import.meta.dirname, "../../public/js"))) {
      const text = readFileSync(path, "utf8");
      if (/new RegExp\([^)]*,\s*["'`][a-z]*v[a-z]*["'`]\s*\)/.test(text)) offenders.push(`${path}: v flag`);
      if (/\(\?<[=!]/.test(text)) offenders.push(`${path}: lookbehind`);
    }
    expect(offenders).toEqual([]);
  });
});
