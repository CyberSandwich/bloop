// OAuth 2.0 authorization code flow with PKCE (S256), state and nonce, as a confidential client, on
// oauth4webapi. Pure of storage: callers persist the result (routes/auth.ts, auth/vault.ts).
import * as oauth from "oauth4webapi";
import type { GraphConfig } from "../config.ts";
import type { Identity } from "./sessions.ts";
import type { Refresh } from "./vault.ts";

/** Access tokens are cached for at most this long, whatever Entra says (ADR 0004). */
const MAX_ACCESS_SECONDS = 3600;
const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Authority path segments that stand for "any tenant": the issuer then names the signed-in user's tenant. */
const MULTI_TENANT = new Set(["organizations", "common", "consumers"]);

export interface OAuthDeps {
  /** Replaced in tests. Defaults to the platform fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** What a sign-in carries across the redirect, sealed in the oauth cookie. */
export interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  /** Epoch ms: the cookie is refused after this. */
  expiresAt: number;
}
export const PENDING_SECONDS = 600;

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
}

export type SignInError = "state" | "consent_declined" | "admin_consent_required" | "issuer" | "exchange";

const authorityBase = (authority: string) => authority.replace(/\/v2\.0\/?$/, "");
const tenantSegment = (authority: string) => authorityBase(authority).split("/").pop() ?? "";

/** The issuer Entra puts in a token for `tid`. Throws unless `tid` is a GUID and fits a fixed tenant. */
export function issuerFor(authority: string, tid: string): string {
  const segment = tenantSegment(authority);
  if (!GUID.test(tid)) throw new Error("tid is not a GUID");
  if (!MULTI_TENANT.has(segment) && segment.toLowerCase() !== tid.toLowerCase())
    throw new Error("tid is not the tenant");
  return `${authorityBase(authority).replace(/\/[^/]*$/, "")}/${tid}/v2.0`;
}

function serverFor(graph: GraphConfig): oauth.AuthorizationServer {
  const base = authorityBase(graph.authority);
  const segment = tenantSegment(graph.authority);
  return {
    // A fixed tenant has one issuer. For a multi-tenant authority it is replaced per token (withIssuer).
    issuer: MULTI_TENANT.has(segment) ? graph.authority : issuerFor(graph.authority, segment),
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    token_endpoint: `${base}/oauth2/v2.0/token`,
  };
}

const clientFor = (graph: GraphConfig): oauth.Client => ({ client_id: graph.clientId });

/** An http authority is only accepted by config on a local origin (config.ts), so it may be allowed here. */
function requestOptions(graph: GraphConfig, deps: OAuthDeps) {
  return {
    ...(deps.fetch ? { [oauth.customFetch]: deps.fetch } : {}),
    ...(graph.authority.startsWith("http://") ? { [oauth.allowInsecureRequests]: true } : {}),
  };
}

/** The `tid` claim of the response's id_token, read without trusting it: it only picks the issuer to check against. */
async function peekTid(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { id_token?: unknown };
    if (typeof body.id_token !== "string") return null;
    const payload = body.id_token.split(".")[1] ?? "";
    const claims = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { tid?: unknown };
    return typeof claims.tid === "string" ? claims.tid : null;
  } catch {
    return null;
  }
}

/**
 * Multi-tenant authorities have no single issuer. The token must name its own tenant, and `iss` must equal
 * the issuer built from that `tid` (AUTH-04); oauth4webapi then checks `iss`, `aud`, `exp` and the nonce.
 */
async function withIssuer(graph: GraphConfig, response: Response): Promise<oauth.AuthorizationServer> {
  const as = serverFor(graph);
  const tid = await peekTid(response);
  return tid === null ? as : { ...as, issuer: issuerFor(graph.authority, tid) };
}

/** Scopes for the authorize request: `offline_access` only when a refresh token is wanted. */
export const scopesFor = (graph: GraphConfig, mode: "refresh" | "session"): string =>
  graph.scopes.filter((s) => mode === "refresh" || s !== "offline_access").join(" ");

export async function beginSignIn(
  graph: GraphConfig,
  redirectUri: string,
  mode: "refresh" | "session",
  now: number,
): Promise<{ url: string; pending: Pending }> {
  const verifier = oauth.generateRandomCodeVerifier();
  const pending: Pending = {
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    verifier,
    expiresAt: now + PENDING_SECONDS * 1000,
  };
  const url = new URL(serverFor(graph).authorization_endpoint as string);
  url.search = new URLSearchParams({
    client_id: graph.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: scopesFor(graph, mode),
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), pending };
}

const ENTRA_ADMIN_CODES = /AADSTS(90094|65001|90008)/;

function classify(error: unknown): SignInError {
  if (error instanceof oauth.AuthorizationResponseError) {
    const detail = `${error.error} ${error.error_description ?? ""}`;
    if (error.error === "consent_required" || ENTRA_ADMIN_CODES.test(detail)) return "admin_consent_required";
    return error.error === "access_denied" ? "consent_declined" : "exchange";
  }
  return "exchange";
}

export type FinishResult = { ok: true; identity: Identity; tokens: Tokens } | { ok: false; error: SignInError };

/** Validates the callback against the pending sign-in, redeems the code, and checks the ID token. */
export async function finishSignIn(
  graph: GraphConfig,
  callback: URL,
  pending: Pending,
  redirectUri: string,
  deps: OAuthDeps = {},
): Promise<FinishResult> {
  const now = (deps.now ?? Date.now)();
  if (pending.expiresAt <= now) return { ok: false, error: "state" };
  const client = clientFor(graph);
  const options = requestOptions(graph, deps);
  // Entra can add RFC 9207 `iss` to the response; the ID token's own `iss` is checked below, so drop it here.
  const params = new URLSearchParams(callback.searchParams);
  params.delete("iss");
  let validated: URLSearchParams;
  try {
    validated = oauth.validateAuthResponse(serverFor(graph), client, params, pending.state);
  } catch (error) {
    // A wrong or missing state is a failed check; an `error` response from Entra is a refusal.
    return { ok: false, error: error instanceof oauth.AuthorizationResponseError ? classify(error) : "state" };
  }
  try {
    const response = await oauth.authorizationCodeGrantRequest(
      serverFor(graph),
      client,
      oauth.ClientSecretPost(graph.clientSecret),
      validated,
      redirectUri,
      pending.verifier,
      options,
    );
    let as: oauth.AuthorizationServer;
    try {
      as = await withIssuer(graph, response);
    } catch {
      return { ok: false, error: "issuer" };
    }
    let result: oauth.TokenEndpointResponse;
    try {
      result = await oauth.processAuthorizationCodeResponse(as, client, response, {
        expectedNonce: pending.nonce,
        requireIdToken: true,
      });
    } catch (error) {
      // An OAuth error body is the token endpoint refusing; anything else is the ID token failing validation.
      return { ok: false, error: error instanceof oauth.ResponseBodyError ? classify(error) : "issuer" };
    }
    const claims = oauth.getValidatedIdTokenClaims(result);
    const tid = claims?.tid;
    const oid = claims?.oid;
    if (typeof tid !== "string" || typeof oid !== "string" || claims?.iss !== issuerFor(graph.authority, tid)) {
      return { ok: false, error: "issuer" };
    }
    const email = [claims.email, claims.preferred_username].find((v): v is string => typeof v === "string") ?? null;
    return { ok: true, identity: { tid, oid, email }, tokens: tokensOf(result, now) };
  } catch (error) {
    return { ok: false, error: classify(error) };
  }
}

function tokensOf(result: oauth.TokenEndpointResponse, now: number): Tokens {
  const seconds = Math.min(result.expires_in ?? MAX_ACCESS_SECONDS, MAX_ACCESS_SECONDS);
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresAt: now + seconds * 1000,
    scope: result.scope ?? "",
  };
}

/** The vault's refresh callback: redeems a refresh token. `invalid_grant` means it is dead for good. */
export function refresher(graph: GraphConfig, deps: OAuthDeps = {}): Refresh {
  return async (presented) => {
    const client = clientFor(graph);
    const now = (deps.now ?? Date.now)();
    try {
      const response = await oauth.refreshTokenGrantRequest(
        serverFor(graph),
        client,
        oauth.ClientSecretPost(graph.clientSecret),
        presented,
        requestOptions(graph, deps),
      );
      const result = await oauth.processRefreshTokenResponse(await withIssuer(graph, response), client, response);
      const { accessToken, refreshToken, expiresAt, scope } = tokensOf(result, now);
      return { ok: true, accessToken, refreshToken, expiresAt, ...(scope ? { scope } : {}) };
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError) {
        return { ok: false, error: "auth_required", revoked: error.error === "invalid_grant" };
      }
      return { ok: false, error: "source_unavailable", revoked: false };
    }
  };
}
