// Typed code entry (/code): for a phone whose camera did not open the link.
import { createApi } from "./core/api.js";
import { TYPED_LETTERS, typedError } from "./core/copy-code.js";
import { PID_KEY, pidStore } from "./core/store.js";
import { typedCode, typedValid } from "./core/typed.js";
import { ariaFlag, byId, focusTitle, isFramed, setText } from "./core/ui.js";
import { ERRORS } from "./shared/errors.js";

const api = createApi();
const store = pidStore();

const form = byId("code-form");
const input = /** @type {HTMLInputElement} */ (byId("code"));
const go = /** @type {HTMLButtonElement} */ (byId("go"));
const errorLine = byId("code-error");
const errorText = byId("code-error-text");
let busy = false;

function showError(/** @type {string} */ text) {
  setText(errorText, text);
  errorLine.classList.toggle("is-on", text !== "");
  ariaFlag(input, "aria-invalid", text !== "");
}

input.addEventListener("input", () => {
  const formatted = typedCode(input.value);
  if (formatted !== input.value) input.value = formatted;
  go.disabled = typedValid(input.value) === null || busy;
  // The alphabet leaves out the look-alikes: say so as soon as one is typed.
  showError(/[01ILOU]/.test(input.value) ? TYPED_LETTERS : "");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = typedValid(input.value);
  if (!code || busy) return;
  busy = true;
  go.disabled = true;
  const res = await api.post("/api/claim", { code });
  busy = false;
  if (res.ok) {
    store.set(PID_KEY, res.value.pid);
    location.assign("/a");
    return;
  }
  go.disabled = typedValid(input.value) === null;
  showError(typedError(ERRORS[res.error].phone ?? "error"));
  input.focus();
});

if (isFramed()) {
  form.hidden = true;
  setText(byId("title"), typedError("framed"));
  focusTitle(byId("title"));
}
