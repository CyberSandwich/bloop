// Shared by the landing, /it and /privacy: the nav CTA, Send Me the Link, and the toast.
import { shareLink } from "./core/share.js";

const TOAST_MS = 4000;

/** Hidden means `visibility:hidden` (out of the accessibility tree, space kept) plus tabindex -1. */
function setCta(/** @type {HTMLElement} */ cta, /** @type {boolean} */ visible) {
  cta.classList.toggle("is-hidden", !visible);
  for (const link of cta.querySelectorAll("a, button")) {
    if (visible) link.removeAttribute("tabindex");
    else link.setAttribute("tabindex", "-1");
  }
}

/**
 * The nav CTA stays hidden (space kept) while the hero's own actions are in view, so the first view never
 * shows two primary buttons. A page with no hero actions shows it at once.
 * @param {Element | null} heroActions
 */
export function initNav(heroActions) {
  const cta = document.getElementById("nav-cta");
  if (!cta) return;
  if (!heroActions) {
    setCta(cta, true);
    return;
  }
  new IntersectionObserver(([entry]) => setCta(cta, !entry?.isIntersecting)).observe(heroActions);
}

/** @type {HTMLElement | null} */
let toastEl = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;

/** A bottom toast, `role="status"`, gone after 4 s; hovering or focusing it holds it. @param {string} text */
export function toast(text) {
  if (!toastEl) {
    const node = document.createElement("div");
    node.className = "toast";
    node.setAttribute("role", "status");
    node.addEventListener("pointerenter", () => clearTimeout(toastTimer));
    node.addEventListener("pointerleave", () => arm());
    document.body.append(node);
    toastEl = node;
  }
  toastEl.textContent = text;
  toastEl.classList.add("is-shown");
  arm();
}

function arm() {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl?.classList.remove("is-shown"), TOAST_MS);
}

/** Wires every `[data-share]` button. */
export function initShare() {
  for (const button of document.querySelectorAll("[data-share]")) {
    button.addEventListener("click", async () => {
      const url = `${location.origin}/`;
      const outcome = await shareLink(
        {
          share: navigator.share ? (data) => navigator.share(data) : undefined,
          copy: navigator.clipboard ? (text) => navigator.clipboard.writeText(text) : undefined,
          open: (href) => {
            location.href = href;
          },
        },
        { title: document.title, url },
      );
      if (outcome === "copied") toast("Link Copied");
    });
  }
}
