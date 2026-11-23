import { describe, expect, it } from "vitest";
import { beginSignIn, finishSignIn, issuerFor, type Pending, refresher } from "../../src/worker/auth/oauth.ts";
import type { GraphConfig } from "../../src/worker/config.ts";

const TID = "11111111-2222-3333-4444-555555555555";
const OTHER_TID = "99999999-8888-7777-6666-555555555555";
const ORIGIN = "https://bloop.example";
const REDIRECT = `${ORIGIN}/auth/callback`;
const NOW = 1_800_000_000_000;

const graph = (over: Partial<GraphConfig> = {}): GraphConfig => ({
  authority: "https://login.microsoftonline.com/organizations/v2.0",
  clientId: "client-id-1",
  clientSecret: "fake-client-secret",
  scopes: ["openid", "offline_access", "Files.Read"],
  keks: { keys: {}, current: "k1" },
  cookieKey: "",
  ...over,
});

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.c2ln`;

const goodClaims = (nonce: string, over: Record<string, unknown> = {}) => ({
  iss: `https://login.microsoftonline.com/${TID}/v2.0`,
  aud: "client-id-1",
  sub: "sub-1",
  tid: TID,
  oid: "oid-1",
  preferred_username: "someone@example.test",
  nonce,
  iat: NOW / 1000,
  exp: NOW / 1000 + 3600,
  ...over,
});

interface Seen {
  url: string;
  body: URLSearchParams;
}

/** A fake token endpoint. `reply` builds the JSON answer; every request is recorded. */
function fakeEntra(reply: (body: URLSearchParams) => { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    seen.push({ url: String(input), body });
    const { status = 200, json } = reply(body);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetcher, seen };
}

async function begin(g = graph()) {
  return beginSignIn(g, REDIRECT, "refresh", NOW);
}

const callback = (pending: Pending, extra: Record<string, string> = {}) =>
  new URL(`${REDIRECT}?${new URLSearchParams({ code: "auth-code", state: pending.state, ...extra })}`);

describe("AUTH-06 scope: the authorize request", () => {
  it("AUTH-06 scope: the authorize URL holds exactly ENTRA_SCOPES, PKCE S256, state and nonce", async () => {
    const { url, pending } = await begin();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    expect(u.searchParams.get("scope")).toBe("openid offline_access Files.Read");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("code_challenge")).not.toBe(pending.verifier);
    expect(u.searchParams.get("state")).toBe(pending.state);
    expect(u.searchParams.get("nonce")).toBe(pending.nonce);
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("client_id")).toBe("client-id-1");
    expect(u.searchParams.has("client_secret")).toBe(false);
  });

  it("AUTH-06 scope: session mode drops offline_access", async () => {
    const { url } = await beginSignIn(graph(), REDIRECT, "session", NOW);
    expect(new URL(url).searchParams.get("scope")).toBe("openid Files.Read");
  });

  it("AUTH-03 state: every sign-in draws a new state, nonce and verifier", async () => {
    const a = (await begin()).pending;
    const b = (await begin()).pending;
    expect(new Set([a.state, b.state, a.nonce, b.nonce, a.verifier, b.verifier]).size).toBe(6);
  });
});

describe("AUTH-03 state and AUTH-04 iss: the callback", () => {
  const happy = (pending: Pending) =>
    fakeEntra(() => ({
      json: {
        token_type: "Bearer",
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 7200,
        scope: "Files.Read openid",
        id_token: idToken(goodClaims(pending.nonce)),
      },
    }));

  it("redeems the code with the client secret and the PKCE verifier, and returns identity and tokens", async () => {
    const { pending } = await begin();
    const { fetcher, seen } = happy(pending);
    const res = await finishSignIn(graph(), callback(pending), pending, REDIRECT, { fetch: fetcher, now: () => NOW });
    expect(res).toEqual({
      ok: true,
      identity: { tid: TID, oid: "oid-1", email: "someone@example.test" },
      tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: NOW + 3_600_000, scope: "Files.Read openid" },
    });
    const body = seen[0]?.body;
    expect(seen[0]?.url).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
    expect(body?.get("grant_type")).toBe("authorization_code");
    expect(body?.get("client_secret")).toBe("fake-client-secret");
    expect(body?.get("code_verifier")).toBe(pending.verifier);
    expect(body?.get("code")).toBe("auth-code");
  });

  it("AUTH-03 state: a wrong state is refused before any token request", async () => {
    const { pending } = await begin();
    const { fetcher, seen } = happy(pending);
    const wrong = new URL(`${REDIRECT}?code=auth-code&state=attacker`);
    expect(await finishSignIn(graph(), wrong, pending, REDIRECT, { fetch: fetcher, now: () => NOW })).toEqual({
      ok: false,
      error: "state",
    });
    expect(seen).toHaveLength(0);
  });

  it("AUTH-03 state: a missing state is refused", async () => {
    const { pending } = await begin();
    const { fetcher, seen } = happy(pending);
    const none = new URL(`${REDIRECT}?code=auth-code`);
    expect(await finishSignIn(graph(), none, pending, REDIRECT, { fetch: fetcher, now: () => NOW })).toEqual({
      ok: false,
      error: "state",
    });
    expect(seen).toHaveLength(0);
  });

  it("AUTH-03 state: a pending sign-in older than 10 minutes is refused", async () => {
    const { pending } = await begin();
    const { fetcher } = happy(pending);
    const late = await finishSignIn(graph(), callback(pending), pending, REDIRECT, {
      fetch: fetcher,
      now: () => NOW + 601_000,
    });
    expect(late).toEqual({ ok: false, error: "state" });
  });

  it("AUTH-03 state: a wrong nonce in the ID token is refused", async () => {
    const { pending } = await begin();
    const { fetcher } = fakeEntra(() => ({
      json: { token_type: "Bearer", access_token: "a", id_token: idToken(goodClaims("other-nonce")), expires_in: 3600 },
    }));
    const res = await finishSignIn(graph(), callback(pending), pending, REDIRECT, { fetch: fetcher, now: () => NOW });
    expect(res.ok).toBe(false);
  });

  it("AUTH-04 iss: an issuer that does not name the token's own tid is refused", async () => {
    const { pending } = await begin();
    const { fetcher } = fakeEntra(() => ({
      json: {
        token_type: "Bearer",
        access_token: "a",
        expires_in: 3600,
        id_token: idToken(goodClaims(pending.nonce, { iss: `https://login.microsoftonline.com/${OTHER_TID}/v2.0` })),
      },
    }));
    const res = await finishSignIn(graph(), callback(pending), pending, REDIRECT, { fetch: fetcher, now: () => NOW });
    expect(res.ok).toBe(false);
  });

  it("AUTH-04 iss: an issuer on another host is refused", async () => {
    const { pending } = await begin();
    const { fetcher } = fakeEntra(() => ({
      json: {
        token_type: "Bearer",
        access_token: "a",
        expires_in: 3600,
        id_token: idToken(goodClaims(pending.nonce, { iss: `https://evil.example/${TID}/v2.0` })),
      },
    }));
    expect(
      (await finishSignIn(graph(), callback(pending), pending, REDIRECT, { fetch: fetcher, now: () => NOW })).ok,
    ).toBe(false);
  });

  it("AUTH-04 iss: a tid that is not a GUID is refused", async () => {
    const { pending } = await begin();
    const { fetcher } = fakeEntra(() => ({
      json: {
        token_type: "Bearer",
        access_token: "a",
        expires_in: 3600,
        id_token: idToken(
          goodClaims(pending.nonce, { tid: "../evil", iss: "https://login.microsoftonline.com/../evil/v2.0" }),
        ),
      },
    }));
    expect(
      await finishSignIn(graph(), callback(pending), pending, REDIRECT, { fetch: fetcher, now: () => NOW }),
    ).toEqual({
      ok: false,
      error: "issuer",
    });
  });

  it("AUTH-04 iss: a token without oid is refused (users are keyed by tid and oid, never by email)", async () => {
    const { pending } = await begin();
    const claims: Record<string, unknown> = goodClaims(pending.nonce);
    delete claims.oid;
    const { fetcher } = fakeEntra(() => ({
      json: { token_type: "Bearer", access_token: "a", expires_in: 3600, id_token: idToken(claims) },
    }));
    expect(
      await finishSignIn(graph(), callback(pending), pending, REDIRECT, { fetch: fetcher, now: () => NOW }),
    ).toEqual({
      ok: false,
      error: "issuer",
    });
  });

  it("AUTH-04 iss: a single-tenant authority accepts only its own tenant", async () => {
    const single = graph({ authority: `https://login.microsoftonline.com/${TID}/v2.0` });
    const { pending } = await begin(single);
    const other = fakeEntra(() => ({
      json: {
        token_type: "Bearer",
        access_token: "a",
        expires_in: 3600,
        id_token: idToken(
          goodClaims(pending.nonce, { tid: OTHER_TID, iss: `https://login.microsoftonline.com/${OTHER_TID}/v2.0` }),
        ),
      },
    }));
    expect(
      (await finishSignIn(single, callback(pending), pending, REDIRECT, { fetch: other.fetcher, now: () => NOW })).ok,
    ).toBe(false);
    const own = happy(pending);
    expect(
      (await finishSignIn(single, callback(pending), pending, REDIRECT, { fetch: own.fetcher, now: () => NOW })).ok,
    ).toBe(true);
  });

  it("AUTH-04 iss: issuerFor substitutes the tenant and refuses a tid outside a fixed tenant", () => {
    const multi = "https://login.microsoftonline.com/organizations/v2.0";
    expect(issuerFor(multi, TID)).toBe(`https://login.microsoftonline.com/${TID}/v2.0`);
    expect(() => issuerFor(multi, "not-a-guid")).toThrow();
    expect(() => issuerFor(`https://login.microsoftonline.com/${TID}/v2.0`, OTHER_TID)).toThrow();
  });

  it("an Entra refusal maps to consent_declined or admin_consent_required", async () => {
    const { pending } = await begin();
    const { fetcher } = fakeEntra(() => ({ json: {} }));
    const declined = callback(pending, { error: "access_denied", error_description: "AADSTS65004: The user declined" });
    const admin = callback(pending, {
      error: "access_denied",
      error_description: "AADSTS90094: Admin consent required",
    });
    const deps = { fetch: fetcher, now: () => NOW };
    expect(await finishSignIn(graph(), declined, pending, REDIRECT, deps)).toEqual({
      ok: false,
      error: "consent_declined",
    });
    expect(await finishSignIn(graph(), admin, pending, REDIRECT, deps)).toEqual({
      ok: false,
      error: "admin_consent_required",
    });
  });

  it("a response iss parameter from Entra does not break the check", async () => {
    const { pending } = await begin();
    const { fetcher } = happy(pending);
    const res = await finishSignIn(
      graph(),
      callback(pending, { iss: `https://login.microsoftonline.com/${TID}/v2.0` }),
      pending,
      REDIRECT,
      {
        fetch: fetcher,
        now: () => NOW,
      },
    );
    expect(res.ok).toBe(true);
  });

  it("caps the cached access token at one hour and tolerates a missing refresh token", async () => {
    const { pending } = await beginSignIn(graph(), REDIRECT, "session", NOW);
    const { fetcher } = fakeEntra(() => ({
      json: {
        token_type: "Bearer",
        access_token: "a",
        expires_in: 86400,
        id_token: idToken(goodClaims(pending.nonce)),
      },
    }));
    const res = await finishSignIn(graph(), callback(pending), pending, REDIRECT, { fetch: fetcher, now: () => NOW });
    expect(res.ok && res.tokens).toMatchObject({ refreshToken: null, expiresAt: NOW + 3_600_000 });
  });
});

describe("AUTH-02 cas: the refresh call", () => {
  it("sends the client secret and the refresh token, and returns the rotated pair", async () => {
    const { fetcher, seen } = fakeEntra(() => ({
      json: {
        token_type: "Bearer",
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_in: 3599,
        scope: "Files.Read",
      },
    }));
    const res = await refresher(graph(), { fetch: fetcher, now: () => NOW })("rt-1");
    expect(res).toEqual({
      ok: true,
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: NOW + 3_599_000,
      scope: "Files.Read",
    });
    expect(seen[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(seen[0]?.body.get("refresh_token")).toBe("rt-1");
    expect(seen[0]?.body.get("client_secret")).toBe("fake-client-secret");
  });

  it("AUTH-01 drill: invalid_grant (a revoked or secret-stranded token) is dead for good", async () => {
    const { fetcher } = fakeEntra(() => ({
      status: 400,
      json: { error: "invalid_grant", error_description: "AADSTS70008" },
    }));
    expect(await refresher(graph(), { fetch: fetcher })("rt-1")).toEqual({
      ok: false,
      error: "auth_required",
      revoked: true,
    });
  });

  it("a network failure is transient, not a revocation", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("network");
    };
    expect(await refresher(graph(), { fetch: down })("rt-1")).toEqual({
      ok: false,
      error: "source_unavailable",
      revoked: false,
    });
  });

  it("accepts an ID token in the refresh response when it names the right tenant", async () => {
    const { fetcher } = fakeEntra(() => ({
      json: {
        token_type: "Bearer",
        access_token: "at-2",
        expires_in: 3600,
        id_token: idToken(goodClaims("ignored", { nonce: undefined })),
      },
    }));
    expect((await refresher(graph(), { fetch: fetcher, now: () => NOW })("rt-1")).ok).toBe(true);
  });
});
