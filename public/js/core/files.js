// The phone's file list: GET /api/files (docs/architecture.md section 6).
/** @import {FileEntry} from "../../../src/shared/protocol.ts" */

/**
 * Until the file-source module serves /api/files, the Worker answers not_found and the list is the two
 * fixtures its stub approve route knows. Delete this constant and the branch below with that module.
 * @param {number} now
 * @returns {FileEntry[]}
 */
export const stubFiles = (now) => [
  { id: "demo-deck", name: "Sample deck.pptx", type: "pptx", modifiedAt: now - 10 * 60_000, size: null },
  { id: "demo-pdf", name: "Sample slides.pdf", type: "pdf", modifiedAt: now - 3 * 3_600_000, size: null },
];

/**
 * @param {import("./api.js").Api} api
 * @param {string} pid
 * @param {() => number} [now]
 * @returns {Promise<{ok: true, files: FileEntry[]} | {ok: false, error: import("../../../src/shared/protocol.ts").ErrorCode}>}
 */
export async function loadFiles(api, pid, now = Date.now) {
  const res = await api.get("/api/files", pid);
  if (res.ok) return { ok: true, files: Array.isArray(res.value?.files) ? res.value.files : [] };
  if (res.error === "not_found") return { ok: true, files: stubFiles(now()) };
  return res;
}
