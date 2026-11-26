// What the phone tells of a guest's file before sending it, by its name and size; the send is core/send.js's.
import { typeOfName } from "../shared/names.js";

const MB = 1024 * 1024;
/** Not a type bloop stores: a HEIC is sent only as the JPEG this browser can make of it (design.md, Upload). */
export const HEIC = /\.(heic|heif)$/i;

/** @param {number} bytes @returns {number} whole megabytes, rounded down, at least 1 */
export const wholeMB = (bytes) => Math.max(1, Math.floor(bytes / MB));

/**
 * What the phone does with a file before sending it, by its name; null for a type bloop refuses.
 * @param {string} name
 * @returns {"photo" | "video" | "file" | null}
 */
export function kindOf(name) {
  if (HEIC.test(name)) return "photo";
  const type = typeOfName(name);
  if (type === "jpg" || type === "png") return "photo";
  if (type === "mp4" || type === "mov") return "video";
  return type && "file";
}

/**
 * What the phone can tell before sending a byte: the extension, and the size (a photo's is checked once it is
 * compressed). The server checks both again, and the bytes themselves (DROP-02).
 * @param {{name: string, size: number}} file
 * @param {number} maxBytes
 * @returns {"type" | "empty" | "large" | null} why not, or null
 */
export function fileProblem(file, maxBytes) {
  const kind = kindOf(file.name);
  if (!kind) return "type";
  if (file.size === 0) return "empty";
  return file.size > maxBytes && kind !== "photo" ? "large" : null;
}
