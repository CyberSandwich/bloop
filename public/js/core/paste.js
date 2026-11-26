// Paste on /code, lazy: the last code-shaped run in the clipboard text goes through the page's own check(), the path
// typed text takes. It never submits, and text typed while the read was out wins.
import { TYPED_PASTE } from "./copy-code.js";
import { typedValid } from "./typed.js";

/**
 * @param {HTMLInputElement} input
 * @param {() => void} check
 * @param {(text: string) => void} showError
 */
export async function pasteInto(input, check, showError) {
  const before = input.value;
  const text = await navigator.clipboard.readText().catch(() => "");
  const code = text
    .match(/\b\w{3}[ -]?\w{3,4}\b/g)
    ?.reverse()
    .find(typedValid);
  if (input.value !== before) return;
  if (code) {
    input.value = code;
    check();
  } else showError(TYPED_PASTE);
}
