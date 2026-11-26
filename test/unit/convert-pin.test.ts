import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fillAccount, requirePrebuilt, withAccount, withDigest, withPrebuilt } from "../../tools/prebuilt.mjs";
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

  it("rewrite fills the digest in digest.txt and leaves the account zeros; never a tag", () => {
    const rewritten = withDigest(withPrebuilt(wrangler), digest);
    expect(imageOf(rewritten)).toBe(`registry.cloudflare.com/${"0".repeat(32)}/bloop-converter@${digest}`);
  });

  it("account fills the account's own registry, and the result passes requirePrebuilt", () => {
    const filled = withAccount(withDigest(withPrebuilt(wrangler), digest), ACCOUNT);
    expect(imageOf(filled)).toBe(`registry.cloudflare.com/${ACCOUNT}/bloop-converter@${digest}`);
    expect(() => requirePrebuilt(filled)).not.toThrow();
  });

  it("a deploy that skipped rewrite or account is refused", () => {
    expect(() => requirePrebuilt(withPrebuilt(wrangler))).toThrow(/digest placeholder/);
    expect(() => requirePrebuilt(withDigest(withPrebuilt(wrangler), digest))).toThrow(/account placeholder/);
  });

  it("the account step runs only in GitHub Actions, so a local run cannot write the id into the tracked file", () => {
    for (const actions of [undefined, "", "false", "1"])
      expect(() => fillAccount(wrangler, { GITHUB_ACTIONS: actions, CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toThrow(
        /only in GitHub Actions/,
      );
    const filled = fillAccount(wrangler, { GITHUB_ACTIONS: "true", CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(imageOf(filled)).toBe(`registry.cloudflare.com/${ACCOUNT}/bloop-converter@sha256:${"0".repeat(64)}`);
  });

  it("a fill that replaces nothing throws, and the filled image is exactly account plus digest", () => {
    const pinned = withDigest(withPrebuilt(wrangler), digest);
    expect(() => withDigest(pinned, digest)).toThrow(/no image placeholder/);
    const filled = withAccount(pinned, ACCOUNT);
    expect(() => withAccount(filled, ACCOUNT)).toThrow(/no account placeholder/);
    expect(imageOf(filled)).toBe(`registry.cloudflare.com/${ACCOUNT}/bloop-converter@${digest}`);
  });

  it("account refuses an unset, short, non-hex, padded or all-zero id and rewrite refuses a bad digest", () => {
    for (const bad of [undefined, "", "abc", "g".repeat(32), `${ACCOUNT}\n`, ACCOUNT.toUpperCase(), "0".repeat(32)])
      expect(() => withAccount(wrangler, bad)).toThrow(/32-character hex/);
    expect(() => withDigest(wrangler, "latest")).toThrow(/sha256 digest/);
    expect(() => withDigest(wrangler, `${digest}x`)).toThrow(/sha256 digest/);
    expect(() => withDigest(wrangler, `sha256:${"0".repeat(64)}`)).toThrow(/sha256 digest/);
  });
});
