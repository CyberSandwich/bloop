// Pure: /a and the Worker's error page.
import { SUPPORT } from "./errors.js";

/**
 * The support mail, here and on the error page (design.md section 3): prompts, then facts. Only these keys, so no
 * credential or file name gets in; Page is the path, never the URL.
 * @param {string} subject
 * @param {{Page: string, State: string, Error: string | null, Time: string, Browser: string}} facts
 */
export const supportMail = (subject, facts) =>
  `mailto:${SUPPORT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    `What were you trying to do?\n\n\nWhat happened?\n\n\n${Object.entries(facts)
      .map((f) => f.join(": "))
      .join("\n")}`,
  )}`;
