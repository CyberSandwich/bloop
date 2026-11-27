// LINK-02, lazy: the phone asked this screen to open an approved link in a new tab. Only the URL in the screen's own item
// list opens, and only over https. A browser refuses a tab no click here asked for, so the pill is the expected path: it
// takes the Stop Presenting pill's place and a real click opens the tab. The phone hears which happened, through the answer.
/** @import {ScreenView} from "../../../src/shared/protocol.ts" */
import { ICONS } from "./icons.js";
import { byId, icon } from "./ui.js";

/** The last ask acted on, so a view that arrives twice opens one tab; and the ask the pill belongs to. */
let acted = 0;
let pilled = 0;

/** @param {string} url @returns {Window | null} null when the browser refused */
function tab(url) {
  let win = null;
  try {
    win = window.open(url, "_blank");
  } catch {}
  // Without the noopener feature, which would hide a refusal behind the same null.
  if (win) win.opener = null;
  return win;
}

/**
 * Called on each view that carries an ask.
 * @param {ScreenView} view
 * @param {{post: (path: string, body: unknown, credential: string) => Promise<unknown>}} api
 * @param {string} sid
 */
export function follow(view, api, sid) {
  const ask = view.linkOpen;
  const pill = byId("b-link");
  // The pill outlives neither its ask nor its session: a later ask takes it away here, the stage hiding below.
  if (ask?.n !== pilled) pill.hidden = true;
  if (!ask || ask.opened !== null || ask.n <= acted) return;
  acted = ask.n;
  const item = view.items.find((i) => i.kind === "link" && i.id === ask.item);
  const url = item?.kind === "link" && item.url.startsWith("https://") ? item.url : null;
  const opened = !!url && !!tab(url);
  if (item?.kind === "link" && url && !opened) {
    pilled = ask.n;
    pill.replaceChildren(`Open ${item.title}`, icon(ICONS["arrow-up-right"], true));
    // The Stop Presenting pill's own rules place it; this one is always shown, under Stop while that shows.
    pill.style.opacity = "1";
    pill.style.pointerEvents = "auto";
    pill.hidden = false;
    // The stage hides when the session ends or renews, and the views then carry no ask to say so.
    const stage = byId("view");
    new MutationObserver((_, watch) => {
      if (!stage.hidden) return;
      pill.hidden = true;
      watch.disconnect();
    }).observe(stage, { attributes: true, attributeFilter: ["hidden"] });
    pill.onclick = () => {
      window.open(url, "_blank", "noopener,noreferrer");
      pill.hidden = true;
    };
  }
  void api.post("/api/screen/opened", { n: ask.n, opened, ...(url ? {} : { refused: true }) }, sid);
}
