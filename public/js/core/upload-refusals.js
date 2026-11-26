// What each refusal says (docs/ux/upload.md section 4): one string per error code the upload routes can answer.
/** @param {string} name "Talk.pptm" @returns {string} the extension of its macro-free twin, ".pptx" */
const plain = (name) => `.${/\.(\w{3})m$/i.exec(name)?.[1] ?? "ppt"}x`;

const FEW_MINUTES = "Try again in a few minutes.";
/** Refusals with a title of their own (docs/ux/upload.md section 4): the title, then the line. @type {Record<string, [string, string]>} */
const OWN = {
  bad_type: [
    "This File Type Isn't Supported",
    "bloop takes decks, documents, PDFs, spreadsheets, text, photos and videos.",
  ],
  empty: ["This File Is Empty", ""],
  quota_exceeded: ["Not Enough Space", "Delete files or empty the trash to add this one."],
  library_full: ["Your Library Is Full", "Delete files you no longer need, then add this one."],
  rate_limited: ["Too Many Uploads Right Now", "Wait a minute, then try again."],
  service_busy: ["bloop Is Busy Right Now", FEW_MINUTES],
  unauthorized: ["Sign In to Add Files", "Your sign-in ended. Sign in again, then add the file."],
};
/** Refusals titled "{name} Can't Be Added": the line, or a function of the name. @type {Record<string, string | ((name: string) => string)>} */
const CANT = {
  internal: `bloop hit a problem adding this file. ${FEW_MINUTES}`,
  forbidden_origin: "This page can't add files. Reload it, then try again.",
  unsupported_media_type: "bloop couldn't read this file as sent. Add it again.",
  service_down: `Something's wrong on bloop's side. ${FEW_MINUTES}`,
  upload_busy: "bloop is still finishing this upload. Wait a moment, then try again.",
  upload_gone: "This upload ended before it finished. Add the file again.",
  upload_aborted: "The upload was stopped. Add the file again.",
  size_mismatch: "This file changed while it was being added. Add it again.",
  length_required: "bloop couldn't read this file's size. Choose it again.",
  bad_request: "bloop couldn't take this file as sent. Add it again.",
  not_found: "bloop can't find this upload. Add the file again.",
  macro_content: (name) => `This file has macros. Save a copy without them as ${plain(name)}.`,
  encrypted: "This file is password protected. Remove the password, then add it again.",
  bad_structure: "This file is damaged. Open it on your computer and save it again.",
};

/**
 * The toast for a refused file. A code with no string reads as the plain "Can't Be Added".
 * @param {string} name
 * @param {string} code
 * @param {number | undefined} maxMB the library's file cap, from the API
 * @returns {{title: string, body: string}}
 */
export function refusalToast(name, code, maxMB) {
  if (code === "too_large")
    return {
      title: "File Too Large",
      body: maxMB ? `bloop takes files up to ${maxMB} MB.` : "This file is over bloop's size limit.",
    };
  if (Object.hasOwn(OWN, code)) {
    const [title, body] = /** @type {[string, string]} */ (OWN[code]);
    return { title, body };
  }
  const line = (Object.hasOwn(CANT, code) && CANT[code]) || "Try again in a moment.";
  return { title: `${name} Can't Be Added`, body: typeof line === "function" ? line(name) : line };
}
