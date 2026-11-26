// Binds the upload engine to the pill (docs/ux/upload.md): one line per state (the name, a status word, one action),
// Cancel, Check Again, Add to Up Next, the batch's sheet, the paused row's Resume, and the refusal toasts. The sentence
// a line leaves out is the action's accessible name or the polite region. All logic is in upload.js; this only reads
// its snapshots.
/** @typedef {import("./upload.js").Batch} Batch */
/** @typedef {import("./upload.js").FileSnap} FileSnap */
import { ICONS } from "./icons.js";
import { styled } from "./lazy.js";
import { el, icon, setText } from "./ui.js";

const SAVED_MS = 2000;
const ACTION_MS = 8000;
const LONG_WAIT_MS = 120_000;
/** What the polite region and the sheet's rows say of a file, by state. @type {Record<string, string>} */
const SAID = { saved: "Saved", checking: "Checking Your File", unsettled: "Still Checking Your File" };
const WAITING = "Waiting for a Connection";

/**
 * Starts the engine and its pill on a page.
 * @param {object} [options]
 * @param {number} [options.maxMB] the file cap the "File Too Large" line names
 * @param {((fileId: string) => Promise<unknown>) | null} [options.upNext] ticks a file; null where Up Next is full
 * @param {{append: (node: Node) => void}} [options.host]
 * @param {{focus: () => void} | null} [options.trigger] what opened the upload: it takes the focus when the pill leaves
 */
export async function mountUploads({ maxMB, upNext = null, host = document.body, trigger = null } = {}) {
  const [{ createUploader }, { formatBytes, percent, statusWord }, { pill, CLOSE }, { toast }, { fitName, glyphOf }] =
    await Promise.all([
      import("./upload.js"),
      import("./upload-format.js"),
      import("./pill.js"),
      import("./upload-toast.js"),
      import("./upload-face.js"),
      styled("/css/upload.css"),
    ]);
  /** @type {ReturnType<typeof pill> | null} */
  let face = null;
  /** @type {unknown} */
  let leaveTimer = null;
  /** @type {unknown} */
  let longWait = null;
  let held = false;
  let waitingLong = false;
  /** @type {Awaited<ReturnType<typeof makeSheet>> | null} */
  let sheet = null;
  /** @type {Batch | null} */
  let last = null;
  /** Files whose pill has come and gone, and refusals and cancels already told. @type {Set<number>} */
  const told = new Set();
  /** The sheet's line for each refused file. @type {Map<number, string>} */
  const reasons = new Map();
  /** @type {number | null} */
  let picking = null;
  let ticking = false;
  let batchTitle = "";
  /** The fill never goes back while a batch runs, whoever leaves it. */
  let peak = 0;
  let heard = "";
  // One polite region for the page's life: a region made with the pill may not be announced for its first words.
  const region = el("span", { class: "sr", role: "status" });
  host.append(region);

  const picker = Object.assign(document.createElement("input"), {
    type: "file",
    hidden: true,
  });
  picker.addEventListener("change", () => {
    const [file] = picker.files ?? [];
    if (file && picking !== null) void uploader.resume(picking, file);
    picker.value = "";
  });

  const uploader = createUploader({ onChange: render });

  /** @type {Map<string, HTMLElement>} */
  const kept = new Map();
  /**
   * The same button on every render of a file: one swapped between pointerdown and pointerup never gets its click,
   * and a rebuilt one loses the keyboard's focus.
   * @param {string} key @param {() => HTMLElement} make
   */
  const keep = (key, make) => {
    const node = kept.get(key) ?? make();
    kept.set(key, node);
    return node;
  };
  /** @param {string} label @param {() => void} run @param {string} [name] the accessible name, when the label is not enough */
  const button = (label, run, name = label) => {
    const b = el("button", { class: "btn text up-act", type: "button", "aria-label": name }, [label]);
    b.addEventListener("click", run);
    return b;
  };
  /** @param {FileSnap} f @param {string} where the pill or the sheet */
  const closer = (f, where) => {
    const b = keep(`close:${where}:${f.id}`, () => {
      const made = el("button", { class: "up-close", type: "button" }, [icon(CLOSE)]);
      made.addEventListener("click", () => uploader.cancel(f.id));
      return made;
    });
    b.setAttribute("aria-label", `Cancel Upload of ${f.name}`);
    return b;
  };
  /** @param {FileSnap} f */
  const again = (f) =>
    keep(`again:${f.id}`, () => button("Check Again", () => uploader.recheck(f.id), `Check Again: ${f.name}`));

  /** What a refusal says: its words are loaded when there is one to say, and a plain line stands in if they cannot be.
   * @param {string} name @param {string} code @returns {Promise<{title: string, status?: string, say: string}>} */
  const refusal = (name, code) =>
    import("./upload-refusals.js").then(
      ({ refusalToast }) => refusalToast(name, code, maxMB),
      () => ({
        title: name,
        status: "Can't Be Added",
        say: "Try again in a moment.",
      }),
    );

  /** @param {Parameters<typeof pill>[0]} next @param {string} say what the polite region says, once */
  function show(next, say) {
    clearTimeout(/** @type {any} */ (leaveTimer));
    if (say !== heard) {
      heard = say;
      setText(region, say);
    }
    if (face) face.update(next);
    else {
      face = pill({ host, ...next });
      fitName(face.node);
      for (const type of ["pointerenter", "focusin"]) face.node.addEventListener(type, () => (held = true));
      for (const type of ["pointerleave", "focusout"]) face.node.addEventListener(type, () => (held = false));
    }
  }
  /** Leaves after `ms`, held off while the pointer or focus is on it; what it showed is not shown again. @param {number} ms */
  function leaveIn(ms) {
    clearTimeout(/** @type {any} */ (leaveTimer));
    leaveTimer = setTimeout(() => {
      if (held) return leaveIn(1000);
      for (const f of last?.files ?? []) if (f.state !== "paused" && f.state !== "unsettled") told.add(f.id);
      // The sheet first: closing a dialog gives focus back to what opened it, which the pill is about to remove.
      sheet?.hide();
      hide();
    }, ms);
  }
  /** The pill goes; focus inside it (Cancel, Add to Up Next) goes back to what opened the upload, not to the page. */
  function hide() {
    clearTimeout(/** @type {any} */ (leaveTimer));
    const at = document.activeElement;
    if (at && (face?.node.contains(at) || sheet?.contains(at))) trigger?.focus();
    face?.leave();
    face = null;
    heard = "";
    setText(region, "");
    peak = 0;
  }
  /** @param {number | null} v a fill @returns {number | null} the fill, or the highest this batch has shown */
  function level(v) {
    if (v === null && !peak) return null;
    peak = Math.max(peak, v ?? 0);
    return peak;
  }

  /** @param {FileSnap} f */
  function single(f) {
    const done = f.state === "saved";
    const settling = f.state === "checking" || f.state === "unsettled";
    const fileId = f.fileId;
    const action =
      done && upNext && fileId
        ? keep(`next:${f.id}`, () =>
            button(
              "Add to Up Next",
              async () => {
                if (ticking) return;
                ticking = true;
                try {
                  await upNext(fileId);
                } catch {
                  // the page that ticks says why it could not
                  return;
                } finally {
                  ticking = false;
                }
                // The button that had the focus is about to go: the focus returns to what opened the upload.
                if (face?.node.contains(document.activeElement)) trigger?.focus();
                show({ status: "Added", slot: [] }, `${f.name} Added to Up Next`);
                leaveIn(SAVED_MS);
              },
              `Add to Up Next: ${f.name}`,
            ),
          )
        : null;
    const status = statusWord(f);
    // The polite region must not change on a percent tick: it says the name while bytes move.
    const say =
      SAID[f.state] ??
      (f.state !== "waiting"
        ? f.name
        : waitingLong
          ? "Keep this page open. It finishes when you're back online."
          : WAITING);
    show(
      {
        title: f.name,
        status: status ?? "Starting",
        label: `Uploading ${f.name}`,
        glyph: glyphOf(f.name),
        // No status word yet: no byte has moved (queued, fingerprinting, starting).
        fill: status ? level(settling || done ? 1 : f.fraction) : level(null),
        sheen: f.state !== "waiting" && f.state !== "unsettled" && !done,
        press: null,
        slot: f.state === "unsettled" ? [again(f)] : settling || done ? (action ? [action] : []) : [closer(f, "pill")],
      },
      say,
    );
    if (done) leaveIn(action ? ACTION_MS : SAVED_MS);
  }

  /** @param {FileSnap} f a file's line in the sheet */
  const sheetLine = (f) =>
    SAID[f.state] ??
    (f.state === "uploading"
      ? formatBytes(f.loaded, f.size)
      : f.state === "refused"
        ? (reasons.get(f.id) ?? "")
        : "Waiting");

  /** @param {FileSnap} f the control on a file's row in the sheet */
  const control = (f) =>
    f.state === "unsettled" ? again(f) : ["saved", "refused", "checking"].includes(f.state) ? null : closer(f, "sheet");
  /** The sheet's code is loaded when it is first asked for. */
  async function makeSheet() {
    const { createSheet } = await import("./upload-sheet.js");
    return createSheet({
      host,
      glyph: glyphOf,
      line: sheetLine,
      control,
      close: button("Close", () => sheet?.hide()),
    });
  }
  async function openSheet() {
    sheet ??= await makeSheet();
    paintSheet();
    sheet.show();
  }
  function paintSheet() {
    sheet?.paint(last?.files.filter((f) => f.state !== "paused" && f.state !== "canceled") ?? [], batchTitle);
  }

  /** @param {FileSnap[]} files @param {Batch} batch */
  function several(files, batch) {
    const saved = files.filter((f) => f.state === "saved").length;
    const active = batch.active;
    const up = `Uploading ${files.length} Files`;
    batchTitle = active ? up : `${saved} ${saved === 1 ? "File" : "Files"} Saved`;
    const waiting = files.some((f) => f.state === "waiting");
    show(
      {
        title: active ? `${files.length} Files` : `${saved} ${saved === 1 ? "File" : "Files"}`,
        status: active ? percent(batch.fraction) : "Saved",
        label: batchTitle,
        glyph: ICONS["file-text"],
        fill: level(active ? batch.fraction : 1),
        sheen: active,
        press: openSheet,
        slot: [],
      },
      waiting ? WAITING : batchTitle,
    );
    if (!active) leaveIn(SAVED_MS);
  }

  /** @param {FileSnap} f */
  function paused(f) {
    const say = `${f.name} Is Paused`;
    show(
      {
        title: f.name,
        status: "Paused",
        label: say,
        glyph: glyphOf(f.name),
        fill: null,
        sheen: false,
        press: null,
        slot: [
          keep(`choose:${f.id}`, () =>
            button(
              "Resume",
              () => {
                picking = f.id;
                picker.click();
              },
              `Resume ${f.name}: choose the file again to finish`,
            ),
          ),
          closer(f, "pill"),
        ],
      },
      say,
    );
  }

  /**
   * Each cancel, and each refusal once. A batch's refusals wait for its end and are one toast that opens the sheet,
   * where each file has its own line.
   * @param {Batch} batch
   */
  async function tell(batch) {
    const fresh = (/** @type {string} */ state) => batch.files.filter((f) => f.state === state && !told.has(f.id));
    const canceled = fresh("canceled");
    const refused = batch.files.length > 1 && batch.active ? [] : fresh("refused");
    for (const f of [...canceled, ...refused]) told.add(f.id);
    for (const f of canceled)
      toast({
        title: f.name,
        status: "Canceled",
        say: `${f.name} wasn't added.`,
      });
    if (!refused.length) return;
    const said = await Promise.all(refused.map((f) => refusal(f.name, f.error ?? "")));
    for (const [i, f] of refused.entries()) reasons.set(f.id, said[i]?.say || said[i]?.title || "");
    if (last) render(last);
    if (refused.length > 1) {
      batchTitle = `${refused.length} Files Couldn't Be Added`;
      toast({
        title: `${refused.length} Files`,
        status: "Can't Be Added",
        say: batchTitle,
        error: true,
        action: { label: "See Why", run: openSheet },
      });
    } else toast({ ...(said[0] ?? { title: "", say: "" }), error: true });
  }

  /** @param {Batch} batch */
  function render(batch) {
    last = batch;
    void tell(batch);
    const live = batch.files.filter(
      (f) => f.state !== "paused" && f.state !== "refused" && f.state !== "canceled" && !told.has(f.id),
    );
    const waiting = live.some((f) => f.state === "waiting");
    if (waiting && !longWait && !waitingLong)
      longWait = setTimeout(() => {
        waitingLong = true;
        longWait = null;
        if (last) render(last);
      }, LONG_WAIT_MS);
    if (!waiting) {
      clearTimeout(/** @type {any} */ (longWait));
      longWait = null;
      waitingLong = false;
    }
    const [one] = live;
    const rest = batch.files.find((f) => f.state === "paused");
    if (live.length === 1 && one) single(one);
    else if (live.length) several(live, batch);
    else if (rest) paused(rest);
    else hide();
    if (sheet?.isOpen()) paintSheet();
  }

  return {
    /** @param {Iterable<File>} files */
    add: (files) => uploader.add(Array.from(files)),
    /** @param {number} id */
    cancel: (id) => uploader.cancel(id),
    dispose() {
      clearTimeout(/** @type {any} */ (leaveTimer));
      clearTimeout(/** @type {any} */ (longWait));
      uploader.dispose();
      hide();
      sheet?.remove();
      region.remove();
    },
  };
}
