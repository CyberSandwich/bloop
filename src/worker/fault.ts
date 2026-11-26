// Fault injection for the failure matrix (docs/architecture.md section 13.7). A test names the bindings that must fail in
// the `X-Bloop-Fault` header or the `bloop_fault` cookie (a WebSocket upgrade carries the cookie, not a custom header):
// `d1,r2`. Every method of a named binding then throws. It is active only when the configuration parses with
// TEST_TIMING, which config.ts refuses on a deployed origin.
import { configFor } from "./config.ts";

export const FAULT_HEADER = "X-Bloop-Fault";
export const FAULT_COOKIE = "bloop_fault";

/** What each fault name takes down. */
export const FAULT_BINDINGS = {
  d1: ["DB"],
  r2: ["GUEST_FILES", "LIBRARY"],
  screen: ["SCREEN"],
  directory: ["DIRECTORY"],
  "user-library": ["USER_LIBRARY"],
  converter: ["CONVERTER"],
} as const;

const failing = <T extends object>(name: string, binding: T): T =>
  new Proxy(binding, {
    get: (target, prop) => {
      const value = Reflect.get(target, prop);
      return typeof value === "function"
        ? () => {
            throw new Error(`fault injected: ${name}`);
          }
        : value;
    },
  });

/** The fault names a request asks for; an unknown name is ignored. */
function requested(request: Request): (keyof typeof FAULT_BINDINGS)[] {
  const cookie = request.headers.get("Cookie")?.match(new RegExp(`(?:^|; )${FAULT_COOKIE}=([^;]*)`))?.[1];
  const names = (request.headers.get(FAULT_HEADER) ?? cookie ?? "").split(",").map((n) => n.trim());
  return names.filter((n): n is keyof typeof FAULT_BINDINGS => Object.hasOwn(FAULT_BINDINGS, n));
}

/** `env` with the requested bindings failing, or `env` itself when nothing is asked or TEST_TIMING is off. */
export function withFaults<E extends object>(env: E, request: Request): E {
  if (!request.headers.has(FAULT_HEADER) && !request.headers.has("Cookie")) return env;
  const names = requested(request);
  if (names.length === 0) return env;
  const config = configFor(env);
  if (!config.ok || !config.config.testTiming) return env;
  const faulted = { ...env } as Record<string, unknown>;
  for (const name of names) {
    for (const key of FAULT_BINDINGS[name]) faulted[key] = failing(name, (env as Record<string, object>)[key] ?? {});
  }
  return faulted as E;
}
