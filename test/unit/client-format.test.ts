import { describe, expect, it } from "vitest";
import {
  ago,
  clock,
  codeFromSearch,
  qrLabel,
  sizeLabel,
  spelled,
  splitName,
  typedCode,
  typedValid,
} from "../../public/js/core/format.js";
import { POLL_MS, pollDelay, RECONNECT_DELAYS, reconnectDelay, shouldPoll } from "../../public/js/core/timing.js";

describe("typed code formatting", () => {
  it.each([
    ["", ""],
    ["k7", "K7"],
    ["k7m", "K7M"],
    ["k7mq", "K7M Q"],
    ["k7mq9x", "K7M Q9X"],
    ["K7M Q9X", "K7M Q9X"],
    ["k7m-q9x", "K7M Q9X"],
    ["  k7m  q9x  ", "K7M Q9X"],
    ["k7mq9xz22", "K7M Q9XZ"], // at most 7 symbols
  ])("%j reads %j", (raw, shown) => {
    expect(typedCode(raw)).toBe(shown);
  });

  it("formatting is idempotent, so a controlled input never fights the user", () => {
    for (const raw of ["k", "k7mq", "k7mq9x", "ab-cd ef"]) {
      expect(typedCode(typedCode(raw))).toBe(typedCode(raw));
    }
  });

  it("deleting the space leaves the first group", () => {
    expect(typedCode("K7M ".trimEnd())).toBe("K7M");
  });

  it("is valid at 6 symbols from the alphabet, never earlier or with look-alikes", () => {
    expect(typedValid("K7M Q9X")).toBe("K7MQ9X");
    expect(typedValid("K7M Q9")).toBeNull();
    expect(typedValid("K7M Q9O")).toBeNull(); // O is not in the alphabet
    expect(typedValid("")).toBeNull();
  });
});

describe("pairing code in the address", () => {
  it("reads c from the query", () => {
    expect(codeFromSearch("?c=K7MQ9X")).toBe("K7MQ9X");
    expect(codeFromSearch("")).toBeNull();
    expect(codeFromSearch("?other=1")).toBeNull();
  });
});

describe("time and size words", () => {
  it("shows a local clock time as 24 hour HH:MM", () => {
    expect(clock(Date.UTC(2026, 0, 5, 11, 35), "en-GB", "UTC")).toBe("11:35");
    expect(clock(Date.UTC(2026, 0, 5, 9, 5), "en-GB", "UTC")).toBe("09:05");
  });

  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [10 * 60_000, "10 min ago"],
    [59 * 60_000, "59 min ago"],
    [2 * 3_600_000, "2 hr ago"],
    [26 * 3_600_000, "1 day ago"],
    [3 * 86_400_000, "3 days ago"],
    [-5000, "just now"],
  ])("%d ms old reads %s", (age, text) => {
    expect(ago(1_000_000_000, 1_000_000_000 - age)).toBe(text);
  });

  it("splits a long name so the end and extension survive an ellipsis", () => {
    expect(splitName("Lecture 4.pptx")).toEqual(["Lecture 4.pptx", ""]);
    const [head, tail] = splitName("Strategy and operations review 2026.pptx");
    expect(head + tail).toBe("Strategy and operations review 2026.pptx");
    expect(tail.endsWith(".pptx")).toBe(true);
  });

  it.each([
    [0, "1 KB"],
    [500, "1 KB"],
    [81_196, "79 KB"],
    [1024 * 1024, "1.0 MB"],
    [2.45 * 1024 * 1024, "2.5 MB"],
    [10 * 1024 * 1024, "10.0 MB"],
  ])("%d bytes read %s", (bytes, text) => {
    expect(sizeLabel(bytes)).toBe(text);
  });

  it("spells the code for the QR label", () => {
    expect(spelled("K7MQ9X")).toBe("K 7 M, Q 9 X");
    expect(qrLabel("K7MQ9X", "bloop.example")).toBe(
      "QR code, scan with your phone, or enter the code K 7 M, Q 9 X at bloop.example slash code",
    );
  });
});

describe("reconnect backoff", () => {
  it("waits 1, 2, 5, 10, then 30 s", () => {
    expect([1, 2, 3, 4, 5].map(reconnectDelay)).toEqual([1000, 2000, 5000, 10_000, 30_000]);
    expect(RECONNECT_DELAYS).toEqual([1000, 2000, 5000, 10_000, 30_000]);
  });

  it("holds at 30 s and never goes below 1 s", () => {
    expect(reconnectDelay(6)).toBe(30_000);
    expect(reconnectDelay(500)).toBe(30_000);
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(-3)).toBe(1000);
  });

  it("polls after the 3rd failed reconnect", () => {
    expect([0, 1, 2, 3, 4].map(shouldPoll)).toEqual([false, false, false, true, true]);
  });

  it("polls every 3 s while polls work and backs off 5, 10, 30 s when they fail", () => {
    expect(pollDelay(0)).toBe(POLL_MS);
    expect([1, 2, 3, 4, 9].map(pollDelay)).toEqual([5000, 10_000, 30_000, 30_000, 30_000]);
  });
});
