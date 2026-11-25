// One toast at a time: a title and a line, gone after 5 s or on a tap. An error is announced at once (role alert).
// The toast showing, passed again, stays as it is.

const SHOW_MS = 5000;
const OUT_MS = 200;

/** `tappedAway` runs when a tap dismisses it, never when it times out or another takes its place. @typedef {{title: string, body: string, error?: boolean, action?: {label: string, run: () => void}, tappedAway?: () => void}} Toast */

/** The slice of Document it uses, so the unit tests (no DOM) can fake it. @typedef {{createElement: (tag: string) => any, body: {append: (node: any) => void}}} Host */

/**
 * @param {Host} doc
 * @param {(fn: () => void, ms: number) => unknown} [later]
 * @param {(timer: unknown) => void} [cancel]
 * @returns {(t: Toast) => void}
 */
export function createToaster(
  doc,
  later = (fn, ms) => setTimeout(fn, ms),
  cancel = (t) => clearTimeout(/** @type {any} */ (t)),
) {
  /** @type {any} */
  let node = null;
  /** @type {unknown} */
  let timer = null;
  /** @type {Toast | null} */
  let last = null;

  const remove = () => {
    cancel(timer);
    node?.remove();
    node = null;
  };
  const dismiss = () => {
    if (!node) return;
    const leaving = node;
    leaving.classList.add("out");
    cancel(timer);
    timer = later(() => {
      if (node === leaving) remove();
    }, OUT_MS);
  };

  return (t) => {
    if (node && t === last) return;
    last = t;
    const { title, body, error = false, action } = t;
    remove();
    const made = doc.createElement("div");
    made.className = "toast glass";
    made.setAttribute("role", error ? "alert" : "status");
    const head = doc.createElement("strong");
    head.textContent = title;
    const line = doc.createElement("span");
    line.textContent = body;
    made.append(head, line);
    if (action) {
      const button = doc.createElement("button");
      button.className = "btn secondary";
      button.textContent = action.label;
      button.addEventListener("click", action.run);
      made.append(button);
    }
    made.addEventListener("click", () => {
      dismiss();
      t.tappedAway?.();
    });
    doc.body.append(made);
    node = made;
    if (!action) timer = later(dismiss, SHOW_MS);
  };
}

/** @type {ReturnType<typeof createToaster> | undefined} */
let shared;
/** @param {Toast} t */
export function toast(t) {
  shared ??= createToaster(/** @type {any} */ (globalThis).document);
  shared(t);
}
