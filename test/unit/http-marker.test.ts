import { describe, expect, it } from "vitest";
import { json, problem } from "../../src/worker/http.ts";

describe("REL-03 the API marker", () => {
  it("every ok JSON answer carries X-Bloop: 1, so a filter's 200 page is told apart from it", () => {
    expect(json({ ok: true }).headers.get("X-Bloop")).toBe("1");
    expect(json({}, 200, { "Cache-Control": "no-store" }).headers.get("X-Bloop")).toBe("1");
  });

  it("an error answer needs none: the client reads the problem body", () => {
    expect(problem(404, "not_found").headers.get("X-Bloop")).toBeNull();
  });
});
