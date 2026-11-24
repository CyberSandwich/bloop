// The screen's launch ladder (docs/interfaces.md section 4, ADR 0003): the protocol link opens PowerPoint;
// if no fetch is seen within LAUNCH_TIMEOUT_MS the Download control appears; the labeled PDF view is the
// last resort. It acts on links as the server pushes them (`open` frames) or answers them (`/api/screen/link`),
// each URL once. Every browser effect is injected, so the logic runs under test without a browser.
/** @import {LinkSet, OpenMode, ScreenView} from "../../src/shared/protocol.ts" */
/** @import {LauncherDeps, Minted, ScreenLauncher} from "./types.js" */
import { firstFile } from "./core/states.js";
import { DOWNLOAD_REUSE_MS, DOWNLOAD_STARTS_PER_LINK, LAUNCH_TIMEOUT_MS, RELINK_WAIT_MS } from "./core/timing.js";
import { PAIRING_OVER } from "./shared/session.js";

/** @param {LauncherDeps} deps @returns {ScreenLauncher} */
export function createLauncher(deps) {
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {{
   *   protocol: string | null, pendingPdf: {url: string, item: number, mode: OpenMode} | null,
   *   pdfWindow: {close?: () => void} | null,
   *   reported: boolean, needsClick: boolean, waitedOut: boolean, haveLink: boolean, spent: Set<number>,
   *   download: {url: string, item: number, at: number, starts: number} | null,
   *   waiting: ReturnType<typeof setTimeout> | undefined, recovering: ReturnType<typeof setTimeout> | undefined
   * }} */
  const s = {
    protocol: null,
    pendingPdf: null,
    pdfWindow: null,
    reported: false,
    needsClick: false,
    waitedOut: false,
    haveLink: false,
    spent: new Set(),
    download: null,
    waiting: undefined,
    recovering: undefined,
  };

  /** The first launch of a session says so to the server, which moves approved to opening (any other state ignores it). */
  function reportOnce(/** @type {OpenMode} */ mode) {
    if (s.reported) return;
    s.reported = deps.report(mode);
  }

  /** The PDF view, or an image's view: both open in a window of their own (the demo shows them in the page). */
  function openPdf(/** @type {{url: string, item: number, mode: OpenMode}} */ view) {
    const win = deps.openWindow(view.url, view.item, view.mode);
    if (win) {
      used.add(view.url);
      s.pdfWindow = /** @type {{close?: () => void}} */ (win);
      s.pendingPdf = null;
      s.needsClick = false;
      reportOnce(view.mode);
    } else {
      // A popup blocker refused: keep the link for the Open control, whose click is the gesture.
      s.pendingPdf = view;
      s.needsClick = true;
    }
  }

  function launchProtocol(/** @type {string} */ url) {
    used.add(url);
    s.protocol = url;
    deps.assign(url);
    reportOnce("protocol");
    // Without activation the browser may refuse the external-protocol launch silently; the Open control retries under a click.
    if (!deps.hasGesture()) s.needsClick = true;
  }

  /** @param {LinkSet} links @param {number} [item] -1 when the sender did not say (the first file) */
  function launch(links, item = -1) {
    s.haveLink = true;
    if (links.protocol && !used.has(links.protocol)) launchProtocol(links.protocol);
    for (const mode of /** @type {const} */ (["pdf", "view"])) {
      const url = links[mode];
      if (url && !used.has(url)) openPdf({ url, item, mode });
    }
    if (links.download && !used.has(links.download)) {
      used.add(links.download);
      s.download = { url: links.download, item, at: Date.now(), starts: 1 };
      deps.startDownload(links.download);
    }
    deps.onChange();
  }

  /** @param {OpenMode} purpose @param {number} [item] @returns {Promise<Minted>} */
  async function request(purpose, item) {
    const body = item === undefined ? { purpose } : { purpose, item };
    const res = await deps.api.post("/api/screen/link", body, deps.sid());
    if (!res.ok) {
      if (res.error !== "mint_limit") return "failed";
      s.spent.add(item ?? -1);
      deps.onChange();
      return "spent";
    }
    launch(res.value.links, res.value.item ?? item);
    return "ok";
  }

  /** @param {number} [item] @returns {Promise<Minted>} */
  async function download(item) {
    const last = s.download;
    if (
      last &&
      (item === undefined || last.item === item) &&
      last.starts < DOWNLOAD_STARTS_PER_LINK &&
      Date.now() - last.at < DOWNLOAD_REUSE_MS
    ) {
      last.starts += 1;
      deps.startDownload(last.url);
      return "ok";
    }
    return request("download", item);
  }

  function reset() {
    clearTimeout(s.waiting);
    clearTimeout(s.recovering);
    s.waiting = s.recovering = undefined;
    closePdf();
    used.clear();
    Object.assign(s, {
      protocol: null,
      pendingPdf: null,
      reported: false,
      needsClick: false,
      waitedOut: false,
      haveLink: false,
      spent: new Set(),
      download: null,
    });
    deps.onChange();
  }

  function closePdf() {
    try {
      s.pdfWindow?.close?.();
    } catch {
      // already closed
    }
    s.pdfWindow = null;
  }

  return {
    launch,

    click() {
      if (s.pendingPdf) openPdf(s.pendingPdf);
      else if (s.protocol) {
        deps.assign(s.protocol);
        s.needsClick = false;
      }
      deps.onChange();
    },

    download,
    showPdf: () => request("pdf"),
    // `protocol` with an item: in every session state the server mints that item's launch link (an image's view
    // link) with no mode change and no fallback metric (docs/interfaces.md section 2.2).
    relink: (item) => request("protocol", item),
    spent: (item) => s.spent.has(item ?? -1),

    onView(view) {
      // A links-only session mints nothing at approval, so there is no link to recover.
      if (view.state === "approved" && !s.haveLink && s.recovering === undefined && firstFile(view.items)) {
        // The `open` frame never came (a reload, a dropped socket): ask for the link again.
        s.recovering = setTimeout(() => {
          s.recovering = undefined;
          if (!s.haveLink) void request("protocol");
        }, RELINK_WAIT_MS);
      }
      if (view.state === "opening" && !s.waitedOut && s.waiting === undefined) {
        s.waiting = setTimeout(() => {
          s.waitedOut = true;
          deps.onChange();
        }, LAUNCH_TIMEOUT_MS);
      }
      if (view.state === "open") {
        s.needsClick = false;
        clearTimeout(s.waiting);
      }
      if (PAIRING_OVER.includes(view.state)) {
        if (s.haveLink || s.pdfWindow || s.needsClick) reset();
      }
    },

    needsClick: () => s.needsClick,
    // Read before the end resets the ladder: what this PC may still hold (the line under Session Ended).
    // The download's name is its link's last segment: the name the file has in Downloads.
    left: () => ({
      ppt: !!s.protocol,
      download: s.download ? decodeURIComponent(s.download.url.slice(s.download.url.lastIndexOf("/") + 1)) : null,
    }),
    downloadReady: () => s.waitedOut,
    closePdf,
    reset,
  };
}
