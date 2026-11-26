import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requirePrebuilt, withAccount, withPrebuilt } from "../../tools/prebuilt.mjs";
import { wranglerConfig } from "../../tools/wrangler-config.mjs";

const wrangler = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const digest = readFileSync(new URL("../../container/digest.txt", import.meta.url), "utf8").trim();
const REF = /^registry\.cloudflare\.com\/\{ACCOUNT_ID\}\/bloop-converter@(sha256:[0-9a-f]{64})$/;
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("CONV-06 pin: the container the Converter starts is the image container/digest.txt names", () => {
  const entry = wranglerConfig(wrangler).containers?.[0];

  it("the Converter has one container entry, scheduled by the Object, with one named image", () => {
    expect(wranglerConfig(wrangler).containers).toHaveLength(1);
    expect(entry).toMatchObject({ class_name: "Converter", scheduling_policy: "durable_object" });
    expect(Object.keys(entry.images)).toEqual(["converter"]);
  });

  it("the image is the pinned digest, never a tag, and the account id is a placeholder", () => {
    const ref = entry.images.converter.image as string;
    expect(ref).toMatch(REF);
    expect(REF.exec(ref)?.[1]).toBe(digest);
  });

  it("the repo holds no account id: the deploy rewrite supplies it, and an unrewritten config is refused", () => {
    const filled = withAccount(withPrebuilt(wrangler), ACCOUNT);
    expect(wranglerConfig(filled).containers[0].images.converter.image).toBe(
      `registry.cloudflare.com/${ACCOUNT}/bloop-converter@${digest}`,
    );
    expect(() => requirePrebuilt(withPrebuilt(wrangler))).toThrow(/account placeholder/);
    expect(() => requirePrebuilt(filled)).not.toThrow();
  });

  it("without a secret the placeholder becomes an id no account has, and a malformed id is refused", () => {
    expect(withAccount(wrangler, undefined)).toContain(`registry.cloudflare.com/${"0".repeat(32)}/bloop-converter@`);
    expect(() => withAccount(wrangler, "not-an-id")).toThrow(/32-character hex/);
    expect(() => withAccount(wrangler, `${ACCOUNT}\n`)).toThrow(/32-character hex/);
  });
});
