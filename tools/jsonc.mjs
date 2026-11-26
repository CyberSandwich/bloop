/**
 * Removes `//` and block comments from JSONC, leaving string contents (URLs hold `//`) alone.
 * @param {string} text
 */
export function stripJsonComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i) + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * @param {string} text JSONC without trailing commas
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}
