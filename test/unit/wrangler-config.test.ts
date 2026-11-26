import { describe, expect, it } from "vitest";
import { stripJsonComments, wranglerConfig } from "../../tools/wrangler-config.mjs";

describe("wrangler-config", () => {
  it("drops line, inline and block comments but keeps a // inside a string", () => {
    const text = '{\n  // a line\n  "url": "https://x.example/a", // inline\n  /* block */ "n": 1\n}';
    expect(wranglerConfig(text)).toEqual({ url: "https://x.example/a", n: 1 });
    expect(stripJsonComments('"a\\"//b"')).toBe('"a\\"//b"');
  });

  it("an unterminated block comment drops the rest instead of looping", () => {
    expect(stripJsonComments('{"a": 1} /* never closed')).toBe('{"a": 1} ');
  });
});
