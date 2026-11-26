import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

type CloseSessions = (
  env: { USER_LIBRARY: unknown; PUBLIC_ORIGIN: string },
  userId: string,
  publicIds: readonly string[],
) => Promise<void>;

interface ScreensModule {
  LIBRARY_CLOSES_SESSIONS: boolean;
  closeSessions: CloseSessions;
  librarySessions: (enabled: boolean) => CloseSessions;
}

/** A non-literal specifier: the module's type graph needs the Workers types the test tsconfig omits. */
async function screens(): Promise<ScreensModule> {
  const path = "../../src/worker/auth/screens.ts";
  return (await import(path)) as ScreensModule;
}

/** A USER_LIBRARY namespace whose stubs record the RPC calls and which jurisdiction they came through. */
function fakeLibrary(rpc: (publicIds: string[]) => Promise<void> = async () => {}) {
  const calls: { jurisdiction: string | null; user: string; publicIds: string[] }[] = [];
  let lookups = 0;
  const ns = (jurisdiction: string | null) => ({
    idFromName: (name: string) => {
      lookups++;
      return { name };
    },
    get: ({ name }: { name: string }) => ({
      closeSessions: async (publicIds: string[]) => {
        calls.push({ jurisdiction, user: name, publicIds });
        await rpc(publicIds);
      },
    }),
    jurisdiction: (j: string) => ns(j),
  });
  return { calls, lookups: () => lookups, USER_LIBRARY: ns(null) };
}

const P = "p".repeat(22);
const Q = "q".repeat(22);

describe("closeSessions: a session end closes its library sockets on the member's UserLibrary", () => {
  it("is a no-op until the library's closeSessions lands: no object is looked up or woken, nothing is logged", async () => {
    const { LIBRARY_CLOSES_SESSIONS, closeSessions } = await screens();
    expect(LIBRARY_CLOSES_SESSIONS).toBe(false);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const lib = fakeLibrary();
    await closeSessions({ USER_LIBRARY: lib.USER_LIBRARY, PUBLIC_ORIGIN: "https://bloop.here" }, "u1", [P, Q]);
    expect(lib.lookups()).toBe(0);
    expect(lib.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("once enabled, one call carries every ended id, through eu on a deployed origin; none for no ids", async () => {
    const close = (await screens()).librarySessions(true);
    const lib = fakeLibrary();
    await close({ USER_LIBRARY: lib.USER_LIBRARY, PUBLIC_ORIGIN: "https://bloop.here" }, "u1", [P, Q]);
    await close({ USER_LIBRARY: lib.USER_LIBRARY, PUBLIC_ORIGIN: "http://127.0.0.1:8787" }, "u2", [Q]);
    await close({ USER_LIBRARY: lib.USER_LIBRARY, PUBLIC_ORIGIN: "https://bloop.here" }, "u3", []);
    expect(lib.calls).toEqual([
      { jurisdiction: "eu", user: "u1", publicIds: [P, Q] },
      { jurisdiction: null, user: "u2", publicIds: [Q] },
    ]);
  });

  it("once enabled, a failing call or a throwing lookup is logged by kind and never fails the session end", async () => {
    const close = (await screens()).librarySessions(true);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const failing = fakeLibrary(async () => {
      throw new TypeError("closeSessions is not a method");
    });
    const throwing = {
      jurisdiction: () => {
        throw new Error("namespace unavailable");
      },
    };
    for (const USER_LIBRARY of [failing.USER_LIBRARY, throwing]) {
      await expect(close({ USER_LIBRARY, PUBLIC_ORIGIN: "https://bloop.here" }, "u1", [P])).resolves.toBeUndefined();
    }
    expect(logs).toEqual(Array(2).fill(JSON.stringify({ evt: "library", kind: "close_sessions_failed" })));
  });
});
