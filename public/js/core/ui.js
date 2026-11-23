// Small DOM helpers shared by the pages. Never innerHTML: the CSP requires Trusted Types, which this
// site disables, so every node is built with the DOM API and text goes in as text.

/** @param {string} id @returns {HTMLElement} */
export function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

/** @param {HTMLElement} el @param {string} text */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** @param {HTMLElement} el @param {boolean} visible */
export function show(el, visible) {
  el.hidden = !visible;
}

/**
 * ARIA states are enumerated, not boolean attributes: an empty value reads as false, so `toggleAttribute`
 * cannot set one (test/unit/pages.test.ts bans it). On writes "true"; off removes the attribute.
 * @param {Element} el @param {`aria-${string}`} name @param {boolean} on
 */
export function ariaFlag(el, name, on) {
  if (on) el.setAttribute(name, "true");
  else el.removeAttribute(name);
}

/** Moves focus to a heading, which is made focusable by tabindex="-1" in the HTML. */
export function focusTitle(/** @type {HTMLElement} */ title) {
  title.focus({ preventScroll: true });
}

/** True when a state change took the focused control away, so focus must land somewhere sensible. */
export function lostFocus() {
  const active = document.activeElement;
  return !active || active === document.body || !document.body.contains(active);
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string>} [attrs]
 * @param {(Node | string)[]} [children]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const SVG = "http://www.w3.org/2000/svg";

/** A Lucide icon (24 viewBox, stroke 2) from path data. */
export function icon(/** @type {string[]} */ paths, size = 24) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: String(size),
    height: String(size),
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    class: "icon",
  })) {
    svg.setAttribute(k, v);
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export const ICON_CHECK = ["M20 6 9 17l-5-5"];

/** Runs `fn` at most once per animation frame. */
export function frameThrottle(/** @type {() => void} */ fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

/** True when a page is framed. The headers forbid it; this is the fallback for a browser that ignores them. */
export const isFramed = () => {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
};

/** "ws" or "wss" URL for a path on this origin. */
export const wsUrl = (/** @type {string} */ path) =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
