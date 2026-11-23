// Landing glue (docs/design.md sections 6 to 9): nav CTA, Send Me the Link, the explorer, reveals, the fact
// QR and the robin. The renderer loads only after the load event, on idle, with a fine pointer and motion
// allowed; until then, and after any failure, the poster or still shows. The live demo is module i.
import { qrMatrix, qrPath } from "./core/qr.js";
import { bandFromTops, containProgress, STEPS, scrollPose, stepProgress } from "./core/robin-pose.js";
import { initNav, initShare } from "./site.js";

/** @typedef {Awaited<ReturnType<typeof import("./robin.js").mountRobin>>} Robin */

const root = document.documentElement;
root.classList.add("js");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
const saveData = !!(/** @type {{connection?: {saveData?: boolean}}} */ (navigator).connection?.saveData);
const mayAnimate = !reduced && !saveData;
const MESH = "/robin.bin";

initNav(document.getElementById("hero-actions"));
initShare();

/** @param {string} id @returns {HTMLElement} */
function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

/** Runs once the page has loaded and the browser is idle, so the renderer never competes with LCP. */
function afterLoadIdle(/** @type {() => void} */ fn) {
  const idle = () =>
    "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200);
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}

/** Calls fn the first time el comes within `margin` of the viewport. */
function whenNear(/** @type {Element} */ el, /** @type {string} */ margin, /** @type {() => void} */ fn) {
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      fn();
    },
    { rootMargin: margin },
  );
  io.observe(el);
}

/**
 * Mounts the renderer on a robin box; resolves null on any failure, leaving the poster in place.
 * @param {HTMLElement} box
 * @param {import("./robin.js").RobinOptions} opts
 * @returns {Promise<Robin | null>}
 */
async function mount(box, opts) {
  const canvas = box.querySelector("canvas");
  if (!canvas) return null;
  try {
    const { mountRobin } = await import("./robin.js");
    return await mountRobin(canvas, MESH, opts);
  } catch {
    return null;
  }
}

// ---- Hero robin ----
const heroBox = byId("hero-robin");
const orbit = byId("demo");
if (mayAnimate && fine) {
  whenNear(orbit, "0px", () => afterLoadIdle(() => void mount(heroBox, { tiltArea: orbit })));
} else if (mayAnimate) {
  // Touch: the 3D robin loads only on intent, from its Turn the Robin button.
  const button = byId("turn3d");
  button.hidden = false;
  /** @type {Robin | null | undefined} */
  let robin;
  button.addEventListener("click", async () => {
    if (robin === undefined) {
      robin = null;
      robin = await mount(heroBox, { control: heroBox });
    }
    robin?.turn(1);
  });
}

// ---- Fact QR: desktop only (CSS hides it on touch); it opens this page, never a session ----
if (fine) byId("fact-qr").setAttribute("d", qrPath(qrMatrix(`${location.origin}/`)));

// ---- Reveals: the devices in facts and story cards, never their text ----
if (!reduced) {
  root.classList.add("reveals");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    },
    { threshold: 0.15 },
  );
  for (const node of document.querySelectorAll(".reveal")) io.observe(node);
}

// ---- Pose explorer ----
const how = byId("how");
const scene = byId("how-scene");
const stepsEl = byId("steps");
const turnRow = byId("turn-row");
const howBox = byId("how-robin");
const still = /** @type {HTMLImageElement} */ (byId("how-still"));
const steps = /** @type {HTMLElement[]} */ ([...stepsEl.querySelectorAll(".step")]);
const buttons = steps.map((s) => /** @type {HTMLButtonElement} */ (s.querySelector(".step-btn")));
const pinned = matchMedia("(min-width: 600px)");
/** @type {Robin | null} */
let howRobin = null;
let current = 0;

/** Opens one step, collapses the rest; the open button is the group's one tab stop. */
function open(/** @type {number} */ step, /** @type {{tween?: boolean}} */ opts = {}) {
  current = step;
  steps.forEach((node, i) => {
    const on = i === step;
    node.classList.toggle("is-open", on);
    const button = buttons[i];
    if (!button) return;
    button.setAttribute("aria-expanded", String(on));
    button.tabIndex = on ? 0 : -1;
  });
  steps[step]?.querySelector(".step-panel")?.append(turnRow);
  const name = STEPS[step];
  if (!name) return;
  if (howRobin && opts.tween) howRobin.setPose(name);
  if (!howRobin) still.src = `/img/robin-${name}-560.webp`;
}

/** Scrolls the pinned scene to the middle of a step's band, so scroll and the open card agree. */
function scrollToStep(/** @type {number} */ step) {
  const top = scene.getBoundingClientRect().top + scrollY;
  const span = scene.offsetHeight - innerHeight;
  scrollTo({ top: top + stepProgress(step) * span, behavior: reduced ? "auto" : "smooth" });
}

function choose(/** @type {number} */ step) {
  open(step, { tween: true });
  if (how.classList.contains("is-pinned")) scrollToStep(step);
}

if (mayAnimate) {
  how.classList.add("is-live");
  const setPinned = () => how.classList.toggle("is-pinned", pinned.matches);
  setPinned();
  pinned.addEventListener("change", setPinned);
  open(0);

  buttons.forEach((button, i) => {
    button.addEventListener("click", () => choose(i));
    button.addEventListener("keydown", (e) => {
      const last = buttons.length - 1;
      const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: last }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const target = (next + buttons.length) % buttons.length;
      choose(target);
      buttons[target]?.focus();
    });
  });

  if (fine) {
    whenNear(how, "400px 0px", () =>
      afterLoadIdle(async () => {
        howRobin = await mount(howBox, {
          control: howBox,
          pose: STEPS[current] ?? "look",
          onTurn: (offset) => howBox.setAttribute("aria-valuenow", String(Math.round((offset * 180) / Math.PI))),
        });
        if (!howRobin) return;
        howBox.setAttribute("role", "slider");
        howBox.setAttribute("tabindex", "0");
        howBox.setAttribute("aria-label", "Turn the Robin");
        howBox.setAttribute("aria-valuemin", "-180");
        howBox.setAttribute("aria-valuemax", "180");
        howBox.setAttribute("aria-valuenow", "0");
        turnRow.hidden = false;
        byId("turn-left").addEventListener("click", () => howRobin?.turn(-1));
        byId("turn-right").addEventListener("click", () => howRobin?.turn(1));
      }),
    );
  }
  followScroll();
}

/**
 * Scroll picks the band and drives the blend: a ViewTimeline read in a frame loop while the scene is in
 * view, else band sentinels on an IntersectionObserver stepping with a tween. Never a scroll listener.
 */
function followScroll() {
  const Timeline = /** @type {any} */ (globalThis).ViewTimeline;
  if (Timeline) {
    const timeline = new Timeline({ subject: scene, axis: "block" });
    let running = false;
    const tick = () => {
      if (!running) return;
      requestAnimationFrame(tick);
      if (!how.classList.contains("is-pinned")) return;
      const time = timeline.currentTime;
      if (!time || typeof time.value !== "number") return;
      const p = containProgress(time.value / 100, scene.offsetHeight, innerHeight);
      const { step, weights } = scrollPose(p);
      if (step !== current) open(step);
      howRobin?.setPose(weights, { t: 1 });
    };
    new IntersectionObserver(([entry]) => {
      running = !!entry?.isIntersecting;
      if (running) requestAnimationFrame(tick);
    }).observe(scene);
    return;
  }
  const bands = /** @type {HTMLElement[]} */ (
    STEPS.map(() => {
      const band = document.createElement("div");
      band.className = "band";
      band.setAttribute("aria-hidden", "true");
      scene.append(band);
      return band;
    })
  );
  // The root is a thin line at the viewport top, so a band fires as it passes it.
  const io = new IntersectionObserver(
    () => {
      if (!how.classList.contains("is-pinned")) return;
      const step = bandFromTops(bands.map((b) => b.getBoundingClientRect().top));
      if (step !== current) open(step, { tween: true });
    },
    { rootMargin: "0px 0px -99% 0px" },
  );
  for (const band of bands) io.observe(band);
}
