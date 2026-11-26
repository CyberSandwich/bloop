// Request counting for the FLOW tests (docs/architecture.md section 11): a flow test sends its requests through a
// RequestCounter's `fetch` and asserts how many reached the Worker, by method and path, before it asserts anything else.

export interface Counted {
  method: string;
  /** Path and query, as the Worker received them. */
  path: string;
}

export class RequestCounter {
  readonly seen: Counted[] = [];

  /** A drop-in for `fetch` that records each request before it is sent. */
  fetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    this.seen.push({ method: method.toUpperCase(), path: url.pathname + url.search });
    return fetch(input, init);
  };

  /** How many requests match: a method (any when omitted) and a path prefix (any when omitted). */
  count(match: { method?: string; prefix?: string } = {}): number {
    return this.seen.filter(
      (r) =>
        (match.method === undefined || r.method === match.method) &&
        (match.prefix === undefined || r.path.startsWith(match.prefix)),
    ).length;
  }

  reset(): void {
    this.seen.length = 0;
  }
}
