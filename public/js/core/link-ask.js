// LINK-02, loaded with the remote: a tap on a link row asks the screen to open it, by id, instead of opening it on the
// phone. The screen's answer comes back in the view, and is toasted once.
/** @import {PhoneView} from "../../../src/shared/protocol.ts" */
import { createApi } from "./api.js";
import { toast } from "./toast.js";

const api = createApi();
const OPENED = { title: "Opened on the Screen", body: "This phone can't control that tab." };
const BLOCKED = { title: "Tap Open on the Screen", body: "" };
const REFUSED = { title: "The Screen Can't Open It", body: "", error: true };
const CLOSED = { title: "The Screen Can't Open It", body: "The session is not open.", error: true };
const SILENT = { title: "The Screen Didn't Answer", body: "Check it and try again.", error: true };
const WAIT_MS = 8000;
const FAILED = { title: "The Screen Didn't Open It", body: "Try again in a moment.", error: true };

/**
 * @param {{view: PhoneView | null, pid: string | null}} c
 * @param {(view: PhoneView) => void} onView
 * @param {() => boolean} on whether the remote is showing
 * @returns {() => void} called on every repaint: toasts the screen's answer to this phone's last ask
 */
export function mount(c, onView, on) {
  let asked = 0;
  const answer = () => {
    const a = c.view?.linkOpen;
    if (!asked || a?.n !== asked || a.opened === null) return;
    asked = 0;
    toast(a.refused ? REFUSED : a.opened ? OPENED : BLOCKED);
  };
  document.getElementById("file-list")?.addEventListener("click", async (e) => {
    const row = on() && e.target instanceof Element && e.target.closest("[data-link]");
    if (!row) return;
    e.preventDefault();
    const res = await api.post("/api/control/link", { item: row.getAttribute("data-link") }, c.pid, true);
    if (!res.ok)
      return toast(
        res.error === "file_not_found"
          ? REFUSED
          : res.error === "wrong_state" || res.error === "session_ended"
            ? CLOSED
            : FAILED,
      );
    asked = res.value.linkOpen?.n ?? 0;
    if (res.value.v > (c.view?.v ?? -1)) onView(res.value);
    // The screen's answer may have come by the socket before this reply: nothing repaints for it later.
    answer();
    // A screen that is offline, or whose script did not load, never answers: the phone says so instead of waiting.
    const n = asked;
    setTimeout(() => {
      if (!n || asked !== n) return;
      asked = 0;
      toast(SILENT);
    }, WAIT_MS);
  });
  return answer;
}
