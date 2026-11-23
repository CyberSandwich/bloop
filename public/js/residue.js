// What the screen page forgets when a session ends (docs/interfaces.md section 6). The server side (links
// revoked, `Clear-Site-Data: "storage"` on the screen's own end) does not depend on this running.
import { SID_KEY } from "./core/store.js";

/** What a web page cannot clean: surfaced on /it and measured per room (field check T20). */
export const BEYOND_REACH = [
  "downloads_folder",
  "office_recent_list",
  "office_cache",
  "jump_lists",
  "browser_download_history",
  "temp_internet_files",
];

/**
 * @param {object} deps
 * @param {{remove(key: string): void}} deps.store the page's session store
 * @param {{reset(): void}} deps.launcher drops links and closes the PDF window
 * @param {Pick<Storage, "length" | "key" | "removeItem"> | null} deps.storage the raw sessionStorage, to sweep `bloop.*` keys
 * @param {() => void} deps.cleanUrl drop anything but the path and the mode from the address bar
 */
export function createResidue({ store, launcher, storage, cleanUrl }) {
  return {
    beyondReach: BEYOND_REACH,

    /** Runs on `ended` and `closed`. Idempotent. */
    clear() {
      launcher.reset();
      store.remove(SID_KEY);
      try {
        const keys = Array.from({ length: storage?.length ?? 0 }, (_, i) => storage?.key(i) ?? "");
        for (const key of keys) if (key.startsWith("bloop.")) storage?.removeItem(key);
      } catch {
        // storage blocked: nothing was stored
      }
      cleanUrl();
    },
  };
}
