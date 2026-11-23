// The phone's file list: GET /api/files (docs/architecture.md section 6).
/** @import {Entry, FileEntry} from "../../../src/shared/protocol.ts" */

/**
 * @param {import("./api.js").Api} api
 * @param {string} pid
 * @returns {Promise<{ok: true, files: FileEntry[]} | {ok: false, error: import("../../../src/shared/protocol.ts").ErrorCode}>}
 */
export async function loadFiles(api, pid) {
  const res = await api.get("/api/files", pid);
  if (!res.ok) return res;
  /** @type {Entry[]} */
  const items = Array.isArray(res.value?.items) ? res.value.items : [];
  // The page still lists files only; links reach the list with the items UI.
  return { ok: true, files: items.filter((e) => e.kind === "file") };
}
