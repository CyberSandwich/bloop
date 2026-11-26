// Throwaway: /library screenshots for review (ci/l-shots only, never merged). Saved under test-results/shots/.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { test } from "@playwright/test";

const now = Date.now();
const MB = 1024 * 1024;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const d1 = (sql: string) => {
  const r = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "bloop", "--local", "--persist-to", ".wrangler/state", "--command", sql],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(r.stderr.slice(-400));
};

function seed(full: boolean, used = 0): string {
  const user = `shot-${randomUUID()}`;
  const cookie = `${user}-c`;
  const rows: string[] = [
    `INSERT INTO app_user (id, tid, oid, email, created_at, last_seen_at, email_norm, status, used_bytes) VALUES ('${user}', 'email', '${user}', '${user}@example.test', ${now}, ${now}, '${user}@example.test', 'active', ${used})`,
    `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at, public_id) VALUES ('${sha(cookie)}', '${user}', ${now}, ${now}, ${now + 86_400_000}, 'pub-${user}')`,
  ];
  if (full) {
    const long = `${"A very long lecture title that keeps going and going for the shots ".repeat(2).slice(0, 115)}.pptx`;
    const files: [string, string, number, Record<string, string | number>][] = [
      ["f1", "Lecture 5.pptx", 18 * MB, { selected_at: now - 100 }],
      ["f2", "Reading list.pdf", 2 * MB, { selected_at: now - 50, updated_at: now - 86_400_000 * 20 }],
      ["f3", "Lecture 6.pptx", 22 * MB, { updated_at: now - 1000 }],
      ["f4", "Seminar.docx", MB, { updated_at: now - 86_400_000 * 3 }],
      ["f5", "Results.xlsx", 340 * 1024, { updated_at: now - 86_400_000 * 5 }],
      ["f6", "Macro deck.pptm", 5 * MB, { updated_at: now - 86_400_000 * 6, refusal: "macros" }],
      ["f7", long, 9 * MB, { updated_at: now - 86_400_000 * 7 }],
      ["f8", "Dog.jpg", 3 * MB, { updated_at: now - 86_400_000 * 8, disabled_at: now }],
      ["t1", "Old talk.pptx", 4 * MB, { trashed_at: now, purge_after: now + 86_400_000 * 29 }],
    ];
    for (const [id, name, bytes, over] of files) {
      const row: Record<string, string | number> = {
        id: `${user}-${id}`,
        user_id: user,
        name,
        ext: name.split(".").pop() ?? "",
        bytes,
        version: 1,
        r2_key: `u/${user}/${id}/v1/orig`,
        status: "ready",
        created_at: now,
        updated_at: now,
        crc32: 0,
        ...over,
      };
      const v = Object.values(row).map((x) => (typeof x === "string" ? `'${x}'` : x));
      rows.push(`INSERT INTO library_file (${Object.keys(row).join(", ")}) VALUES (${v.join(", ")})`);
    }
    const d = (id: string, status: string, extra = "NULL, NULL") =>
      `INSERT INTO derived (file_id, version, owner_kind, status, pages, fonts_missing, created_at, updated_at) VALUES ('${user}-${id}', 1, 'library', '${status}', ${extra}, ${now}, ${now})`;
    rows.push(d("f3", "running"), d("f6", "failed"), d("f4", "done", `3, '["Aptos","Grandview"]'`));
  }
  d1(rows.join("; "));
  return cookie;
}

const SIZES: [number, number][] = [
  [320, 700],
  [390, 844],
  [430, 932],
  [844, 390],
  [834, 1112],
  [1440, 900],
  [1080, 1920],
];

for (const [width, height] of SIZES) {
  for (const state of ["empty", "full"] as const) {
    test(`shot ${state} ${width}x${height}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.setExtraHTTPHeaders({
        Cookie: `__Host-bloop_sid=${seed(state === "full", state === "full" ? 1.2 * 1024 * MB : 0)}`,
      });
      const page = await context.newPage();
      await page.goto("/library");
      await page
        .locator(state === "full" ? "#file-list > li.lib-item" : "#empty:not([hidden])")
        .first()
        .waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/shots/${state}-${width}x${height}.png`, fullPage: true });
      if (state === "full" && (width === 390 || width === 1440)) {
        await page.getByRole("button", { name: "More for Lecture 5.pptx" }).first().click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `test-results/shots/menu-${width}.png` });
        await page.keyboard.press("Escape");
        await page.locator(width === 390 ? "#present" : "#present-card").click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `test-results/shots/present-${width}.png` });
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: /^Trash · / }).click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `test-results/shots/trash-${width}.png`, fullPage: true });
      }
      await context.close();
    });
  }
}

test("shot near quota 390", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.setExtraHTTPHeaders({ Cookie: `__Host-bloop_sid=${seed(true, 4.6 * 1024 * MB)}` });
  const page = await context.newPage();
  await page.goto("/library");
  await page.locator("#file-list > li.lib-item").first().waitFor();
  await page.screenshot({ path: "test-results/shots/quota90-390.png" });
  await context.close();
});
