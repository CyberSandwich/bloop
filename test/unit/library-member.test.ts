// The library's member resolver is A's (auth/member.ts): it must keep what the old library resolver did (ADR 0013: use
// clears an inactivity warning, never a requested deletion), and the export spends nothing per member for a cross-site GET.
import { describe, expect, it, vi } from "vitest";
import { resolveMember } from "../../src/worker/library/member.ts";
import { type AnyRoute, GRAPH, memberWorld, recordingLimits, seedMember, setMode, sid } from "./member-fixture.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const DAY = 86_400_000;
const asRequest = (cookie: string) => new Request("https://x.test/api/library", { headers: { Cookie: sid(cookie) } });
const rowOf = (db: ReturnType<typeof memberWorld>["db"], id: string) =>
  db.raw
    .prepare(
      "SELECT status, last_seen_at AS seen, inactive_warned_at AS warned, delete_after AS due FROM app_user WHERE id = ?",
    )
    .get(id);

describe("ADR 0013: use clears an inactivity warning, through the library's resolver", () => {
  it("a warned active member who returns is unmarked and counted as seen, so the next lapse is warned again", async () => {
    const { db, env, config } = memberWorld({ ...GRAPH, TEST_TIMING: "0" });
    setMode(db, "open");
    const cookie = await seedMember(db, "m1", "m1@example.test");
    const old = Date.now() - 800 * DAY;
    db.raw
      .prepare("UPDATE app_user SET last_seen_at = ?, inactive_warned_at = ?, delete_after = ? WHERE id = 'm1'")
      .run(old, old + 700 * DAY, Date.now() + 5 * DAY);
    const who = await resolveMember(asRequest(cookie), env, config);
    expect(who.ok).toBe(true);
    expect(rowOf(db, "m1")).toMatchObject({ status: "active", warned: null, due: null });
    expect((rowOf(db, "m1") as { seen: number }).seen).toBeGreaterThan(old + 700 * DAY);
  });

  it("a member in the deletion grace keeps the requested date: use never cancels a deletion", async () => {
    const { db, env, config } = memberWorld({ ...GRAPH, TEST_TIMING: "0" });
    setMode(db, "open");
    const cookie = await seedMember(db, "m2", "m2@example.test");
    const due = Date.now() + 5 * DAY;
    db.raw
      .prepare("UPDATE app_user SET status = 'deleting', last_seen_at = ?, delete_after = ? WHERE id = 'm2'")
      .run(Date.now() - 3 * DAY, due);
    const who = await resolveMember(asRequest(cookie), env, config);
    expect(who.ok).toBe(false);
    expect(rowOf(db, "m2")).toMatchObject({ status: "deleting", due });
  });
});

describe("LIB-10: a cross-site export GET", () => {
  it("meters the address and reads the session, but spends no member limit and reaches no object or bucket", async () => {
    // Non-literal specifiers: the route modules' type graph needs the Workers types the test tsconfig omits.
    const exportPath = "../../src/worker/routes/library-export.ts";
    const libraryPath = "../../src/worker/routes/library.ts";
    const { exportRoute } = (await import(exportPath)) as { exportRoute: (deps: object) => AnyRoute };
    const { defaultDeps } = (await import(libraryPath)) as { defaultDeps: object };
    const { db, env } = memberWorld({ ...GRAPH, TEST_TIMING: "0" });
    setMode(db, "open");
    const cookie = await seedMember(db, "m3", "m3@example.test");
    const { seen, bindings } = recordingLimits();
    const route = exportRoute({ ...defaultDeps, take: async () => true });
    const untouched = new Proxy({}, { get: () => assertUnreachable() });
    const response = await route.handler(
      new Request("https://x.test/api/me/export.zip?k=abcdefgh1", {
        headers: { Cookie: sid(cookie), "Sec-Fetch-Site": "cross-site" },
      }),
      { ...env, ...bindings, LIBRARY: untouched, USER_LIBRARY: untouched, GUEST_FILES: untouched } as never,
      route.pattern.exec("https://x.test/api/me/export.zip") as URLPatternResult,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(response.status).toBe(403);
    const names = seen.map(([name]) => name);
    expect(names).toContain("RL_MEMBER_IP");
    expect(names).not.toContain("RL_LIBRARY");
  });
});

function assertUnreachable(): never {
  throw new Error("a cross-site export reached an object or a bucket");
}
