// Pairing code alphabet and input handling. Pure: shared by the browser and the Worker.

// 30 symbols: no 0 O 1 I L U. 6 symbols = 30^6, about 7.3e8 (29.4 bits). CODE_LENGTH may rise to 7.
export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * @param {string} raw
 * @returns {string | null} upper-cased, spaces and dashes removed; O->0 is not mapped
 */
export function normalize(raw) {
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  return /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6,7}$/.test(s) ? s : null;
}

/**
 * @param {string} code
 * @returns {string} "K7M Q9X"
 */
export function format(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
