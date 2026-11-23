// The phone's file list: GET /api/files (docs/architecture.md section 6).
/** @import {FileEntry} from "../../../src/shared/protocol.ts" */

/**
 * @param {import("./api.js").Api} api
 * @param {string} pid
 * @returns {Promise<{ok: true, files: FileEntry[]} | {ok: false, error: import("../../../src/shared/protocol.ts").ErrorCode}>}
 */
export async function loadFiles(api, pid) {
  const res = await api.get("/api/files", pid);
  if (!res.ok) return res;
  return { ok: true, files: Array.isArray(res.value?.files) ? res.value.files : [] };
}
