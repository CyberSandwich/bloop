// wrangler.jsonc as an object, for tools that read it (land.mjs, live-check.mjs). Full-line comments are the only
// comments the file holds; an inline one makes this throw rather than misread.

/** @param {string} text @returns {Record<string, any>} */
export const wranglerConfig = (text) =>
  JSON.parse(
    text
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  );
