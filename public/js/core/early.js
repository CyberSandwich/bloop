// A live code a signed-out owner claimed (`auth_required`, nothing spent; present-live.md 5): in preview, or when
// /api/me cannot say open, the same code as a guest; in open mode the early-access state, whose Sign In keeps the
// code in this tab, since /auth/callback lands on /a with none; back on /a, the claim again. Lazy: loaded on that
// answer, or on a kept code; phone.js keeps a working fallback if this cannot load.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
/** @import {EarlyIo, PhoneAction, Words} from "../types.js" */
/** @import {createStore} from "./store.js" */
import { KEPT } from "./boot-code.js";
import { WAITLIST_FORM } from "./copy.js";
import { phoneCopy } from "./copy-phone.js";

/** Reading order, the primary last (copy-phone.js); stacked, app.css puts Sign In on top. @type {PhoneAction[]} */
const EARLY = [
  { id: "demo", label: "Try the Demo", kind: "text", href: "/demo" },
  { id: "waitlist", label: "Join the Waitlist", kind: "text", href: `${WAITLIST_FORM}?source=phone`, waitlist: true },
  { id: "guest", label: "Send One File", kind: "secondary" },
  { id: "signin", label: "Sign In", kind: "primary" },
];

/** The words for the keys this module owns, in the expired state's shape (no list, no room); null for the rest. @type {Words} */
export function words(key) {
  const expired = phoneCopy("expired", { room: "", file: null });
  if (key === "early")
    return {
      ...expired,
      title: "Early Access Only",
      body: "Sign in to present your own files. No invite yet? You can still send one file to this screen.",
      actions: EARLY,
    };
  if (key === "rescan")
    return {
      ...expired,
      title: "Scan the Screen Again",
      body: "The code changed while you signed in. You're signed in now, so one scan is all it takes.",
    };
  return null;
}

/** @typedef {{code: string, key: string, at: number}} Kept a refused claim: its code, its Idempotency-Key, when */

/** Before /auth/start. */
export const keepClaim = (/** @type {ReturnType<typeof createStore>} */ store, /** @type {Kept} */ kept) =>
  store.set(KEPT, JSON.stringify(kept));

/**
 * The kept claim, taken once: read and dropped, so a later visit to /a never replays it. Unused for 5 minutes, or not
 * ours, it is none.
 * @param {ReturnType<typeof createStore>} store
 * @returns {Kept | null}
 */
export function takeClaim(store, now = Date.now()) {
  const raw = store.get(KEPT);
  store.remove(KEPT);
  try {
    const kept = JSON.parse(raw ?? "");
    return typeof kept?.code === "string" && typeof kept.key === "string" && now - kept.at < 300_000 ? kept : null;
  } catch {
    return null;
  }
}

/** Back on /a with a kept code: the owner claim again with its key, so a lost answer still replays. */
export function resume(
  /** @type {ReturnType<typeof createStore>} */ store,
  /** @type {EarlyIo["claim"]} */ claim,
  /** @type {() => void} */ none,
) {
  const kept = takeClaim(store);
  if (kept) claim(kept.code, "owner", kept.key, true);
  else none();
}

/** The refused claim the actions act on, while its state shows. @type {EarlyIo | null} */
let shown = null;
let listening = false;

/** This module's key and words over the page; null and null hand it back to the shared table. */
const show = (/** @type {EarlyIo} */ io, /** @type {"early" | "rescan" | null} */ key) => {
  io.c.error = key;
  io.c.words = key && words;
  io.render();
};

/**
 * `auth_required`, or `code_unknown` for a kept code (it changed while the person signed in).
 * @param {ErrorCode} error
 * @param {EarlyIo} io
 */
export async function refused(error, io) {
  if (error !== "auth_required") return show(io, "rescan");
  const me = await io.who;
  if (!(me.ok && me.value?.launchMode === "open")) return io.claim(io.code, "guest");
  if (!listening) document.getElementById("actions")?.addEventListener("click", act);
  listening = true;
  shown = io;
  show(io, "early");
}

function act(/** @type {Event} */ e) {
  const id = e.target instanceof Element ? e.target.closest("[data-action]")?.getAttribute("data-action") : null;
  const io = shown;
  if (!io || (id !== "signin" && id !== "guest")) return;
  if (id === "signin") {
    // The 5 minutes run from the tap: lingering on this state spends none of them.
    keepClaim(io.store, { code: io.code, key: io.key, at: Date.now() });
    location.assign("/auth/start");
    return;
  }
  shown = null;
  show(io, null);
  io.claim(io.code, "guest");
}
