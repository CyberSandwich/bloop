// The screen's launch ladder (docs/interfaces.md section 4, ADR 0003): the protocol link opens PowerPoint;
// if no fetch is seen within LAUNCH_TIMEOUT_MS the Download control appears; the labeled PDF view is the
// last resort. It acts on links as the server pushes them (`open` frames) or answers them (`/api/screen/link`),
// each URL once. Every browser effect is injected, so the logic runs under test without a browser.
/** @import {LinkSet, OpenMode, ScreenView} from "../../src/shared/protocol.ts" */
/** @import {Api} from "./core/api.js" */
import { DOWNLOAD_REUSE_MS, DOWNLOAD_STARTS_PER_LINK, LAUNCH_TIMEOUT_MS, RELINK_WAIT_MS } from "./core/timing.js";

/**
 * @typedef {object} LauncherDeps
 * @property {Api} api
 * @property {() => string | null} sid the screen credential
 * @property {(url: string) => void} assign navigate to a protocol URI
 * @property {(url: string) => unknown} openWindow open the PDF view; null or undefined when a popup blocker refused
 * @property {(url: string) => void} startDownload
 * @property {() => boolean} hasGesture the page has transient user activation right now
 * @property {(mode: OpenMode) => boolean} report tell the server which launch this was; false when it could not be sent
 * @property {() => void} onChange state the page renders from changed
 */

/**
 * @typedef {object} ScreenLauncher
 * @property {(links: LinkSet) => void} launch act on a pushed or fetched link set
 * @property {() => void} click the Open control: relaunch, or open a blocked PDF, under a user gesture
 * @property {() => Promise<Minted>} download start the recent download link again, or mint one and start it
 * @property {() => Promise<Minted>} showPdf mint the PDF link and open it
 * @property {() => boolean} spent the session's mint budget ran out (`mint_limit`), so no fallback can be minted
 * @property {(view: ScreenView) => void} onView follow the session: recover a lost link, time the launch, reset at the end
 * @property {() => boolean} needsClick a click is needed to open (no gesture at launch, or a blocked popup)
 * @property {() => boolean} downloadReady the launch has waited long enough that Download may show
 * @property {() => void} closePdf close the PDF window this page opened
 * @property {() => void} reset drop every link and timer (the residue step)
 */

/** @typedef {"ok" | "spent" | "failed"} Minted `spent`: the mint limit, which the page shows by hiding the controls */

/** @param {LauncherDeps} deps @returns {ScreenLauncher} */
export function createLauncher(deps) {
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {{
   *   protocol: string | null, pendingPdf: string | null, pdfWindow: {close?: () => void} | null,
   *   reported: boolean, needsClick: boolean, waitedOut: boolean, haveLink: boolean, spent: boolean,
   *   download: {url: string, at: number, starts: number} | null,
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
    spent: false,
    download: null,
    waiting: undefined,
    recovering: undefined,
  };

  /** The first launch of a session says so to the server, which moves approved to opening (any other state ignores it). */
  function reportOnce(/** @type {OpenMode} */ mode) {
    if (s.reported) return;
    s.reported = deps.report(mode);
  }

  function openPdf(/** @type {string} */ url) {
    const win = deps.openWindow(url);
    if (win) {
      used.add(url);
      s.pdfWindow = /** @type {{close?: () => void}} */ (win);
      s.pendingPdf = null;
      s.needsClick = false;
      reportOnce("pdf");
    } else {
      // A popup blocker refused: keep the link for the Open control, whose click is the gesture.
      s.pendingPdf = url;
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

  /** @param {LinkSet} links */
  function launch(links) {
    s.haveLink = true;
    if (links.protocol && !used.has(links.protocol)) launchProtocol(links.protocol);
    if (links.pdf && !used.has(links.pdf)) openPdf(links.pdf);
    if (links.download && !used.has(links.download)) {
      used.add(links.download);
      s.download = { url: links.download, at: Date.now(), starts: 1 };
      deps.startDownload(links.download);
    }
    deps.onChange();
  }

  /** @param {OpenMode} purpose @returns {Promise<Minted>} */
  async function request(purpose) {
    const res = await deps.api.post("/api/screen/link", { purpose }, deps.sid());
    if (!res.ok) {
      if (res.error !== "mint_limit") return "failed";
      s.spent = true;
      deps.onChange();
      return "spent";
    }
    launch(res.value.links);
    return "ok";
  }

  /** @returns {Promise<Minted>} */
  async function download() {
    const last = s.download;
    if (last && last.starts < DOWNLOAD_STARTS_PER_LINK && Date.now() - last.at < DOWNLOAD_REUSE_MS) {
      last.starts += 1;
      deps.startDownload(last.url);
      return "ok";
    }
    return request("download");
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
      spent: false,
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
    spent: () => s.spent,

    onView(view) {
      if (view.state === "approved" && !s.haveLink && s.recovering === undefined) {
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
      if (view.state === "ended" || view.state === "waiting" || view.state === "closed") {
        if (s.haveLink || s.pdfWindow || s.needsClick) reset();
      }
    },

    needsClick: () => s.needsClick,
    downloadReady: () => s.waitedOut,
    closePdf,
    reset,
  };
}
