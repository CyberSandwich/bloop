// The Screen object's endFromOwner: its pure body, and that no HTTP path or socket frame reaches it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Machine } from "../../src/worker/machine.ts";
import { ownerEnd } from "../../src/worker/seams/open-path/lookups.ts";
import { asItem, DECK, fx, MAX_MINUTES, must, sec, T0, waiting } from "./machine-helpers.ts";

const root = new URL("../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });

function ownedBy(userId: string, approve = true): Machine {
  const claimed = must(waiting("live"), {
    e: "claim",
    now: T0 + sec(1),
    code: "AAAAAA",
    sessionId: "s1",
    secretHash: "hash",
    match: "42",
    kind: "owner",
    userId,
    passHash: null,
  }).next;
  if (!approve) return claimed;
  const listed = must(claimed, { e: "listed", now: T0 + sec(2), ids: [DECK.ref] }).next;
  return must(listed, { e: "approve", now: T0 + sec(3), items: [asItem(DECK)], minutes: MAX_MINUTES }).next;
}

describe("endFromOwner", () => {
  const now = T0 + sec(10);

  it("ends an approved or claimed session its user owns, by system, revoking the links", () => {
    expect(ownerEnd(ownedBy("u1"), "u1", now)).toEqual({ e: "end", now, by: "system" });
    expect(ownerEnd(ownedBy("u1", false), "u1", now)).toEqual({ e: "end", now, by: "system" });
    const { next, effects } = must(ownedBy("u1"), { e: "end", now, by: "system" });
    expect(next.state).toBe("ended");
    expect(fx(effects, "revokeLinks")).toHaveLength(1);
  });

  it("changes nothing for another owner, no pairing or an ended session", () => {
    expect(ownerEnd(ownedBy("u1"), "u2", now)).toBeNull();
    expect(ownerEnd(waiting("live"), "u1", now)).toBeNull();
    expect(ownerEnd(null, "u1", now)).toBeNull();
    const ended = must(ownedBy("u1"), { e: "end", now, by: "system" }).next;
    expect(ownerEnd(ended, "u1", now + 1)).toBeNull();
  });

  it("is reached by no route, router, entry point or socket frame", () => {
    const http = [
      ...walk("src/worker/routes"),
      "src/worker/router.ts",
      "src/worker/index.ts",
      "src/worker/frames.ts",
      "src/worker/seams/pairing.ts",
    ];
    for (const path of http) expect(read(path), path).not.toContain("endFromOwner");
    for (const path of walk("public/js")) expect(read(path), path).not.toContain("endFromOwner");
    // In the Screen object it is named once: its own definition, outside fetch and the socket handlers.
    expect(read("src/worker/do/screen.ts").match(/endFromOwner/g)).toHaveLength(1);
  });
});
