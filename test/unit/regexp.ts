/** `s` as a RegExp source that matches it literally: every metacharacter, backslash included, is escaped. */
export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
