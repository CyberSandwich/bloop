import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

type CloseSessions = (
  env: { USER_LIBRARY: unknown; PUBLIC_ORIGIN: string },
  userId: string,
  publicIds: readonly string[],
) => Promise<void>;

interface ScreensModule {
  endSessions: (
    deps: { endScreens: () => Promise<void>; closeSessions: () => Promise<void> },
    env: unknown,
    userId: string,
    publicIds: readonly string[],
  ) => Promise<void>;
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
  it("is on: the shipped closeSessions reaches the member's object with every ended id", async () => {
    const { LIBRARY_CLOSES_SESSIONS, closeSessions } = await screens();
    expect(LIBRARY_CLOSES_SESSIONS).toBe(true);
    const lib = fakeLibrary();
    await closeSessions({ USER_LIBRARY: lib.USER_LIBRARY, PUBLIC_ORIGIN: "https://bloop.here" }, "u1", [P, Q]);
    expect(lib.calls).toEqual([{ jurisdiction: "eu", user: "u1", publicIds: [P, Q] }]);
  });

  it("a scoped screen end reaches the object with its scope, and an unscoped one with none", async () => {
    const path = "../../src/worker/auth/screens.ts";
    const { endScreens } = (await import(path)) as {
      endScreens: (env: unknown, userId: string, scope?: object) => Promise<void>;
    };
    const seen: unknown[][] = [];
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: ({ name }: { name: string }) => ({
        endScreens: async (...args: unknown[]) => void seen.push([name, ...args]),
      }),
      jurisdiction: () => ns,
    };
    const env = { USER_LIBRARY: ns, PUBLIC_ORIGIN: "https://bloop.here" };
    await endScreens(env, "u1", { bySession: P });
    await endScreens(env, "u1", { fileId: "f1" });
    await endScreens(env, "u1");
    expect(seen).toEqual([
      ["u1", "u1", { bySession: P }],
      ["u1", "u1", { fileId: "f1" }],
      ["u1", "u1", {}],
    ]);
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

describe("endSessions: a failing screen end never skips the library close", () => {
  it("logs end_screens_failed by kind, still closes the library sockets and does not throw", async () => {
    const { endSessions } = await screens();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const closed: string[] = [];
    const deps = {
      endScreens: async () => {
        throw new Error("live layer unavailable");
      },
      closeSessions: async () => void closed.push("closed"),
    };
    await expect(endSessions(deps, {}, "u1", [P])).resolves.toBeUndefined();
    expect(closed).toEqual(["closed"]);
    expect(logs).toEqual([JSON.stringify({ evt: "auth", kind: "end_screens_failed" })]);
  });
});
