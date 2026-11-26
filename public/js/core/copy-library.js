// The library's strings (docs/ux/library.md section 11, states.md section 3, present-live.md sections 1 and 2; the rules:
// copy.js). Numbers come from the list answer, never from a constant here.

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** One decimal under 10, whole above, never a trailing ".0" (upload.md, Units). @param {number} n */
const short = (n) => (n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n)));

/** A file's size: "340 KB", "2 MB", "3.4 MB", "1.2 GB". @param {number} bytes */
export function sizeText(bytes) {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  if (bytes < GB) return `${short(bytes / MB)} MB`;
  return `${short(bytes / GB)} GB`;
}

/** The limit with its unit: "5 GB". @param {number} limit */
const limitText = (limit) => (limit >= GB ? `${short(limit / GB)} GB` : sizeText(limit));

/** The amount used, in the limit's GB from 1 GB ("1.2"), in MB under it ("340 MB"), a bare 0 when nothing is stored. */
const usedText = (/** @type {number} */ bytes) =>
  bytes <= 0 ? "0" : bytes < GB ? `${Math.max(1, Math.round(bytes / MB))} MB` : short(bytes / GB);

/** The bar's share: used plus reserved, so a failed upload never moves it backward. @param {{used: number, reserved: number, limit: number}} q */
export const quotaShare = (q) => (q.limit > 0 ? (q.used + q.reserved) / q.limit : 1);

/**
 * The quota line (library.md section 7): "1.2 of 5 GB used", "340 MB of 5 GB used", and from 90 percent of the bar
 * the way to get room after it.
 * @param {{used: number, reserved: number, limit: number}} q
 */
export function quotaLine(q) {
  const text = `${usedText(q.used)} of ${limitText(q.limit)} used`;
  return quotaShare(q) >= 0.9 ? `${text}. Delete files or empty the trash to add more.` : text;
}

/** "Trash uses 240 MB of your 5 GB." @param {number} bytes @param {number} limit */
export const trashUses = (bytes, limit) => `Trash uses ${sizeText(Math.max(bytes, 1))} of your ${limitText(limit)}.`;

/** "A talk takes up to 12 files. Untick one first." @param {number} max */
export const fullLine = (max) => `A talk takes up to ${max} files. Untick one first.`;

/** The kind's word and its glyph's name in library/glyphs.js, by extension. */
const KINDS = /** @type {Record<string, [string, string]>} */ ({
  pptx: ["PowerPoint", "presentation"],
  pptm: ["PowerPoint", "presentation"],
  ppt: ["PowerPoint", "presentation"],
  pdf: ["PDF", "file-text"],
  docx: ["Word document", "file-text"],
  doc: ["Word document", "file-text"],
  txt: ["Text", "file-text"],
  md: ["Text", "file-text"],
  xlsx: ["Excel spreadsheet", "file-spreadsheet"],
  xls: ["Excel spreadsheet", "file-spreadsheet"],
  csv: ["CSV spreadsheet", "file-spreadsheet"],
  jpg: ["JPEG image", "image"],
  jpeg: ["JPEG image", "image"],
  png: ["PNG image", "image"],
  gif: ["GIF image", "image"],
  webp: ["WebP image", "image"],
  heic: ["HEIC image", "image"],
  mp4: ["MP4 video", "film"],
  mov: ["QuickTime video", "film"],
  webm: ["WebM video", "film"],
});

/** @param {string} ext @returns {{word: string, glyph: string}} */
export function kindOf(ext) {
  const [word, glyph] = KINDS[ext.toLowerCase()] ?? ["File", "file-text"];
  return { word, glyph };
}

/** A deck, document or PDF: shown as slides or pages, so its tile is contained. @param {string} ext */
export const isPaged = (ext) =>
  ["presentation", "file-text"].includes(kindOf(ext).glyph) && !["txt", "md"].includes(ext);

const DAY_MS = 86_400_000;

/** "3 Nov", the short date of every row and card. @param {number} ms @param {string} [timeZone] */
export const dayMonth = (ms, timeZone) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) }).format(ms);

/** @param {number} ms @param {string} [timeZone] */
const clockOf = (ms, timeZone) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).format(ms);

/**
 * The date part of line 2: "Edited today", "Edited 3 Nov", or "Presented 10:02" when presenting was the last thing done
 * (its date instead of its time on an earlier day).
 * @param {{updatedAt: number, lastPresentedAt?: number}} row @param {number} now @param {string} [timeZone]
 */
export function dateText(row, now, timeZone) {
  const presented = row.lastPresentedAt !== undefined && row.lastPresentedAt > row.updatedAt;
  const at = presented ? /** @type {number} */ (row.lastPresentedAt) : row.updatedAt;
  const today = dayMonth(at, timeZone) === dayMonth(now, timeZone) && now - at < DAY_MS;
  if (presented) return `Presented ${today ? clockOf(at, timeZone) : dayMonth(at, timeZone)}`;
  return `Edited ${today ? "today" : dayMonth(at, timeZone)}`;
}

/** The reason under "Can't Show Slides", by the converter's or the validator's code. @param {string | undefined} code */
export function reasonOf(code) {
  if (code === "macros") return "This file has macros.";
  if (code === "encrypted" || code === "password") return "This file is password protected.";
  if (code === "damaged" || code === "corrupt") return "This file is damaged.";
  return "This file type can't be shown in bloop.";
}

export const DISABLED_REASON = "This file was disabled after a report.";

/** "Missing 2 Fonts". @param {number} n */
export const fontsNote = (n) => `Missing ${n} ${n === 1 ? "Font" : "Fonts"}`;

/**
 * The preview's font warning (library.md section 5): one, two or three names, else the count.
 * @param {string[]} names
 */
export function fontSentence(names) {
  const tail = "so a close match is used. PowerPoint on the room PC may have";
  if (names.length === 1) return `${names[0]} isn't on bloop's slides, ${tail} it.`;
  const who =
    names.length > 3 ? `${names.length} fonts` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${who} aren't on bloop's slides, ${tail} them.`;
}

/** "Deletes in 29 days", "Deletes tomorrow"; `soon` under 3 days. @param {number} purgeAfter @param {number} now */
export function deletesIn(purgeAfter, now) {
  const days = Math.max(1, Math.ceil((purgeAfter - now) / DAY_MS));
  return { text: days === 1 ? "Deletes tomorrow" : `Deletes in ${days} days`, soon: days < 3 };
}

/** @param {number} n */
export const filesWord = (n) => `${n} ${n === 1 ? "file" : "files"}`;

/** "Files here are deleted for good after 30 days." @param {number} days */
export const trashRule = (days) => `Files here are deleted for good after ${days} days.`;

/** @param {number} days */
export const trashEmptyLine = (days) => `Files you delete stay here for ${days} days.`;

/** @param {number} n */
export const emptyTrashLine = (n) =>
  `${filesWord(n).replace(/^./, (c) => c.toUpperCase())} ${n === 1 ? "is" : "are"} deleted for good. This can't be undone.`;

/** "Lecture 5.pptx, position 2 of 3": the polite announcement of a move. */
export const positionText = (/** @type {string} */ name, /** @type {number} */ at, /** @type {number} */ of) =>
  `${name}, position ${at} of ${of}`;

/** "Your account is deleted on 2 Dec." @param {number} at */
export const deletingLine = (at) => `Your account is deleted on ${dayMonth(at)}.`;

/** "12 of 40 Slides" while the converter counts, else "Preparing Slides". @param {number | undefined} done @param {number | undefined} total */
export const preparingText = (done, total) => (total ? `${done ?? 0} of ${total} Slides` : "Preparing Slides");

/** "Open bloop.here/s on the room PC, then scan its code with your camera." @param {string} host */
export const presentLine = (host) => `Open ${host}/s on the room PC, then scan its code with your camera.`;

/** @param {string} name */
export const stillUploading = (name) => `${name} is still uploading. Keep this page open until it says Saved.`;

/** "24 slides", "1 page". @param {string} ext @param {number} n */
export const pagesWord = (ext, n) => {
  const unit = kindOf(ext).glyph === "presentation" ? "slide" : "page";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};

/** Every fixed string. */
export const T = {
  title: "Library",
  trashTitle: "Trash",
  upNext: "Up Next",
  allFiles: "All Files",
  moreFor: "More for ",
  upNextFor: "Up Next: ",
  storage: "Storage used",
  preparing: "Preparing Slides",
  cantShow: "Can't Show Slides",
  unavailable: "Unavailable",
  movedTitle: "Moved to Trash",
  undo: "Undo",
  cleared: "Up Next Cleared",
  fullTitle: "Up Next Is Full",
  restored: "Restored",
  folders: "Folders Can't Be Added",
  foldersBody: "Drop the files inside it instead.",
  gone: "This File Was Moved to Trash",
  notLoaded: "That Didn't Load",
  reloadLine: "Reload the page, then try again.",
  reload: "Reload",
  uploadNotLoaded: "Upload Didn't Load",
  notSaved: "That Didn't Save",
  checkConnection: "Check your connection, then try again.",
  offline: "You're Offline",
  offlineBody: "Your library will update when you're back.",
  paused: "Uploads Are Paused",
  pausedBody: "Your files still present and download. Try again later.",
  noSpace: "Not Enough Space",
  noSpaceBody: "Delete files or empty the trash to add this one.",
  slow: "Still loading your library.",
  failedTitle: "Your Library Didn't Load",
  tryAgain: "Try Again",
  emptyTitle: "Add Your First File",
  emptyBody:
    "Decks, PDFs, documents, spreadsheets, photos and videos. Files stay yours: stored in the EU, deleted when you say.",
  addFiles: "Add Files",
  sample: "Add the Sample Deck",
  present: "Present",
  opensFirst: "Opens First: ",
  cancelDeletion: "Cancel Deletion",
  trashEmpty: "The Trash Is Empty",
  download: "Download",
  rename: "Rename",
  addUp: "Add to Up Next",
  removeUp: "Remove from Up Next",
  previewPreparing: "Preparing slides. You can still present it in PowerPoint.",
  previewSlow: "This one is taking longer than usual.",
  dropHint: "Drop Files to Add Them",
};
