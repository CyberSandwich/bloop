// Send Me the Link (docs/design.md section 7): the share sheet, else the clipboard, else a mail draft.
// Pure apart from the seams passed in, so the ladder is unit tested.

/**
 * @typedef {object} ShareSeams
 * @property {((data: {title: string, text: string, url: string}) => Promise<void>) | undefined} share navigator.share, bound
 * @property {((text: string) => Promise<void>) | undefined} copy navigator.clipboard.writeText, bound
 * @property {(href: string) => void} open sets location.href
 */

/** @param {string} url */
export const shareText = (url) => `Try bloop on a computer: ${url}`;

/** @param {string} url */
export const mailtoFor = (url) => `mailto:?subject=bloop&body=${encodeURIComponent(url)}`;

/**
 * @param {ShareSeams} seams
 * @param {{title: string, url: string}} page
 * @returns {Promise<"shared" | "copied" | "mailto" | "canceled">}
 */
export async function shareLink(seams, page) {
  if (seams.share) {
    try {
      await seams.share({ title: page.title, text: shareText(page.url), url: page.url });
      return "shared";
    } catch (e) {
      // The visitor closed the sheet: do nothing more. Any other failure falls through to the clipboard.
      if (e instanceof Error && e.name === "AbortError") return "canceled";
    }
  }
  if (seams.copy) {
    try {
      await seams.copy(page.url);
      return "copied";
    } catch {
      // No clipboard permission: the mail draft below.
    }
  }
  seams.open(mailtoFor(page.url));
  return "mailto";
}
