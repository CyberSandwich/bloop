import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requirePrebuilt, withImage, withPrebuilt } from "../../tools/prebuilt.mjs";
import { wranglerConfig } from "../../tools/wrangler-config.mjs";

const wrangler = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const digest = readFileSync(new URL("../../container/digest.txt", import.meta.url), "utf8").trim();
const ZEROS = `registry.cloudflare.com/${"0".repeat(32)}/bloop-converter@sha256:${"0".repeat(64)}`;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const imageOf = (config: string): string => wranglerConfig(config).containers[0].images.converter.image;

describe("CONV-06 pin: the container the Converter starts is the image container/digest.txt names", () => {
  it("digest.txt is one sha256 digest", () => {
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest).not.toBe(`sha256:${"0".repeat(64)}`);
  });

  it("the Converter has one container entry, scheduled by the Object, with one named image", () => {
    const entries = wranglerConfig(wrangler).containers;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ class_name: "Converter", scheduling_policy: "durable_object" });
    expect(Object.keys(entries[0].images)).toEqual(["converter"]);
  });

  it("wrangler.jsonc holds neither an account id nor a digest: both are zeros in the shape wrangler checks", () => {
    expect(imageOf(wrangler)).toBe(ZEROS);
  });

  it("the rewrite names the account's own registry and the digest in digest.txt, never a tag", () => {
    const filled = withImage(withPrebuilt(wrangler), ACCOUNT, digest);
    expect(imageOf(filled)).toBe(`registry.cloudflare.com/${ACCOUNT}/bloop-converter@${digest}`);
    expect(() => requirePrebuilt(filled)).not.toThrow();
  });

  it("an unrewritten config is refused by a deploy", () => {
    expect(() => requirePrebuilt(withPrebuilt(wrangler))).toThrow(/image placeholder/);
  });

  it("without a secret the account stays zeros but the digest is still filled; bad input is refused", () => {
    expect(imageOf(withImage(wrangler, undefined, digest))).toBe(
      `registry.cloudflare.com/${"0".repeat(32)}/bloop-converter@${digest}`,
    );
    expect(() => withImage(wrangler, "not-an-id", digest)).toThrow(/32-character hex/);
    expect(() => withImage(wrangler, `${ACCOUNT}\n`, digest)).toThrow(/32-character hex/);
    expect(() => withImage(wrangler, ACCOUNT, "latest")).toThrow(/sha256 digest/);
    expect(() => withImage(wrangler, ACCOUNT, `${digest}x`)).toThrow(/sha256 digest/);
    expect(() => withImage(wrangler, ACCOUNT, `sha256:${"0".repeat(64)}`)).toThrow(/sha256 digest/);
  });
});
