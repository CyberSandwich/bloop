// The Screen object's endFromOwner: its pure body, and that no HTTP path or socket frame reaches it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endLine } from "../../public/js/core/copy-screen.js";
import type { EndReason } from "../../src/shared/protocol.ts";
import { type EffectDeps, noopSeams, runEffects } from "../../src/worker/do/effects.ts";
import type { Effect, Machine } from "../../src/worker/machine.ts";
import { accountEndRedo, ownerEnd } from "../../src/worker/seams/open-path/lookups.ts";
import type { Meta } from "../../src/worker/views.ts";
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
    choices: ["17", "42", "85"],
  }).next;
  if (!approve) return claimed;
  const picked = must(claimed, { e: "match", now: T0 + sec(2), choice: "42" }).next;
  const listed = must(picked, { e: "listed", now: T0 + sec(2), ids: [DECK.ref] }).next;
  return must(listed, { e: "approve", now: T0 + sec(3), items: [asItem(DECK)], minutes: MAX_MINUTES }).next;
}

describe("endFromOwner", () => {
  const now = T0 + sec(10);

  it("ends an approved or claimed session its user owns, reason account, actor system, revoking the links", () => {
    expect(ownerEnd(ownedBy("u1"), "u1", now)).toEqual({ e: "end", now, by: "account" });
    expect(ownerEnd(ownedBy("u1", false), "u1", now)).toEqual({ e: "end", now, by: "account" });
    const { next, effects } = must(ownedBy("u1"), { e: "end", now, by: "account" });
    expect(next.state).toBe("ended");
    expect(next.endReason).toBe("account");
    expect(fx(effects, "revokeLinks")).toHaveLength(1);
    expect(fx(effects, "purge")).toEqual([]);
    expect(fx(effects, "audit")).toEqual([{ fx: "audit", type: "ended", actor: "system" }]);
    expect(must(ownedBy("u1"), { e: "timer", now: T0 + sec(3) + MAX_MINUTES * 60_000 }).next.endReason).toBe("auto");
  });

  it("changes nothing for another owner, no pairing or an ended session", () => {
    expect(ownerEnd(ownedBy("u1"), "u2", now)).toBeNull();
    expect(ownerEnd(waiting("live"), "u1", now)).toBeNull();
    expect(ownerEnd(null, "u1", now)).toBeNull();
    const ended = must(ownedBy("u1"), { e: "end", now, by: "account" }).next;
    expect(ownerEnd(ended, "u1", now + 1)).toBeNull();
  });

  it("an account end already applied re-runs only its revoke and push; any other machine has nothing to redo", () => {
    const ended = must(ownedBy("u1"), { e: "end", now, by: "account" }).next;
    expect(accountEndRedo(ended)).toEqual([{ fx: "revokeLinks" }, { fx: "push", to: "both" }]);
    const byPhone = must(ownedBy("u1"), { e: "end", now, by: "phone" }).next;
    for (const m of [byPhone, ownedBy("u1"), waiting("live"), null]) expect(accountEndRedo(m)).toEqual([]);
  });

  it("a revoke that threw is retried by the next call, and a further call changes nothing", async () => {
    const meta: Meta = {
      screenRef: "ref",
      mode: "live",
      roomId: null,
      roomName: null,
      screenSecretHash: "x",
      createdAt: T0,
      linkOrigin: "file",
    };
    let revokes = 0;
    let revoked = false;
    const deps: EffectDeps = {
      directory: { put: async () => "ok", remove: async () => {} },
      audit: { record: async () => {} },
      metrics: { record: async () => {}, activeWeek: async () => {} },
      seams: {
        ...noopSeams,
        revokeLinks: async () => {
          revokes++;
          if (revokes === 1) throw new Error("storage");
          revoked = true;
        },
      },
      push: () => {},
      deleteAll: async () => {},
    };
    // As the Screen object does: commit the step, then run its effects; then redo on each later call.
    let m = ownedBy("u1");
    const call = async () => {
      const ev = ownerEnd(m, "u1", now);
      const prev = m;
      let effects: Effect[];
      if (ev) {
        const step = must(m, ev);
        m = step.next;
        effects = step.effects;
      } else effects = accountEndRedo(m);
      await runEffects(effects, { meta, prev, next: m, now }, deps);
    };
    await expect(call()).rejects.toThrow("storage");
    expect(m.state).toBe("ended");
    expect(revoked).toBe(false);
    await call();
    expect(revoked).toBe(true);
    const settled = m;
    await call();
    expect(m).toBe(settled);
    expect(revoked).toBe(true);
  });

  it("every end reason has a defined screen line, and an account end never says Time's up", () => {
    const reasons: Record<EndReason, true> = {
      phone: true,
      screen: true,
      auto: true,
      canceled: true,
      claim_timeout: true,
      error: true,
      account: true,
    };
    const left = { ppt: false, download: null };
    for (const reason of Object.keys(reasons) as EndReason[])
      expect(typeof endLine(reason, left), reason).toBe("string");
    expect(endLine("account", left)).toBe(endLine("phone", left));
    expect(endLine("account", { ppt: true, download: "Talk.pptx" })).not.toContain("Time's up.");
    expect(endLine("auto", left)).toBe("Time's up.");
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
