import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requirePrebuilt, withImage, withPrebuilt } from "../../tools/prebuilt.mjs";
import { wranglerConfig } from "../../tools/wrangler-config.mjs";

const wrangler = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const digest = readFileSync(new URL("../../container/digest.txt", import.meta.url), "utf8").trim();
const REF = "registry.cloudflare.com/{ACCOUNT_ID}/bloop-converter@{DIGEST}";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("CONV-06 pin: the container the Converter starts is the image container/digest.txt names", () => {
  const entry = wranglerConfig(wrangler).containers?.[0];

  it("digest.txt is one sha256 digest", () => {
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("the Converter has one container entry, scheduled by the Object, with one named image", () => {
    expect(wranglerConfig(wrangler).containers).toHaveLength(1);
    expect(entry).toMatchObject({ class_name: "Converter", scheduling_policy: "durable_object" });
    expect(Object.keys(entry.images)).toEqual(["converter"]);
  });

  it("wrangler.jsonc holds neither an account id nor a digest: both are placeholders filled at deploy", () => {
    expect(entry.images.converter.image).toBe(REF);
  });

  it("the rewrite names the account's own registry and the digest in digest.txt, never a tag", () => {
    const filled = withImage(withPrebuilt(wrangler), ACCOUNT, digest);
    expect(wranglerConfig(filled).containers[0].images.converter.image).toBe(
      `registry.cloudflare.com/${ACCOUNT}/bloop-converter@${digest}`,
    );
    expect(() => requirePrebuilt(filled)).not.toThrow();
  });

  it("an unrewritten config is refused by a deploy", () => {
    expect(() => requirePrebuilt(withPrebuilt(wrangler))).toThrow(/image placeholder/);
    expect(() => requirePrebuilt(withPrebuilt(wrangler).replaceAll("{ACCOUNT_ID}", ACCOUNT))).toThrow(
      /image placeholder/,
    );
  });

  it("without a secret the account becomes an id no account has, and a malformed id or digest is refused", () => {
    expect(withImage(wrangler, undefined, digest)).toContain(
      `registry.cloudflare.com/${"0".repeat(32)}/bloop-converter@`,
    );
    expect(() => withImage(wrangler, "not-an-id", digest)).toThrow(/32-character hex/);
    expect(() => withImage(wrangler, `${ACCOUNT}\n`, digest)).toThrow(/32-character hex/);
    expect(() => withImage(wrangler, ACCOUNT, "latest")).toThrow(/sha256 digest/);
    expect(() => withImage(wrangler, ACCOUNT, `${digest}x`)).toThrow(/sha256 digest/);
  });
});
