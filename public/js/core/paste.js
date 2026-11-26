// Paste on /code, lazy: the last code-shaped run in the clipboard text goes through the page's own check(), the path
// typed text takes. It never submits, and text typed while the read was out wins.
import { TYPED_PASTE } from "./copy-code.js";
import { typedValid } from "./typed.js";

/**
 * @param {HTMLInputElement} input
 * @param {() => void} check
 * @param {(text: string) => void} showError
 * @param {string} tapped the field's value at the tap, before this module loaded
 */
export async function pasteInto(input, check, showError, tapped) {
  const text = await navigator.clipboard.readText().catch(() => "");
  const code = text
    .match(/\b\w{3}[ -]?\w{3,4}\b/g)
    ?.reverse()
    .find(typedValid);
  if (input.value !== tapped) return;
  if (code) {
    input.value = code;
    check();
  } else showError(TYPED_PASTE);
}
