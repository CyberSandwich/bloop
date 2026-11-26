// Sign-in, sessions and cookies against a real wrangler dev with FILE_SOURCE=graph, with a local fake Entra
// (a node http server) standing in for the authorize and token endpoints.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, claim, openScreen, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const TID = "11111111-2222-3333-4444-555555555555";
/** 32 bytes as base64: a throwaway key for the KEK and the cookie seal. */
const THROWAWAY = Buffer.alloc(32, 7).toString("base64");
/** Stands in for the Entra client secret; the fake token endpoint checks it arrives. */
const APP_VALUE = `app-${"c".repeat(12)}`;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** What the fake token endpoint will return next, and what it was asked. */
const idp = {
  nonce: "",
  iss: "",
  oid: "oid-1",
  tokenRequests: [] as URLSearchParams[],
};

let entra: Server;
let authority: string;
let wrangler: Wrangler;
let api: Api;

beforeAll(async () => {
  entra = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      idp.tokenRequests.push(new URLSearchParams(body));
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: idp.iss,
        aud: "client-id-1",
        sub: "sub-1",
        tid: TID,
        oid: idp.oid,
        preferred_username: "someone@example.test",
        nonce: idp.nonce,
        iat: now,
        exp: now + 3600,
      };
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          token_type: "Bearer",
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: "openid Files.Read",
          id_token: `${b64({ alg: "RS256" })}.${b64(claims)}.c2ln`,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => entra.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(entra.address() as AddressInfo).port}`;
  authority = `${base}/organizations/v2.0`;
  idp.iss = `${base}/${TID}/v2.0`;
  wrangler = await startPairing(
    {
      FILE_SOURCE: "graph",
      ENTRA_AUTHORITY: authority,
      ENTRA_CLIENT_ID: "client-id-1",
      ENTRA_CLIENT_SECRET: APP_VALUE,
      TOKEN_KEKS: JSON.stringify({ k1: THROWAWAY }),
      COOKIE_KEY: THROWAWAY,
    },
    { migrate: true },
  );
  api = new Api(wrangler.url);
});
afterAll(async () => {
  await wrangler?.stop();
  entra?.close();
});

const problem = (code: string) => expect.objectContaining({ code });
const hit = (path: string, cookie?: string) =>
  fetch(`${wrangler.url}${path}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });

/** The `name=value` pairs of every Set-Cookie, for sending back. */
const jar = (res: Response): Record<string, string> =>
  Object.fromEntries(
    res.headers.getSetCookie().map((c) => {
      const pair = c.split(";")[0] as string;
      const eq = pair.indexOf("=");
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
const header = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
const sid = (value: string) => ({ Cookie: `__Host-bloop_sid=${value}` });

/** Starts a sign-in: the oauth cookie, and the state and nonce the authorize URL carries. */
async function start() {
  const res = await hit("/auth/start");
  const location = new URL(res.headers.get("Location") as string);
  const cookies = jar(res);
  return {
    res,
    location,
    oauth: cookies["__Host-bloop_oauth"] as string,
    state: location.searchParams.get("state") as string,
  };
}

/** A complete sign-in, optionally presenting an existing session. Returns the new session cookie value. */
async function signIn(presenting?: string) {
  const s = await start();
  idp.nonce = s.location.searchParams.get("nonce") as string;
  const cookie = header({ "__Host-bloop_oauth": s.oauth, ...(presenting ? { "__Host-bloop_sid": presenting } : {}) });
  const res = await hit(`/auth/callback?code=auth-code&state=${s.state}`, cookie);
  return { res, session: jar(res)["__Host-bloop_sid"] as string | undefined };
}

const me = async (session?: string) =>
  (await api.call("GET", "/api/me", undefined, session ? { headers: sid(session) } : {})).body;

describe("AUTH-06 scope and AUTH-05 cookie: /auth/start", () => {
  it("AUTH-06 scope: redirects to the authorize endpoint with exactly ENTRA_SCOPES, PKCE S256, state and nonce", async () => {
    const { res, location } = await start();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe(`${authority.replace("/v2.0", "")}/oauth2/v2.0/authorize`);
    expect(location.searchParams.get("scope")).toBe("openid offline_access Files.Read");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(`${wrangler.url}/auth/callback`);
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.has("client_secret")).toBe(false);
  });

  it("AUTH-05 cookie: the oauth cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes, no Domain, and sealed", async () => {
    const { res, oauth, state } = await start();
    const raw = res.headers.getSetCookie();
    expect(raw).toHaveLength(1);
    const [pair, ...attrs] = (raw[0] as string).split("; ");
    expect(pair).toMatch(/^__Host-bloop_oauth=[A-Za-z0-9_-]+$/);
    expect(attrs.sort()).toEqual(["HttpOnly", "Max-Age=600", "Path=/", "SameSite=Lax", "Secure"]);
    // AEAD: neither the state nor the PKCE verifier is readable from the cookie.
    expect(Buffer.from(oauth, "base64url").toString("latin1")).not.toContain(state);
  });
});

/** A callback failure is a page for a person, never raw problem+json. */
async function expectPage(res: Response, heading: string) {
  expect(res.headers.get("Content-Type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain(`<h1>${heading}</h1>`);
  expect(html).not.toContain("about:blank");
}

describe("AUTH-03 state: /auth/callback", () => {
  it("AUTH-03 state: no oauth cookie gives 400 and sets no cookie", async () => {
    const res = await hit("/auth/callback?code=x&state=y");
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
    await expectPage(res, "Couldn't sign you in.");
  });

  it("AUTH-03 state: a wrong state gives 400, sets no cookie and never reaches the token endpoint", async () => {
    const s = await start();
    const before = idp.tokenRequests.length;
    const res = await hit("/auth/callback?code=x&state=attacker", header({ "__Host-bloop_oauth": s.oauth }));
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(idp.tokenRequests).toHaveLength(before);
  });

  it("AUTH-03 state: a missing state and a tampered cookie both give 400", async () => {
    const s = await start();
    expect((await hit("/auth/callback?code=x", header({ "__Host-bloop_oauth": s.oauth }))).status).toBe(400);
    const tampered = `${s.oauth.slice(0, -2)}${s.oauth.endsWith("AA") ? "BB" : "AA"}`;
    const res = await hit(`/auth/callback?code=x&state=${s.state}`, header({ "__Host-bloop_oauth": tampered }));
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("an Entra refusal is mapped to the phone's own errors", async () => {
    const s = await start();
    const cookie = header({ "__Host-bloop_oauth": s.oauth });
    const declined = await hit(
      `/auth/callback?state=${s.state}&error=access_denied&error_description=AADSTS65004`,
      cookie,
    );
    expect(declined.status).toBe(403);
    await expectPage(declined, "bloop wasn't given access.");
    const admin = await hit(
      `/auth/callback?state=${s.state}&error=access_denied&error_description=AADSTS90094`,
      cookie,
    );
    expect(admin.status).toBe(403);
    await expectPage(admin, "Your organization needs to approve bloop.");
    expect(declined.headers.getSetCookie()).toEqual([]);
  });

  it("AUTH-04 iss: a token whose issuer does not match its tenant gives 401 and no session", async () => {
    const good = idp.iss;
    idp.iss = "https://evil.example/not-the-tenant/v2.0";
    try {
      const { res, session } = await signIn();
      expect(res.status).toBe(401);
      expect(session).toBeUndefined();
    } finally {
      idp.iss = good;
    }
  });
});

/** Audit rows are written best effort by the callback, so a test waits for the row to show. */
async function auditTypes(session: string): Promise<string[]> {
  let types: string[] = [];
  for (let i = 0; i < 40; i++) {
    const res = await api.call<{ rows: { type: string }[] }>("GET", "/api/me/audit", undefined, {
      headers: sid(session),
    });
    types = res.body.rows?.map((r) => r.type) ?? [];
    if (types.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return types;
}

describe("F12 DATA-05 dsar: /api/me/audit and DELETE /api/me", () => {
  it("DATA-05 dsar: a signed-in user reads their own rows newest first, with the grant row, and a stranger gets 401", async () => {
    idp.oid = "oid-audit";
    const { session } = await signIn();
    expect(await auditTypes(session as string)).toContain("grant.created");
    const res = await api.call<{ rows: Record<string, unknown>[]; nextId: number | null }>(
      "GET",
      "/api/me/audit?limit=1",
      undefined,
      { headers: sid(session as string) },
    );
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ type: "grant.created", actor: "phone", user: null });
    expect(JSON.stringify(res.body)).not.toMatch(/at-1|rt-1/);
    expect((await api.call("GET", "/api/me/audit")).body).toEqual(problem("auth_required"));
    expect(
      (await api.call("GET", "/api/me/audit?limit=0", undefined, { headers: sid(session as string) })).status,
    ).toBe(400);
  });

  it("DATA-05 dsar: another user's session sees none of those rows", async () => {
    idp.oid = "oid-first";
    const first = (await signIn()).session as string;
    await auditTypes(first);
    idp.oid = "oid-second";
    const second = (await signIn()).session as string;
    const mine = await api.call<{ rows: { session: string }[] }>("GET", "/api/me/audit", undefined, {
      headers: sid(second),
    });
    const firstRows = await api.call<{ rows: { session: string }[] }>("GET", "/api/me/audit", undefined, {
      headers: sid(first),
    });
    const theirs = new Set(firstRows.body.rows.map((r) => r.session));
    expect(mine.body.rows.some((r) => theirs.has(r.session))).toBe(false);
  });

  it("AUTH-07 disconnect: disconnect writes a grant.deleted row", async () => {
    idp.oid = "oid-disconnect";
    const { session } = await signIn();
    await auditTypes(session as string);
    const before = (
      await api.call<{ rows: { type: string }[] }>("GET", "/api/me/audit", undefined, {
        headers: sid(session as string),
      })
    ).body;
    expect(before.rows.map((r) => r.type)).not.toContain("grant.deleted");
    expect((await api.post("/api/me/disconnect", {}, { headers: sid(session as string) })).status).toBe(200);
    let rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      rows = wrangler.d1("SELECT session_id FROM audit_event WHERE type = 'grant.deleted'");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it("DATA-05 dsar: DELETE /api/me erases the user, records user.erased with no link back, and ends every session", async () => {
    idp.oid = "oid-erase";
    const a = (await signIn()).session as string;
    const b = (await signIn()).session as string;
    await auditTypes(a);
    const users = () => Number(wrangler.d1("SELECT count(*) AS n FROM app_user WHERE oid = 'oid-erase'")[0]?.n);
    expect(users()).toBe(1);
    const userId = wrangler.d1("SELECT id FROM app_user WHERE oid = 'oid-erase'")[0]?.id as string;
    expect(wrangler.d1(`SELECT count(*) AS n FROM audit_event WHERE session_id = 'user:${userId}'`)[0]?.n).toBe(1);

    const res = await api.call("DELETE", "/api/me", {}, { headers: sid(a) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("__Host-bloop_sid=; Max-Age=0");
    expect(users()).toBe(0);
    expect((await me(a)).signedIn).toBe(false);
    expect((await me(b)).signedIn).toBe(false);
    expect(wrangler.d1(`SELECT count(*) AS n FROM token_grant WHERE user_id = '${userId}'`)[0]?.n).toBe(0);

    const erased = wrangler.d1("SELECT session_id, actor FROM audit_event WHERE type = 'user.erased'");
    expect(erased).toEqual([{ session_id: "erased", actor: "phone" }]);
    expect(wrangler.d1(`SELECT count(*) AS n FROM audit_event WHERE session_id = 'user:${userId}'`)[0]?.n).toBe(0);
  });

  it("PAIR-06 write checks: DELETE /api/me needs the Origin, a JSON body and a session", async () => {
    idp.oid = "oid-checks";
    const { session } = await signIn();
    const cookie = sid(session as string);
    expect((await api.call("DELETE", "/api/me", {}, { headers: cookie, origin: "https://evil.example" })).body).toEqual(
      problem("forbidden_origin"),
    );
    expect((await api.call("DELETE", "/api/me", {}, { headers: cookie, origin: null })).body).toEqual(
      problem("forbidden_origin"),
    );
    expect((await api.call("DELETE", "/api/me", {})).body).toEqual(problem("auth_required"));
    expect((await me(session)).signedIn).toBe(true);
  });
});

describe("sign-in, sessions and revocation", () => {
  it("AUTH-05 cookie: a good callback sets one session cookie with the documented attributes and clears the oauth cookie", async () => {
    idp.tokenRequests.length = 0;
    const { res, session } = await signIn();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/a");
    const raw = res.headers.getSetCookie();
    expect(raw).toHaveLength(2);
    const [pair, ...attrs] = (raw.find((c) => c.startsWith("__Host-bloop_sid=")) as string).split("; ");
    expect(pair).toMatch(/^__Host-bloop_sid=[A-Za-z0-9_-]{43}$/);
    expect(attrs.sort()).toEqual(["HttpOnly", `Max-Age=${90 * 86400}`, "Path=/", "SameSite=Lax", "Secure"]);
    expect(raw.some((c) => c.startsWith("__Host-bloop_oauth=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(session).toHaveLength(43);

    const request = idp.tokenRequests.at(-1);
    expect(request?.get("grant_type")).toBe("authorization_code");
    expect(request?.get("client_secret")).toBe(APP_VALUE);
    expect(request?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request?.get("redirect_uri")).toBe(`${wrangler.url}/auth/callback`);
  });

  it("the session identifies the user, and a live phone with it needs no sign-in while one without does", async () => {
    const { session } = await signIn();
    expect(await me(session)).toEqual({ source: "graph", signedIn: true, email: "someone@example.test" });
    expect(await me()).toEqual({ source: "graph", signedIn: false, launchMode: "preview" });

    const live = await openScreen(api, "live");
    const without = await claim(api, live.code);
    expect(without.body.needsAuth).toBe(true);
    live.socket.close();

    const second = await openScreen(api, "live");
    const withSession = await api.post<{ needsAuth: boolean }>(
      "/api/claim",
      { code: second.code },
      { headers: sid(session as string) },
    );
    expect(withSession.body.needsAuth).toBe(false);
    second.socket.close();
  });

  it("AUTH-01 flow: a live listing without a session is auth_required, and a demo screen never asks for one", async () => {
    const live = await openScreen(api, "live");
    const liveClaim = await claim(api, live.code);
    const unauth = await api.get("/api/files", liveClaim.body.pid);
    expect(unauth.status).toBe(401);
    expect(unauth.body).toEqual(problem("auth_required"));
    live.socket.close();

    const demo = await openScreen(api, "demo");
    const demoClaim = await claim(api, demo.code);
    expect(demoClaim.body.needsAuth).toBe(false);
    const files = await api.get<{ items: { id: string }[] }>("/api/files", demoClaim.body.pid);
    expect(files.status).toBe(200);
    expect(files.body.items.map((f) => f.id)).toContain("demo-deck");
    demo.socket.close();
  });

  it("SRC-04 isolation: a demo screen ignores a valid session cookie and still uses the demo account", async () => {
    const { session } = await signIn();
    const demo = await openScreen(api, "demo");
    const claimed = await api.post<{ pid: string; needsAuth: boolean }>(
      "/api/claim",
      { code: demo.code },
      { headers: sid(session as string) },
    );
    expect(claimed.body.needsAuth).toBe(false);
    const files = await api.call<{ items: { id: string }[] }>("GET", "/api/files", undefined, {
      auth: claimed.body.pid,
      headers: sid(session as string),
    });
    expect(files.body.items.map((f) => f.id)).toEqual(["demo-deck", "demo-pdf", "demo-dog", "demo-vevox"]);
    demo.socket.close();
  });

  it("AUTH-05 cookie: signing in again rotates the session and the presented one stops working", async () => {
    const first = (await signIn()).session as string;
    const second = (await signIn(first)).session as string;
    expect(second).not.toBe(first);
    expect((await me(first)).signedIn).toBe(false);
    expect((await me(second)).signedIn).toBe(true);
  });

  it("AUTH-05 cookie: a forged or malformed session value is simply signed out", async () => {
    expect((await me("A".repeat(43))).signedIn).toBe(false);
    expect((await me("not a session")).signedIn).toBe(false);
  });

  it("sign-out ends this session and clears the cookie; another sign-in is unaffected", async () => {
    const mine = (await signIn()).session as string;
    const other = (await signIn()).session as string;
    const res = await api.post("/api/me/signout", {}, { headers: sid(mine) });
    expect(res.status).toBe(200);
    // The sign-in hint goes with the session cookie; the device cookie stays (AUTH-09 device).
    expect(res.headers.getSetCookie()).toEqual([
      "__Host-bloop_sid=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
      "__Host-bloop_in=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
    expect((await me(mine)).signedIn).toBe(false);
    expect((await me(other)).signedIn).toBe(true);
  });

  it("AUTH-07 disconnect: disconnect deletes the grant and every session of the user", async () => {
    const a = (await signIn()).session as string;
    const b = (await signIn()).session as string;
    const res = await api.post("/api/me/disconnect", {}, { headers: sid(a) });
    expect(res.status).toBe(200);
    expect((await me(a)).signedIn).toBe(false);
    expect((await me(b)).signedIn).toBe(false);
  });

  it("PAIR-06 write checks: sign-out and disconnect need the Origin, a JSON body and a session", async () => {
    const { session } = await signIn();
    const cookie = sid(session as string);
    for (const path of ["/api/me/signout", "/api/me/disconnect"]) {
      const foreign = await api.post(path, {}, { headers: cookie, origin: "https://evil.example" });
      expect(foreign.body).toEqual(problem("forbidden_origin"));
      expect((await api.post(path, {}, { headers: cookie, origin: null })).body).toEqual(problem("forbidden_origin"));
      const form = await api.post(path, undefined, {
        headers: cookie,
        contentType: "application/x-www-form-urlencoded",
        raw: "a=b",
      });
      expect(form.status).toBe(415);
      expect((await api.post(path, {})).body).toEqual(problem("auth_required"));
    }
    expect((await me(session)).signedIn).toBe(true);
  });
});
