// MODE-01 end to end, in both projects: the mode picks the page, and no /open form is ever a page of its own.
import { expect, test } from "./mode.ts";

for (const path of [
  "/open",
  "/open/",
  "/open.html",
  "/open/index.html",
  "/open/404",
  "/Open/privacy",
  "/open/privacy",
  "/_launch.json",
]) {
  test(`MODE-01 ${path} is 404`, async ({ request }) => {
    expect((await request.get(path, { maxRedirects: 0 })).status()).toBe(404);
  });
}

test("MODE-01 the landing, the sitemap and the Features article follow the mode", async ({ request, mode }) => {
  const landing = await (await request.get("/")).text();
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const features = (await request.get("/articles/features")).status();
  const open = mode === "open";
  expect(landing.includes("data-account")).toBe(open);
  expect(landing.includes('<a class="btn waitlist"')).toBe(!open);
  expect(sitemap.includes("/articles/features")).toBe(open);
  expect(features).toBe(open ? 200 : 404);
});
