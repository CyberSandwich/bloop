// The upload toasts (docs/ux/upload.md section 4) on top of core/toast.js: with a `status` the title is one line, the
// name ellipsized and then " · status"; `say` is the sentence only a screen reader gets. Kept out of toast.js so the
// phone's first load does not carry it.

import { splitName } from "./format.js";
import { toast as show } from "./toast.js";

/** @typedef {Omit<Parameters<typeof show>[0], "title"> & {title: string, status?: string, say?: string}} UploadToast */

/** @param {UploadToast} t */
export function toast({ title, status, say, ...rest }) {
  /** @param {string} className @param {string} text */
  const span = (className, text) => {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  };
  const [start, end] = splitName(title);
  const node = document.createDocumentFragment();
  if (status === undefined) node.append(title);
  else node.append(span("head", start), span("tail", end), span("st", ` · ${status}`));
  if (say) node.append(span("sr", say));
  show({ ...rest, title: node });
}
