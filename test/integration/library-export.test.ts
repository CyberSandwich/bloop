// The export download against a real wrangler dev: the library bucket holds real objects, the archive is read by
// python's zipfile, and the lease, the proof and the resume rules are the Worker's own.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crc32 } from "../../src/worker/crc32.ts";
import { startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const FILE_TOKEN_KEY = "k".repeat(40);
let wrangler: Wrangler;
const now = Date.now();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const jar = (name: string) => `__Host-bloop_sid=${name}-cookie-value`;
const SAME = { "Sec-Fetch-Site": "same-origin" };
const url = (k: string) => `${wrangler.url}/api/me/export.zip?k=${k}`;

function member(name: string, reauthAt: number | "NULL" = now): string[] {
  return [
    `INSERT INTO app_user (id, tid, oid, email, created_at, last_seen_at, email_norm, status)
       VALUES ('${name}', 'email', '${name}', '${name}@example.test', ${now}, ${now}, '${name}@example.test', 'active')`,
    `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id, reauth_at, label, method)
       VALUES ('${sha(`${name}-cookie-value`)}', '${name}', ${now}, ${now}, ${now + 86_400_000}, 'pub-${name}', ${reauthAt}, 'Safari', 'code')`,
  ];
}

/** A settled file whose bytes are really in the bucket. */
function put(
  id: string,
  user: string,
  name: string,
  over: Record<string, string | number> = {},
  content = `content of ${id}`,
): string {
  wrangler.r2Put("bloop-library", `u/${user}/${id}/v1/orig`, content);
  const row: Record<string, string | number> = {
    id,
    user_id: user,
    name,
    ext: "pptx",
    bytes: content.length,
    version: 1,
    r2_key: `u/${user}/${id}/v1/orig`,
    status: "ready",
    created_at: now,
    updated_at: now,
    crc32: crc32(new TextEncoder().encode(content)),
    ...over,
  };
  const values = Object.values(row).map((v) => (typeof v === "string" ? `'${v}'` : v));
  return `INSERT INTO library_file (${Object.keys(row).join(", ")}) VALUES (${values.join(", ")})`;
}

async function download(who: string | null, k: string, headers: Record<string, string> = {}) {
  const res = await fetch(url(k), { headers: { ...(who ? { Cookie: jar(who) } : {}), ...SAME, ...headers } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    res,
    bytes,
    code: res.headers.get("content-type")?.includes("json")
      ? (JSON.parse(new TextDecoder().decode(bytes)) as { code: string }).code
      : null,
  };
}

function listZip(bytes: Uint8Array): { test: string; names: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  try {
    const path = join(dir, "a.zip");
    writeFileSync(path, bytes);
    const out = spawnSync("python3", [
      "-I",
      "-c",
      "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print('|'.join(z.namelist()))",
      path,
    ]);
    const [test, names] = out.stdout.toString().trim().split("\n");
    return { test: test ?? "", names: (names ?? "").split("|") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  wrangler = await startPairing({ FILE_TOKEN_KEY }, { migrate: true });
  wrangler.d1(
    [
      ...member("eve"),
      ...member("fay"),
      ...member("gil", "NULL"),
      ...member("hal"),
      put("h1", "hal", "Big.pptx", {}, "x".repeat(40_000_000)),
      put("e1", "eve", "Lecture.pptx"),
      put("e2", "eve", "Old.pptx", { trashed_at: now, purge_after: now + 86_400_000 }),
      put("f1", "fay", "Secret.pptx"),
    ].join("; "),
  );
}, 180_000);
afterAll(async () => {
  await wrangler?.stop();
});
// The proof lasts minutes and seeding the bucket is slow, so each test starts with a fresh one.
beforeEach(() => {
  wrangler.d1(`UPDATE phone_session SET reauth_at = ${Date.now()} WHERE user_id IN ('eve', 'fay', 'hal')`);
});

describe("LIB-10 export abuse", () => {
  it("refuses a cross-site, a missing-header and a keyless navigation", async () => {
    const cross = await download("eve", "key-aaaaaaaa", { "Sec-Fetch-Site": "cross-site" });
    expect([cross.res.status, cross.code]).toEqual([403, "forbidden_origin"]);
    const bare = await fetch(url("key-aaaaaaaa"), { headers: { Cookie: jar("eve") } });
    expect(bare.status).toBe(403);
    expect((await download("eve", "x")).code).toBe("bad_request");
    expect(
      (await fetch(`${wrangler.url}/api/me/export.zip`, { headers: { Cookie: jar("eve"), ...SAME } })).status,
    ).toBe(400);
  });

  it("needs a session, and a fresh proof for a new export", async () => {
    expect((await download(null, "key-bbbbbbbb")).res.status).toBe(401);
    const stale = await download("gil", "key-bbbbbbbb");
    expect([stale.res.status, stale.code]).toEqual([401, "reauth_required"]);
  });

  it("a second export while one streams is export_busy, and so is a retry with the same key", async () => {
    // 40 MB does not fit the socket buffers, so the stream is still open while the client reads one chunk.
    const first = await fetch(url("key-cccccccc"), { headers: { Cookie: jar("hal"), ...SAME } });
    expect(first.status).toBe(200);
    const reader = (first.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const other = await download("hal", "key-dddddddd");
    expect([other.res.status, other.code]).toEqual([409, "export_busy"]);
    const replay = await download("hal", "key-cccccccc");
    expect([replay.res.status, replay.code]).toEqual([409, "export_busy"]);
    await reader.cancel();
  });
});

describe("LIB-07 export", () => {
  it("is a readable zip of this user's files, trash and data.json, with an exact Content-Length, and is audited", async () => {
    const got = await download("eve", "key-ffffffff");
    expect(got.res.status).toBe(200);
    expect(got.res.headers.get("content-type")).toBe("application/zip");
    expect(got.res.headers.get("cache-control")).toBe("no-store");
    expect(got.res.headers.get("accept-ranges")).toBe("bytes");
    expect(got.res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="bloop-export-\d{4}-\d\d-\d\d\.zip"; filename\*=UTF-8''/,
    );
    expect(Number(got.res.headers.get("content-length"))).toBe(got.bytes.length);
    expect(got.res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    const listed = listZip(got.bytes);
    expect(listed.test).toBe("None");
    expect(listed.names).toEqual(["README.txt", "Files/Lecture.pptx", "Trash/Old.pptx", "data.json"]);
    expect(new TextDecoder().decode(got.bytes)).not.toContain("Secret");
    const rows = wrangler.d1(
      "SELECT type, session_id FROM audit_event WHERE type = 'library.export' AND session_id = 'user:eve'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("LIB-07 deterministic: an unchanged library exports to the same bytes and ETag, run after run", async () => {
    const a = await download("eve", "key-gggggggg");
    const b = await download("eve", "key-hhhhhhhh");
    expect(b.bytes).toEqual(a.bytes);
    expect(b.res.headers.get("etag")).toBe(a.res.headers.get("etag"));
  });

  it("LIB-07 deterministic: a resume needs only the session and answers the rest, 206 with Content-Range", async () => {
    const whole = await download("eve", "key-iiiiiiii");
    const etag = whole.res.headers.get("etag") as string;
    wrangler.d1("UPDATE phone_session SET reauth_at = NULL WHERE user_id = 'eve'");
    try {
      const part = await download("eve", "key-jjjjjjjj", { Range: "bytes=100-", "If-Range": etag });
      expect(part.res.status).toBe(206);
      expect(part.res.headers.get("content-range")).toBe(`bytes 100-${whole.bytes.length - 1}/${whole.bytes.length}`);
      expect(part.bytes).toEqual(whole.bytes.subarray(100));
      const middle = await download("eve", "key-kkkkkkkk", { Range: "bytes=10-59", "If-Range": etag });
      expect([middle.res.status, middle.bytes.length]).toEqual([206, 50]);
      expect(middle.bytes).toEqual(whole.bytes.subarray(10, 60));
      const fresh = await download("eve", "key-llllllll");
      expect([fresh.res.status, fresh.code]).toEqual([401, "reauth_required"]);
      const stale = await download("eve", "key-mmmmmmmm", {
        Range: "bytes=100-",
        "If-Range": '"00000000000000000000000000000000"',
      });
      expect([stale.res.status, stale.code]).toEqual([401, "reauth_required"]);
      const beyond = await download("eve", "key-nnnnnnnn", {
        Range: `bytes=${whole.bytes.length + 5}-`,
        "If-Range": etag,
      });
      expect(beyond.res.status).toBe(416);
    } finally {
      wrangler.d1(`UPDATE phone_session SET reauth_at = ${Date.now()} WHERE user_id = 'eve'`);
    }
  });

  it("a stale If-Range with a fresh proof answers the whole archive, 200", async () => {
    const got = await download("eve", "key-oooooooo", {
      Range: "bytes=100-",
      "If-Range": '"00000000000000000000000000000000"',
    });
    expect(got.res.status).toBe(200);
    expect(got.res.headers.get("content-range")).toBeNull();
    expect(listZip(got.bytes).test).toBe("None");
  });

  it("a changed library answers a resume with a whole new archive", async () => {
    const before = await download("fay", "key-pppppppp");
    wrangler.d1("UPDATE library_file SET name = 'Renamed.pptx', updated_at = updated_at + 5 WHERE id = 'f1'");
    const after = await download("fay", "key-qqqqqqqq", {
      Range: "bytes=50-",
      "If-Range": before.res.headers.get("etag") as string,
    });
    expect(after.res.status).toBe(200);
    expect(listZip(after.bytes).names).toContain("Files/Renamed.pptx");
  });

  it("a missing object fails the download visibly instead of writing a short archive", async () => {
    wrangler.d1(
      `INSERT INTO library_file (id, user_id, name, ext, bytes, version, r2_key, status, created_at, updated_at, crc32)
       VALUES ('ghost', 'fay', 'Ghost.pptx', 'pptx', 10, 1, 'u/fay/ghost/v1/orig', 'ready', ${now}, ${now}, 5)`,
    );
    const res = await fetch(url("key-rrrrrrrr"), { headers: { Cookie: jar("fay"), ...SAME } });
    await expect(res.arrayBuffer()).rejects.toThrow();
    wrangler.d1("DELETE FROM library_file WHERE id = 'ghost'");
    await new Promise((r) => setTimeout(r, 500));
    expect((await download("fay", "key-ssssssss")).res.status).toBe(200);
  });
});
