import { describe, expect, it } from "vitest";
import { callRoute, memberWorld, seedMember, sid, spied } from "./member-fixture.ts";

describe("passkey names: PATCH /api/me/passkeys/:id", () => {
  it("takes letters, digits, emoji with ZWJ, space, hyphen and apostrophe; refuses bidi, zero-width space and URLs", async () => {
    const world = memberWorld();
    const { routes } = await spied();
    const cookie = await seedMember(world.db, "m1", "m@example.test");
    world.db.raw
      .prepare(
        "INSERT INTO passkey (id, user_id, public_key, sign_count, backed_up, name, created_at) VALUES ('cred-1', 'm1', x'00', 0, 1, 'Passkey', 0)",
      )
      .run();
    const rename = (name: string) =>
      callRoute(routes, world.env, "PATCH", "/api/me/passkeys/cred-1", { cookie: sid(cookie), body: { name } });
    for (const name of ["Duke's iPhone 15", "Büro-Laptop", "  MacBook  ", "👩\u200D💻 work", "x".repeat(40)]) {
      expect((await rename(name)).status, name).toBe(200);
    }
    expect(world.db.raw.prepare("SELECT name FROM passkey").get()).toEqual({ name: "x".repeat(40) });
    for (const name of [
      "evil\u202Egnp.exe",
      "a\u200Bb",
      "\u2066x\u2069",
      "https://evil.example",
      "bloop.here/signin",
      "x".repeat(41),
      "",
      "  ",
      "line\nbreak",
    ]) {
      expect((await rename(name)).status, JSON.stringify(name)).toBe(400);
    }
    expect(world.db.raw.prepare("SELECT name FROM passkey").get()).toEqual({ name: "x".repeat(40) });
  });
});
