// wrangler.jsonc as an object, for the tools (land.mjs, live-check.mjs) and the tests that read it.

/** Removes `//` and block comments from JSONC, leaving string contents (URLs hold `//`) alone. */
export function stripJsonComments(/** @type {string} */ text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** @param {string} text @returns {Record<string, any>} */
export const wranglerConfig = (text) => JSON.parse(stripJsonComments(text));
