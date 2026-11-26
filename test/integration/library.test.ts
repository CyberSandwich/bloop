// The library routes against a real wrangler dev: a member is a seeded row with a session cookie, since sign-in is the
// accounts change's. Files are rows only; the purge finds empty prefixes, which is the same code path.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPreview } from "../../src/worker/library/preview.ts";
import { Socket, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const FILE_TOKEN_KEY = "k".repeat(40);
let wrangler: Wrangler;

const now = Date.now();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const cookieOf = (name: string) => `${name}-cookie-value`;
const JAR = (name: string) => `__Host-bloop_sid=${cookieOf(name)}`;

function member(name: string, extra = ""): string[] {
  return [
    `INSERT INTO app_user (id, tid, oid, email, created_at, last_seen_at, email_norm, status${extra ? ", delete_after" : ""})
       VALUES ('${name}', 'email', '${name}', '${name}@example.test', ${now}, ${now}, '${name}@example.test', '${extra ? "deleting" : "active"}'${extra ? `, ${extra}` : ""})`,
    `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id)
       VALUES ('${sha(cookieOf(name))}', '${name}', ${now}, ${now}, ${now + 86_400_000}, 'pub-${name}')`,
  ];
}

function file(id: string, user: string, over: Record<string, string | number> = {}): string {
  const row: Record<string, string | number> = {
    id,
    user_id: user,
    name: `${id}.pptx`,
    ext: "pptx",
    bytes: 100,
    version: 1,
    r2_key: `u/${user}/${id}/v1/orig`,
    status: "ready",
    created_at: now,
    updated_at: now,
    crc32: 0,
    ...over,
  };
  const values = Object.values(row).map((v) => (typeof v === "string" ? `'${v}'` : v));
  return `INSERT INTO library_file (${Object.keys(row).join(", ")}) VALUES (${values.join(", ")})`;
}

const seed = (statements: string[]) => wrangler.d1(statements.join("; "));

interface Reply {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  text: string;
}

async function call(
  who: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(`${wrangler.url}${path}`, {
    method,
    headers: {
      Origin: wrangler.url,
      ...(who ? { Cookie: JAR(who) } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

const filesOf = (r: Reply) => (r.body.files as { id: string; name: string; selected: boolean }[]).map((f) => f.id);

beforeAll(async () => {
  wrangler = await startPairing({ FILE_TOKEN_KEY }, { migrate: true });
  seed([
    ...member("ann"),
    ...member("bob"),
    ...member("dee", String(now + 5 * 86_400_000)),
    ...member("sue"),
    ...member("sam"),
    ...member("sal"),
    "UPDATE app_user SET suspended_at = 1 WHERE id = 'sue'",
    file("a1", "ann"),
    file("a2", "ann", { updated_at: now - 1000 }),
    file("b1", "bob"),
  ]);
}, 120_000);
afterAll(async () => {
  await wrangler?.stop();
});

describe("who may call", () => {
  it("answers a signed-out request, a suspended member and an unknown cookie alike", async () => {
    const answers = [await call(null, "GET", "/api/library"), await call("sue", "GET", "/api/library")];
    answers.push(await call("nobody", "GET", "/api/library"));
    expect(answers.map((a) => [a.status, a.body.code])).toEqual([
      [401, "auth_required"],
      [401, "auth_required"],
      [401, "auth_required"],
    ]);
  });

  it("gives a member in the deletion grace the card's data and nothing else", async () => {
    const res = await call("dee", "GET", "/api/library");
    expect([res.status, res.body.code, typeof res.body.deleteAfter]).toEqual([403, "account_deleting", "number"]);
  });

  it("refuses a write from another origin, and one that is not JSON", async () => {
    const cross = await call("ann", "POST", "/api/library/a1/trash", {}, { Origin: "https://evil.example" });
    expect([cross.status, cross.body.code]).toEqual([403, "forbidden_origin"]);
    const res = await fetch(`${wrangler.url}/api/library/a1/trash`, {
      method: "POST",
      headers: {
        Origin: wrangler.url,
        Cookie: JAR("ann"),
        "Content-Type": "text/plain",
      },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });
});

describe("LIB-01 idor: another member's ids", () => {
  it("answers every verb for a foreign id exactly as for an unknown id", async () => {
    const verbs: [string, string, unknown][] = [
      ["PATCH", "", { name: "x" }],
      ["PATCH", "", { selected: true }],
      ["POST", "/trash", {}],
      ["POST", "/restore", {}],
      ["POST", "/preview", { asset: "bundle" }],
    ];
    for (const [method, tail, body] of verbs) {
      const foreign = await call("bob", method, `/api/library/a1${tail}`, body);
      const unknown = await call("bob", method, `/api/library/zzz${tail}`, body);
      expect(foreign.status, `${method}${tail}`).toBe(404);
      expect(foreign.text, `${method}${tail}`).toBe(unknown.text);
    }
    expect(wrangler.d1("SELECT trashed_at FROM library_file WHERE id = 'a1'")[0]?.trashed_at).toBeNull();
  });

  it("lists only the caller's files", async () => {
    expect(filesOf(await call("bob", "GET", "/api/library"))).toEqual(["b1"]);
    expect(filesOf(await call("ann", "GET", "/api/library"))).toEqual(["a1", "a2"]);
  });
});

describe("list, rename and Up Next", () => {
  it("lists with the limits, the quota and a strong ETag that answers 304", async () => {
    const res = await call("ann", "GET", "/api/library");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.body).toMatchObject({
      view: "files",
      sort: "updated",
      next: null,
      upNext: [],
      limits: { upNext: 12 },
      trash: { count: 0, bytes: 0 },
      account: { state: "active" },
    });
    const etag = res.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const again = await fetch(`${wrangler.url}/api/library`, {
      headers: { Cookie: JAR("ann"), "If-None-Match": etag },
    });
    expect(again.status).toBe(304);
  });

  it("answers 200 with a new ETag once the list has changed, and the old tag no longer matches", async () => {
    const before = (await call("sam", "GET", "/api/library")).headers.get("etag") ?? "";
    seed([file("s1", "sam")]);
    const stale = await fetch(`${wrangler.url}/api/library`, {
      headers: { Cookie: JAR("sam"), "If-None-Match": before },
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("etag")).not.toBe(before);
    const body = (await stale.json()) as { files: { id: string; kind: string }[]; limits: Record<string, number> };
    expect(body.files.map((f) => f.id)).toEqual(["s1"]);
    expect(body.files[0]?.kind).toBe("deck");
    expect(body.limits.largeFileChoiceBytes).toBeGreaterThan(0);
  });

  it("renames keeping the extension, and refuses what LIB-06 names", async () => {
    const ok = await call("ann", "PATCH", "/api/library/a2", {
      name: "Lecture 5",
    });
    expect([ok.status, ok.body.name]).toEqual([200, "Lecture 5.pptx"]);
    const bad = await call("ann", "PATCH", "/api/library/a2", { name: "a/b" });
    expect([bad.status, bad.body.code]).toEqual([400, "bad_request"]);
    const both = await call("ann", "PATCH", "/api/library/a2", {
      name: "x",
      selected: true,
    });
    expect(both.status).toBe(400);
  });

  it("LIB-02 race: a thirteenth tick is refused and a doubled tick is a no-op", async () => {
    seed(Array.from({ length: 12 }, (_, i) => file(`t${i}`, "bob")));
    const ticks = await Promise.all(
      Array.from({ length: 12 }, (_, i) => call("bob", "PATCH", `/api/library/t${i}`, { selected: true })),
    );
    expect(ticks.map((t) => t.status)).toEqual(Array(12).fill(200));
    const full = await call("bob", "PATCH", "/api/library/b1", {
      selected: true,
    });
    expect([full.status, full.body.code]).toEqual([409, "up_next_full"]);
    expect((await call("bob", "PATCH", "/api/library/t0", { selected: true })).status).toBe(200);
    const after = await call("bob", "GET", "/api/library");
    expect((after.body.upNext as string[]).length).toBe(12);
  });

  it("reorders Up Next with one PUT and answers the order that resulted", async () => {
    const put = await call("bob", "PUT", "/api/library/up-next", {
      ids: ["t2", "t0", "nope"],
    });
    expect([put.status, put.body.upNext]).toEqual([200, ["t2", "t0"]]);
    const cleared = await call("bob", "PUT", "/api/library/up-next", {
      ids: [],
    });
    expect(cleared.body.upNext).toEqual([]);
    expect(
      (
        await call("bob", "PUT", "/api/library/up-next", {
          ids: Array(13).fill("x"),
        })
      ).status,
    ).toBe(400);
  });
});

describe("the Sample Deck", () => {
  const KEY = "3f1f8a52-7a0e-4d6b-9a55-1c2b3d4e5f60";
  it("adds one ready deck per Idempotency-Key, answers the same row on a replay, and lists it", async () => {
    const first = await call("sal", "POST", "/api/library/sample", {}, { "Idempotency-Key": KEY });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: "Sample deck.pptx", ext: "pptx", kind: "deck", status: "ready" });
    const again = await call("sal", "POST", "/api/library/sample", {}, { "Idempotency-Key": KEY });
    expect([again.status, again.body.id]).toEqual([200, first.body.id]);
    expect(filesOf(await call("sal", "GET", "/api/library"))).toEqual([first.body.id]);
    expect(wrangler.d1("SELECT count(*) AS n FROM library_file WHERE user_id = 'sal'")[0]?.n).toBe(1);
  });

  it("needs a member and refuses a key that is not a UUID", async () => {
    const anon = await call(null, "POST", "/api/library/sample", {}, { "Idempotency-Key": KEY });
    expect(anon.status).toBe(401);
    const bad = await call("sal", "POST", "/api/library/sample", {}, { "Idempotency-Key": "not-a-uuid" });
    expect(bad.status).toBe(400);
  });
});

describe("trash, restore and Delete Now", () => {
  it("moves to the trash, lists it there, and restores it", async () => {
    const moved = await call("ann", "POST", "/api/library/a1/trash", {});
    expect(moved.status).toBe(200);
    expect(moved.body.leftScreens).toEqual([]);
    expect(filesOf(await call("ann", "GET", "/api/library"))).toEqual(["a2"]);
    const trash = await call("ann", "GET", "/api/library?view=trash");
    expect(filesOf(trash)).toEqual(["a1"]);
    expect(trash.body.trash).toMatchObject({ count: 1 });
    const back = await call("ann", "POST", "/api/library/a1/restore", {});
    expect([back.status, back.body.id]).toEqual([200, "a1"]);
    expect((await call("ann", "POST", "/api/library/a1/restore", {})).status).toBe(404);
  });

  it("Delete Now closes the restore at once, and the alarm purges and tells the open page", async () => {
    await call("ann", "POST", "/api/library/a2/trash", {});
    const socket = await Socket.open(wrangler.url, "/api/library/ws", wrangler.url, { Cookie: JAR("ann") });
    await socket.waitFor((f) => f.t === "hello");
    const due = await call("ann", "POST", "/api/library/trash/delete", {
      ids: ["a2", "b1"],
    });
    expect([due.status, due.body.due]).toEqual([202, 1]);
    expect((await call("ann", "POST", "/api/library/a2/restore", {})).status).toBe(404);
    await socket.waitFor((f) => f.t === "quota", 15_000);
    socket.close();
    expect(wrangler.d1("SELECT status FROM library_file WHERE id = 'a2'")[0]?.status).toBe("purged");
    expect(wrangler.d1("SELECT status FROM library_file WHERE id = 'b1'")[0]?.status).toBe("ready");
    expect((await call("ann", "GET", "/api/library?view=trash")).body.files).toEqual([]);
  });

  it("a retried Delete Now of a file that is already due still starts the purge", async () => {
    seed([file("r1", "bob", { trashed_at: now - 5000, purge_after: now - 1000 })]);
    const again = await call("bob", "POST", "/api/library/trash/delete", { ids: ["r1"] });
    expect([again.status, again.body.due]).toEqual([202, 0]);
    const until = Date.now() + 20_000;
    let status: unknown = "ready";
    while (status !== "purged" && Date.now() < until) {
      status = wrangler.d1("SELECT status FROM library_file WHERE id = 'r1'")[0]?.status;
      if (status !== "purged") await new Promise((r) => setTimeout(r, 500));
    }
    expect(status).toBe("purged");
  });

  it("empties the trash with all, and an empty body is refused", async () => {
    seed([file("e1", "bob", { trashed_at: now, purge_after: now + 86_400_000 })]);
    const emptied = await call("bob", "POST", "/api/library/trash/delete", {
      all: true,
    });
    expect([emptied.status, emptied.body.due]).toEqual([202, 1]);
    expect((await call("bob", "POST", "/api/library/trash/delete", {})).status).toBe(400);
  });
});

describe("the socket", () => {
  it("says hello, and refuses a cross-site page, a signed-out request and a missing upgrade", async () => {
    const socket = await Socket.open(wrangler.url, "/api/library/ws", wrangler.url, { Cookie: JAR("bob") });
    expect((await socket.waitFor((f) => f.t === "hello")).t).toBe("hello");
    socket.close();
    await expect(
      Socket.open(wrangler.url, "/api/library/ws", "https://evil.example", {
        Cookie: JAR("bob"),
      }),
    ).rejects.toThrow();
    await expect(Socket.open(wrangler.url, "/api/library/ws", wrangler.url)).rejects.toThrow();
    expect((await call("bob", "GET", "/api/library/ws")).status).toBe(400);
  });

  it("LIB-01 idor: a member's socket never sees another member's frames", async () => {
    seed([file("q1", "ann", { trashed_at: now, purge_after: now + 86_400_000 })]);
    const mine = await Socket.open(wrangler.url, "/api/library/ws", wrangler.url, { Cookie: JAR("ann") });
    const theirs = await Socket.open(wrangler.url, "/api/library/ws", wrangler.url, { Cookie: JAR("bob") });
    await Promise.all([mine.waitFor((f) => f.t === "hello"), theirs.waitFor((f) => f.t === "hello")]);
    await call("ann", "POST", "/api/library/trash/delete", { all: true });
    await mine.waitFor((f) => f.t === "quota", 15_000);
    expect(theirs.frames.map((f) => f.t)).toEqual(["hello"]);
    mine.close();
    theirs.close();
  });
});

describe("the socket cap", () => {
  it("LIB-11 hibernate: a seventh socket replaces the oldest with 4000, and the other six stay open", async () => {
    const opened: Socket[] = [];
    for (let i = 0; i < 7; i++) {
      opened.push(
        await Socket.open(wrangler.url, "/api/library/ws", wrangler.url, {
          Cookie: JAR("ann"),
        }),
      );
      await opened[i]?.waitFor((f) => f.t === "hello");
    }
    for (let i = 0; i < 150 && opened[0]?.closed === null; i++) await new Promise((r) => setTimeout(r, 100));
    expect(opened[0]?.closed?.code).toBe(4000);
    expect(opened.slice(1).map((s) => s.closed)).toEqual(Array(6).fill(null));
    for (const s of opened) s.close();
  });
});

describe("live screens", () => {
  it("lists nothing for a member with no screen, and needs a member", async () => {
    const res = await call("ann", "GET", "/api/me/screens");
    expect([res.status, res.body.screens]).toEqual([200, []]);
    expect((await call(null, "GET", "/api/me/screens")).status).toBe(401);
  });

  it("ends by session id, and a doubled or foreign id lands the same: nothing ended", async () => {
    const first = await call("ann", "DELETE", "/api/me/screens/s-unknown", {});
    const again = await call("ann", "DELETE", "/api/me/screens/s-unknown", {});
    expect([first.status, first.body.ended, again.status, again.body.ended]).toEqual([200, 0, 200, 0]);
    expect((await call(null, "DELETE", "/api/me/screens/s-unknown", {})).status).toBe(401);
    const cross = await call("ann", "DELETE", "/api/me/screens/s-unknown", {}, { Origin: "https://evil.example" });
    expect([cross.status, cross.body.code]).toEqual([403, "forbidden_origin"]);
  });
});

describe("previews", () => {
  it("LIB-04 hmac: mints a token the verifier accepts, for this file and version only", async () => {
    const res = await call("ann", "POST", "/api/library/a1/preview", {
      asset: "original",
    });
    expect(res.status).toBe(200);
    const base = String(res.body.base);
    expect(base.startsWith(`${wrangler.url}/p/p1.`)).toBe(true);
    const claims = await verifyPreview([FILE_TOKEN_KEY], base.split("/p/")[1] ?? "", Date.now());
    expect(claims).toMatchObject({ f: "a1", v: 1, a: "original" });
    expect(Number(res.body.exp) - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it("answers file_disabled for a disabled file and not_found for a trashed one", async () => {
    seed([
      file("d1", "ann", { disabled_at: now }),
      file("tr", "ann", { trashed_at: now, purge_after: now + 86_400_000 }),
    ]);
    expect(
      (
        await call("ann", "POST", "/api/library/d1/preview", {
          asset: "bundle",
        })
      ).body.code,
    ).toBe("file_disabled");
    expect(
      (
        await call("ann", "POST", "/api/library/tr/preview", {
          asset: "bundle",
        })
      ).status,
    ).toBe(404);
  });

  it("LIB-03 pinned: a signed-out session cannot mint", async () => {
    seed([`DELETE FROM phone_session WHERE public_id = 'pub-bob'`]);
    expect(
      (
        await call("bob", "POST", "/api/library/b1/preview", {
          asset: "bundle",
        })
      ).status,
    ).toBe(401);
  });
});

describe("the page", () => {
  it("serves /library to a member, privately, under the library policy, with its script and stylesheet", async () => {
    const res = await call("ann", "GET", "/library", undefined, { Accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
    expect(res.text).toContain('<script type="module" src="/js/library.js">');
    expect(res.text).toContain('href="/css/library.css"');
  });

  it("answers a signed-out request with the 404 any unknown path gets", async () => {
    const res = await call(null, "GET", "/library", undefined, { Accept: "text/html" });
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("library.js");
  });
});
