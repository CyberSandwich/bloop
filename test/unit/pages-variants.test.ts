// MODE-01: the Worker's variant list (src/worker/pages.ts) is the set of pages the build emits under public/open/.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type PageEnv, servePage, VARIANTS } from "../../src/worker/pages.ts";
import { buildAll } from "../../tools/build-pages.mjs";
import { PROD_VARS } from "../env-vars.ts";
import { testDb } from "./d1-shim.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const preview = buildAll();
const open = buildAll("open");
/** `public/open/articles/x.html` is served at `/articles/x`; the landing at `/`; a text file at its own name. */
const pathOf = (rel: string) => {
  const path = rel.replace(/^public\/open/, "").replace(/\.html$/, "");
  return path === "/index" ? "/" : path;
};

describe("MODE-01 the variant list equals the build", () => {
  const emitted = [...open.keys()].map(pathOf).filter((path) => path !== "/404");
  const previewPaths = new Set([...preview.keys()].map((rel) => pathOf(rel.replace(/^public/, "public/open"))));

  it("every both-page and open-only page is a file the build emits, and every emitted file but the 404 is listed", () => {
    expect(VARIANTS.map((v) => v.path).sort()).toEqual([...emitted].sort());
  });

  it("a both-page has a preview file too, an open-only page has none, and no page is preview-only", () => {
    for (const v of VARIANTS) {
      if (v.kind === "both") expect(previewPaths.has(v.path), v.path).toBe(true);
      if (v.kind === "open-only") expect(previewPaths.has(v.path), v.path).toBe(false);
    }
    expect(VARIANTS.filter((v) => v.kind === "open-only").map((v) => v.path)).toEqual(["/articles/features"]);
    expect(VARIANTS.filter((v) => v.kind === "preview-only")).toEqual([]);
  });

  it("every preview-only entry redirects to a listed page", () => {
    for (const v of VARIANTS.filter((x) => x.kind === "preview-only")) {
      expect(VARIANTS.map((x) => x.path)).toContain(v.to);
    }
  });

  it("public/open exists only while the list is not empty", () => {
    const files = existsSync(`${ROOT}public/open`) ? readdirSync(`${ROOT}public/open`) : [];
    expect(files.length === 0 || VARIANTS.length > 0).toBe(true);
  });
});

describe("MODE-01 openAsset never ends in a slash", () => {
  it("each variant in open mode asks the asset layer for a file path with no trailing slash that the build emits", async () => {
    const db = testDb();
    db.raw
      .prepare("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?, ?, ?)")
      .run("launch_mode", "open", 1);
    const asked: string[] = [];
    const env = {
      ...PROD_VARS,
      PUBLIC_ORIGIN: "http://localhost:8787",
      TEST_TIMING: "1",
      DB: db,
      ASSETS: {
        fetch: async (req: Request) => {
          asked.push(new URL(req.url).pathname);
          return new Response("x");
        },
      },
    } as unknown as PageEnv;
    for (const v of VARIANTS) await servePage(new Request(`http://localhost:8787${v.path}`), env);
    expect(asked).toHaveLength(VARIANTS.length);
    const files = new Set([...open.keys()].map((rel) => rel.replace(/^public/, "").replace(/\.html$/, "")));
    for (const path of asked) {
      expect(path.length > 1 && path.endsWith("/"), path).toBe(false);
      expect(files.has(path === "/open" ? "/open/index" : path) || files.has(path), path).toBe(true);
    }
  });
});
