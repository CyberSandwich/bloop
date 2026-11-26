// The launch mode a project runs in (ADR 0026). `open-setup` and `preview-restore` flip it in the dev server's local D1;
// TEST_TIMING (set in playwright.config.ts) turns the Worker's 30 s cache off, so the next request sees it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

export type Mode = "preview" | "open";

const root = fileURLToPath(new URL("../..", import.meta.url));

export function setLaunchMode(mode: Mode): void {
  const sql = `INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES ('launch_mode', '${mode}', 0)`;
  const done = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "bloop", "--local", "--persist-to", ".wrangler/state", "--command", sql],
    { cwd: root, encoding: "utf8" },
  );
  if (done.status !== 0) throw new Error(`setting the launch mode failed:\n${done.stdout}${done.stderr}`);
}

/** `test` with the project's mode as an option: a spec reads it to pick what the page should hold. */
export const test = base.extend<{ mode: Mode }>({ mode: ["preview", { option: true }] });
export { expect } from "@playwright/test";
