// LINK-02, loaded with the remote: a tap on a link row asks the screen to open it, by id, instead of opening it on the
// phone. The screen's answer comes back in the view, and is toasted once.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
import { createApi } from "./api.js";
import { toast } from "./toast.js";

const api = createApi();
const OPENED = { title: "Opened on the Screen", body: "This phone can't control that tab." };
const BLOCKED = { title: "Tap Open on the Screen", body: "" };
const FAILED = { title: "The Screen Didn't Open It", body: "Try again in a moment.", error: true };

/**
 * @param {{view: PhoneView | null, pid: string | null}} c
 * @param {(view: PhoneView) => void} onView
 * @param {() => boolean} on whether the remote is showing
 * @returns {() => void} called on every repaint: toasts the screen's answer to this phone's last ask
 */
export function mount(c, onView, on) {
  let asked = 0;
  document.getElementById("file-list")?.addEventListener("click", async (e) => {
    const row = on() && e.target instanceof Element && e.target.closest("[data-link]");
    if (!row) return;
    e.preventDefault();
    const res = await api.post("/api/control/link", { item: row.getAttribute("data-link") }, c.pid, true);
    if (!res.ok) return res.error === "wrong_state" || res.error === "session_ended" ? undefined : toast(FAILED);
    asked = res.value.linkOpen?.n ?? 0;
    if (res.value.v > (c.view?.v ?? -1)) onView(res.value);
  });
  return () => {
    const answer = c.view?.linkOpen;
    if (!asked || answer?.n !== asked || answer.opened === null) return;
    asked = 0;
    toast(answer.opened ? OPENED : BLOCKED);
  };
}
