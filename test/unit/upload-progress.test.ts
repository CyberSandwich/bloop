import { describe, expect, it } from "vitest";
import { admitProgress, PROGRESS_EVERY_MS, type Sent } from "../../src/worker/do/progress.ts";

describe("Screen.uploadProgress throttle", () => {
  it("sends the first report, then at most one a second per upload", () => {
    const sent = new Map<string, Sent>();
    expect(admitProgress(sent, "u1", 0.1, 0)).toBe(true);
    expect(admitProgress(sent, "u1", 0.2, PROGRESS_EVERY_MS - 1)).toBe(false);
    expect(admitProgress(sent, "u1", 0.3, PROGRESS_EVERY_MS)).toBe(true);
    // Another upload has its own second.
    expect(admitProgress(sent, "u2", 0.1, PROGRESS_EVERY_MS)).toBe(true);
  });

  it("never sends a fraction at or below the last one sent", () => {
    const sent = new Map<string, Sent>();
    expect(admitProgress(sent, "u1", 0.5, 0)).toBe(true);
    expect(admitProgress(sent, "u1", 0.4, 5000)).toBe(false);
    expect(admitProgress(sent, "u1", 0.5, 6000)).toBe(false);
    expect(sent.get("u1")).toEqual({ at: 0, fraction: 0.5 });
  });

  it("refuses a fraction outside 0 to 1, not a number, or no upload id", () => {
    const sent = new Map<string, Sent>();
    for (const f of [-0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY])
      expect(admitProgress(sent, "u1", f, 0)).toBeNull();
    expect(admitProgress(sent, "", 0.5, 0)).toBeNull();
    expect(sent.size).toBe(0);
  });

  it("holds a bounded number of uploads, forgetting the oldest", () => {
    const sent = new Map<string, Sent>();
    for (let i = 0; i < 40; i++) admitProgress(sent, `u${i}`, 0.5, i);
    expect(sent.size).toBe(16);
    expect(sent.has("u0")).toBe(false);
    expect(sent.has("u39")).toBe(true);
  });
});
