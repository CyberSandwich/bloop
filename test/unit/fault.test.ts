import { describe, expect, it } from "vitest";
import { FAULT_BINDINGS, FAULT_COOKIE, FAULT_HEADER, withFaults } from "../../src/worker/fault.ts";
import { PROD_VARS } from "../env-vars.ts";

type World = Record<string, unknown>;
const real = (name: string) => ({ get: () => `${name} works`, prepare: () => `${name} works` });
const world = (over: Record<string, string> = {}): World => ({
  ...PROD_VARS,
  PUBLIC_ORIGIN: "http://localhost:8787",
  TEST_TIMING: "1",
  ...over,
  DB: real("db"),
  GUEST_FILES: real("guest"),
  LIBRARY: real("library"),
  SCREEN: real("screen"),
  DIRECTORY: real("directory"),
  USER_LIBRARY: real("user-library"),
  CONVERTER: real("converter"),
});
const use = (env: World, key: string) => (env[key] as ReturnType<typeof real>).get();
const ask = (value: string) => new Request("http://localhost:8787/api/health", { headers: { [FAULT_HEADER]: value } });
const asCookie = (value: string) =>
  new Request("http://localhost:8787/api/health", { headers: { Cookie: `other=1; ${FAULT_COOKIE}=${value}` } });

describe("fault injection", () => {
  it("makes every method of a named binding throw, and leaves the others alone", () => {
    const faulted = withFaults(world(), ask("d1,r2"));
    expect(() => use(faulted, "DB")).toThrow("fault injected: d1");
    expect(() => use(faulted, "GUEST_FILES")).toThrow("fault injected: r2");
    expect(() => use(faulted, "LIBRARY")).toThrow("fault injected: r2");
    expect(use(faulted, "SCREEN")).toBe("screen works");
    expect(faulted.PUBLIC_ORIGIN).toBe("http://localhost:8787");
  });

  it("covers every dependency of the failure matrix: D1, both buckets and the four Durable Object classes", () => {
    for (const [name, keys] of Object.entries(FAULT_BINDINGS)) {
      const faulted = withFaults(world(), ask(name));
      for (const key of keys) expect(() => use(faulted, key), `${name} ${key}`).toThrow();
    }
    expect(Object.values(FAULT_BINDINGS).flat().sort()).toEqual(
      ["CONVERTER", "DB", "DIRECTORY", "GUEST_FILES", "LIBRARY", "SCREEN", "USER_LIBRARY"].sort(),
    );
  });

  it("reads the cookie a WebSocket upgrade carries, and ignores an unknown name", () => {
    const env = world();
    expect(() => use(withFaults(env, asCookie("directory")), "DIRECTORY")).toThrow();
    expect(withFaults(env, ask("nope, ,"))).toBe(env);
  });

  it("does nothing without TEST_TIMING, and nothing on a deployed origin, where config refuses TEST_TIMING", () => {
    const off = world({ TEST_TIMING: "0" });
    expect(withFaults(off, ask("d1"))).toBe(off);
    const deployed = world({ PUBLIC_ORIGIN: "https://bloop.example" });
    expect(withFaults(deployed, ask("d1"))).toBe(deployed);
  });

  it("does nothing for a request that asks for nothing", () => {
    const env = world();
    expect(withFaults(env, new Request("http://localhost:8787/privacy"))).toBe(env);
  });
});
