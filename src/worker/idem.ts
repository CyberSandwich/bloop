// The Idempotency-Key contract every creating route shares (ADR 0017): a client key (a UUID) makes a retry of the same
// request answer the first request's result instead of doing the work again. A route supplies only a storage adapter;
// this module owns the key check, the hashing, the window and the verdict.
import { sha256Hex } from "./ids.ts";

/** A key is honored this long after the request it first came with. */
export const IDEM_WINDOW_MS = 86_400_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a route stores for a key: the hashes it compares and the answer it replays. */
export interface IdemStore<A> {
  /** The first request this owner made with this key hash at or after `since`, or null. */
  find(owner: string, keyHash: string, since: number): Promise<{ bodyHash: string; stored: A } | null>;
}

export type Idem<A> =
  /** No header: the route does its work and stores nothing. */
  | { kind: "off" }
  /** The header is not a UUID: answer `bad_request`. */
  | { kind: "bad" }
  /** First sight of this key: do the work, and store both hashes with its result. */
  | { kind: "fresh"; keyHash: string; bodyHash: string }
  /** Same key and same body inside the window: answer from `stored`, with no work, no spend and no write. */
  | { kind: "replay"; stored: A }
  /** Same key, different body: answer `bad_request`. */
  | { kind: "conflict" };

/** The digest of a request body as the client sent it; adapters that rebuild a body from a row use the same function. */
export const bodyDigest = (bodyText: string): Promise<string> => sha256Hex(bodyText);

/**
 * `owner` scopes the key to one person (an account, a device nonce's keyed hash, or a pairing), so one person's key
 * never meets another's. Never an IP hash: one address is a whole room. A route with no such owner calls nothing and
 * replays nothing. A refused request stores no row, so its retry is judged afresh.
 */
export async function idempotency<A>(
  request: Request,
  bodyText: string,
  owner: string,
  store: IdemStore<A>,
  now: number = Date.now(),
): Promise<Idem<A>> {
  const header = request.headers.get("Idempotency-Key");
  if (header === null) return { kind: "off" };
  if (!UUID.test(header)) return { kind: "bad" };
  const keyHash = await sha256Hex(header.toLowerCase());
  const bodyHash = await bodyDigest(bodyText);
  const first = await store.find(owner, keyHash, now - IDEM_WINDOW_MS);
  if (!first) return { kind: "fresh", keyHash, bodyHash };
  return first.bodyHash === bodyHash ? { kind: "replay", stored: first.stored } : { kind: "conflict" };
}
