import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

type CloseSession = (
  env: { USER_LIBRARY: unknown; PUBLIC_ORIGIN: string },
  userId: string,
  publicId: string,
) => Promise<void>;

/** A non-literal specifier: the module's type graph needs the Workers types the test tsconfig omits. */
async function closeSessionOf(): Promise<CloseSession> {
  const path = "../../src/worker/auth/screens.ts";
  return ((await import(path)) as { closeSession: CloseSession }).closeSession;
}

/** A USER_LIBRARY namespace whose stubs record the RPC calls and which jurisdiction they came through. */
function fakeLibrary(rpc: (publicId: string) => Promise<void> = async () => {}) {
  const calls: { jurisdiction: string | null; user: string; publicId: string }[] = [];
  const ns = (jurisdiction: string | null) => ({
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => ({
      closeSession: async (publicId: string) => {
        calls.push({ jurisdiction, user: name, publicId });
        await rpc(publicId);
      },
    }),
    jurisdiction: (j: string) => ns(j),
  });
  return { calls, USER_LIBRARY: ns(null) };
}

describe("closeSession: a session end closes its library sockets on L's UserLibrary", () => {
  it("calls UserLibrary.closeSession(publicId) on the member's object, through eu on a deployed origin", async () => {
    const closeSession = await closeSessionOf();
    const lib = fakeLibrary();
    await closeSession({ USER_LIBRARY: lib.USER_LIBRARY, PUBLIC_ORIGIN: "https://bloop.here" }, "u1", "p".repeat(22));
    await closeSession(
      { USER_LIBRARY: lib.USER_LIBRARY, PUBLIC_ORIGIN: "http://127.0.0.1:8787" },
      "u2",
      "q".repeat(22),
    );
    expect(lib.calls).toEqual([
      { jurisdiction: "eu", user: "u1", publicId: "p".repeat(22) },
      { jurisdiction: null, user: "u2", publicId: "q".repeat(22) },
    ]);
  });

  it("a failing call is logged by kind and never fails the session end", async () => {
    const closeSession = await closeSessionOf();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const lib = fakeLibrary(async () => {
      throw new TypeError("closeSession is not a method");
    });
    await expect(
      closeSession({ USER_LIBRARY: lib.USER_LIBRARY, PUBLIC_ORIGIN: "https://bloop.here" }, "u1", "p".repeat(22)),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([JSON.stringify({ evt: "library", kind: "close_session_failed" })]);
  });
});
