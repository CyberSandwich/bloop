import { describe, expect, it } from "vitest";
import { Sessions } from "../../src/worker/auth/sessions.ts";
import { normalizePath, type PageEnv, servePage, type Variant } from "../../src/worker/pages.ts";
import { PROD_VARS } from "../env-vars.ts";
import { type TestDb, testDb } from "./d1-shim.ts";

const NOW = 1_800_000_000_000;

/** Every path the fake asset layer knows answers 200 with its own path; anything else is its 404 page. */
function world(over: Record<string, string> = {}) {
  const db = testDb();
  const env = {
    ...PROD_VARS,
    PUBLIC_ORIGIN: "http://localhost:8787",
    TEST_TIMING: "1",
    ADMIN_EMAILS: "Admin@Example.test",
    TEST_EMAILS: "test@example.test",
    ...over,
    DB: db,
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        return path === "/.missing" ? new Response("not found", { status: 404 }) : new Response(`asset ${path}`);
      },
    },
  } as unknown as PageEnv;
  return { db, env };
}

const setting = (db: TestDb, key: string, value: string) =>
  db.raw.prepare("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, NOW);
const setMode = (db: TestDb, mode: "preview" | "open", lockout = false) => {
  setting(db, "launch_mode", mode);
  if (lockout) setting(db, "preview_lockout", "1");
  else db.raw.prepare("DELETE FROM setting WHERE key = 'preview_lockout'").run();
};

/** A user and a live session cookie for them. `tid` email makes a member; anything else is an Entra user. */
async function signIn(db: TestDb, id: string, emailNorm: string | null) {
  db.raw
    .prepare(
      "INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, emailNorm ? "email" : "tenant-a", id, emailNorm, emailNorm, Date.now(), Date.now());
  return new Sessions(db).create(id, null);
}

const get = (env: PageEnv, path: string, cookie?: string) =>
  servePage(
    new Request(`http://localhost:8787${path}`, { headers: cookie ? { Cookie: `__Host-bloop_sid=${cookie}` } : {} }),
    env,
  );

const FORMS = [
  "/open/",
  "/open",
  "/Open/",
  "/OPEN/x",
  "/%6Fpen/",
  "//open/",
  "/./open/",
  "/%2Fopen/",
  "/%5Copen/",
  "/a/../open/",
];

describe("MODE-01 pages: /open is 404 in both modes", () => {
  for (const [mode, lockout] of [
    ["preview", false],
    ["preview", true],
    ["open", false],
  ] as const) {
    it(`MODE-01 pages: every form of /open answers 404 in ${mode}${lockout ? " with the lockout" : ""}`, async () => {
      const { db, env } = world();
      setMode(db, mode, lockout);
      for (const form of FORMS) {
        const res = await get(env, form);
        expect(res.status, form).toBe(404);
        expect(await res.text(), form).toBe("not found");
      }
    });
  }

  it("MODE-01 pages: a path that only starts with the letters is an ordinary path", async () => {
    const { env } = world();
    expect((await get(env, "/opening")).status).toBe(200);
  });

  it("MODE-01 pages: the normalizer decodes once, collapses slashes and refuses what is still encoded", () => {
    expect(normalizePath("/a//b/./c")).toBe("/a/b/c");
    expect(normalizePath("/x/%2e%2e/y")).toBe("/y");
    expect(normalizePath("/%256Fpen")).toBeNull();
    expect(normalizePath("/%E0%A4%A")).toBeNull();
    expect(normalizePath("/a\\b")).toBeNull();
    expect(normalizePath("/")).toBe("/");
  });
});

describe("MODE-01 pages: the account pages by mode", () => {
  it("MODE-01 pages: /report is public in both modes", async () => {
    const { db, env } = world();
    for (const mode of ["preview", "open"] as const) {
      setMode(db, mode);
      expect((await get(env, "/report")).status).toBe(200);
    }
  });

  it("MODE-01 pages: /signin and /invite are served in both modes, noindex only in preview", async () => {
    const { db, env } = world();
    for (const path of ["/signin", "/invite", "/signin/"]) {
      setMode(db, "preview");
      const preview = await get(env, path);
      expect(preview.status).toBe(200);
      expect(preview.headers.get("X-Robots-Tag")).toBe("noindex");
      setMode(db, "open");
      const open = await get(env, path);
      expect(open.status).toBe(200);
      expect(open.headers.get("X-Robots-Tag")).toBeNull();
    }
  });

  it("MODE-01 pages: in preview a signed-out request for /library, /account and /admin is the same 404 as any unknown path", async () => {
    const { db, env } = world();
    setMode(db, "preview");
    for (const path of ["/library", "/account", "/admin", "/admin/"]) {
      const res = await get(env, path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("not found");
    }
    expect(await get(env, "/library", "A".repeat(43))).toHaveProperty("status", 404);
  });

  it("MODE-01 pages: every file and letter-case form of a member page is hidden too, signed out, in preview", async () => {
    const { db, env } = world();
    setMode(db, "preview");
    for (const base of ["/library", "/account", "/admin"]) {
      for (const form of [`${base}.html`, base.toUpperCase(), `${base}/`, `${base}/index.html`, `${base}.HTML`]) {
        expect((await get(env, form)).status, form).toBe(404);
      }
    }
  });

  it("MODE-01 pages: in open a signed-out request reaches the page, which shows the sign-in form", async () => {
    const { db, env } = world();
    setMode(db, "open");
    for (const path of ["/library", "/account", "/admin"]) expect((await get(env, path)).status).toBe(200);
  });

  it("MODE-01 pages: in preview a signed-in member sees /library and /account, privately, and only an admin sees /admin", async () => {
    const { db, env } = world();
    setMode(db, "preview");
    const cookie = await signIn(db, "m1", "member@example.test");
    const admin = await signIn(db, "m2", "admin@example.test");
    for (const path of ["/library", "/account"]) {
      const res = await get(env, path, cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Vary")).toContain("Cookie");
    }
    expect((await get(env, "/admin", cookie)).status).toBe(404);
    expect((await get(env, "/admin", admin)).status).toBe(200);
  });

  it("MODE-01 pages: with the lockout a member outside ADMIN_EMAILS and TEST_EMAILS gets 404, the admin and a test address do not", async () => {
    const { db, env } = world();
    setMode(db, "preview", true);
    const outside = await signIn(db, "m1", "member@example.test");
    const admin = await signIn(db, "m2", "admin@example.test");
    const test = await signIn(db, "m3", "test@example.test");
    const entra = await signIn(db, "e1", null);
    expect((await get(env, "/library", outside)).status).toBe(404);
    expect((await get(env, "/library", admin)).status).toBe(200);
    expect((await get(env, "/account", test)).status).toBe(200);
    expect((await get(env, "/admin", test)).status).toBe(404);
    expect((await get(env, "/library", entra)).status).toBe(404);
    // Open ignores and clears the lockout, so the member is back.
    setMode(db, "open");
    expect((await get(env, "/library", outside)).status).toBe(200);
  });

  it("MODE-01 pages: a deleting or suspended member sees the member pages as a signed-out visitor does", async () => {
    const { db, env } = world();
    setMode(db, "preview");
    const deleting = await signIn(db, "d1", "deleting@example.test");
    const suspended = await signIn(db, "s1", "suspended@example.test");
    db.raw.prepare("UPDATE app_user SET status = 'deleting' WHERE id = 'd1'").run();
    db.raw.prepare("UPDATE app_user SET suspended_at = 1 WHERE id = 's1'").run();
    expect((await get(env, "/library", deleting)).status).toBe(404);
    expect((await get(env, "/library", suspended)).status).toBe(404);
  });

  it("MODE-01 pages: an invalid configuration hides the member pages instead of showing them", async () => {
    const { db, env } = world({ HASH_PEPPER: "short" });
    setMode(db, "preview");
    expect((await get(env, "/library")).status).toBe(404);
  });
});

describe("MODE-01 pages: variants", () => {
  const variants: Variant[] = [
    { path: "/privacy", kind: "both" },
    { path: "/articles/features", kind: "open-only" },
    { path: "/features", kind: "preview-only", to: "/articles/features" },
  ];

  it("MODE-01 pages: a both-page serves today's file in preview and the /open/ file in open", async () => {
    const { db, env } = world();
    setMode(db, "preview");
    expect(await (await servePage(new Request("http://localhost:8787/privacy"), env, variants)).text()).toBe(
      "asset /privacy",
    );
    setMode(db, "open");
    expect(await (await servePage(new Request("http://localhost:8787/privacy?x=1"), env, variants)).text()).toBe(
      "asset /open/privacy",
    );
  });

  it("MODE-01 pages: an open-only page is 404 in preview; a preview-only page is a 301 to its article in open", async () => {
    const { db, env } = world();
    setMode(db, "preview");
    expect((await servePage(new Request("http://localhost:8787/articles/features"), env, variants)).status).toBe(404);
    expect((await servePage(new Request("http://localhost:8787/features"), env, variants)).status).toBe(200);
    setMode(db, "open");
    expect((await servePage(new Request("http://localhost:8787/articles/features"), env, variants)).status).toBe(200);
    const moved = await servePage(new Request("http://localhost:8787/features"), env, variants);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("Location")).toBe("/articles/features");
  });

  it("MODE-01 pages: a gated page listed as a variant is still gated, and an open variant gets its page policy", async () => {
    const { db, env } = world();
    setMode(db, "preview");
    const listed: Variant[] = [{ path: "/library", kind: "both" }];
    const res = await servePage(new Request("http://localhost:8787/library"), env, listed);
    expect(res.status).toBe(404);
  });

  it("MODE-01 pages: with no variants and no gated path the mode is never read", async () => {
    const { env } = world();
    (env as unknown as { DB: unknown }).DB = {
      prepare() {
        throw new Error("read");
      },
    };
    expect((await get(env, "/privacy")).status).toBe(200);
  });
});
