import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsonComments } from "../../tools/jsonc.mjs";

describe("jsonc", () => {
  it("drops line, inline and block comments but keeps a // inside a string", () => {
    const text = '{\n  // a line\n  "url": "https://x.example/a", // inline\n  /* block */ "n": 1\n}';
    expect(parseJsonc(text)).toEqual({ url: "https://x.example/a", n: 1 });
    expect(stripJsonComments('"a\\"//b"')).toBe('"a\\"//b"');
  });
});
