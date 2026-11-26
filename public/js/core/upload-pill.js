// Binds the upload engine to the pill (docs/ux/upload.md): titles and lines per state, Cancel, Add to Up Next, the
// batch's sheet, the paused row's Choose File, and the refusal toasts. All logic is in upload.js; this only reads its
// snapshots.
/** @typedef {import("./upload.js").Batch} Batch */
/** @typedef {import("./upload.js").FileSnap} FileSnap */
import { ICONS } from "./icons.js";
import { styled } from "./lazy.js";
import { toast } from "./toast.js";
import { el, icon, setText } from "./ui.js";

const SAVED_MS = 2000;
const ACTION_MS = 8000;
const LONG_WAIT_MS = 120_000;

/** @param {string} name */
const glyphOf = (name) =>
  /\.pptx?$/i.test(name)
    ? ICONS.presentation
    : /\.(mp4|mov|webm)$/i.test(name)
      ? ICONS.film
      : /\.(jpe?g|png|gif|webp|heic)$/i.test(name)
        ? ICONS.image
        : ICONS["file-text"];

/**
 * Starts the engine and its pill on a page.
 * @param {object} [options]
 * @param {"library" | "guest"} [options.kind]
 * @param {string} [options.pid] a guest's credential
 * @param {number} [options.maxMB] the file cap the "File Too Large" line names
 * @param {((fileId: string) => Promise<unknown>) | null} [options.upNext] ticks a file; null where Up Next is full
 * @param {{append: (node: Node) => void}} [options.host]
 * @param {{focus: () => void} | null} [options.trigger] what opened the upload: it takes the focus when the pill leaves
 * @param {(batch: Batch) => void} [options.onChange] the page's own view of each snapshot (a guest's send)
 */
export async function mountUploads({
  kind = "library",
  pid,
  maxMB,
  upNext = null,
  host = document.body,
  trigger = null,
  onChange,
} = {}) {
  const guest = kind === "guest";
  const [{ createUploader, formatBytes, progressLine }, { pill, CLOSE }, { refusalToast }] = await Promise.all([
    import("./upload.js"),
    import("./pill.js"),
    import("./upload-refusals.js"),
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
  /** @type {HTMLDialogElement | null} */
  let sheet = null;
  /** @type {Batch | null} */
  let last = null;
  /** Files whose pill has come and gone, and refusals and cancels already told. @type {Set<number>} */
  const told = new Set();
  /** @type {number | null} */
  let picking = null;
  let ticking = false;
  let batchTitle = "";
  let sheetKey = "";
  /** @type {Map<number, HTMLElement>} */
  const sheetLines = new Map();

  const picker = Object.assign(document.createElement("input"), { type: "file", hidden: true });
  picker.addEventListener("change", () => {
    const [file] = picker.files ?? [];
    if (file && picking !== null) uploader.resume(picking, file);
    picker.value = "";
  });

  const uploader = createUploader({ kind, ...(pid ? { pid } : {}), onChange: render });

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
  /** @param {string} label @param {() => void} run */
  const button = (label, run) => {
    const b = el("button", { class: "btn text up-act", type: "button" }, [label]);
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

  /** @param {Parameters<typeof pill>[0]} next */
  function show(next) {
    clearTimeout(/** @type {any} */ (leaveTimer));
    if (face) face.update({ wrap: false, ...next });
    else {
      face = pill({ host, ...next });
      for (const type of ["pointerenter", "focusin"]) face.node.addEventListener(type, () => (held = true));
      for (const type of ["pointerleave", "focusout"]) face.node.addEventListener(type, () => (held = false));
    }
  }
  /** Leaves after `ms`, held off while the pointer or focus is on it; what it showed is not shown again. @param {number} ms */
  function leaveIn(ms) {
    clearTimeout(/** @type {any} */ (leaveTimer));
    leaveTimer = setTimeout(() => {
      if (held) return leaveIn(1000);
      for (const f of last?.files ?? []) if (f.state !== "paused") told.add(f.id);
      hide();
      sheet?.close();
    }, ms);
  }
  /** The pill goes; focus inside it (Cancel, Add to Up Next) goes back to what opened the upload, not to the page. */
  function hide() {
    clearTimeout(/** @type {any} */ (leaveTimer));
    const at = document.activeElement;
    if (at && (face?.node.contains(at) || sheet?.contains(at))) trigger?.focus();
    face?.leave();
    face = null;
  }

  /** @param {FileSnap} f no byte has moved yet */
  const starting = (f) => f.state === "queued" || f.state === "fingerprinting" || f.state === "starting";

  /** @param {FileSnap} f @param {Batch} batch the line under a file's title, by its state */
  function lineOf(f, batch) {
    if (f.state === "uploading") return progressLine(f.loaded, f.size, batch.etaMs);
    if (f.state === "waiting")
      return waitingLong ? "Keep this page open. It finishes when you're back online." : "Waiting for a Connection";
    return starting(f) ? "Starting" : f.name;
  }

  /** @param {FileSnap} f @param {Batch} batch */
  function single(f, batch) {
    const done = f.state === "saved" || f.state === "sent";
    const checking = f.state === "checking";
    const fileId = f.fileId;
    const action =
      f.state === "saved" && upNext && fileId
        ? keep(`next:${f.id}`, () =>
            button("Add to Up Next", async () => {
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
              face?.update({ title: "Added to Up Next", slot: [] });
              leaveIn(SAVED_MS);
            }),
          )
        : null;
    const text = lineOf(f, batch);
    show({
      title: checking ? "Checking Your File" : f.state === "saved" ? "Saved" : f.state === "sent" ? "Sent" : f.name,
      line: text,
      say: f.state === "waiting" ? text : "",
      label: `Uploading ${f.name}`,
      glyph: glyphOf(f.name),
      fill: starting(f) ? null : checking || done ? 1 : f.fraction,
      sheen: f.state !== "waiting" && !done,
      press: null,
      slot: checking || done ? (action ? [action] : []) : [closer(f, "pill")],
    });
    if (done) leaveIn(action ? ACTION_MS : SAVED_MS);
  }

  /** @param {FileSnap} f a file's line in the sheet */
  const sheetLine = (f) =>
    f.state === "saved" || f.state === "sent"
      ? "Saved"
      : f.state === "uploading"
        ? formatBytes(f.loaded, f.size)
        : f.state === "checking"
          ? "Checking Your File"
          : f.state === "refused"
            ? reasonOf(f)
            : "Waiting";

  /** @param {FileSnap} f the sheet's line for a refused file: its reason, or its title where it has no more to say */
  function reasonOf(f) {
    const { title, body } = refusalToast(f.name, f.error ?? "", maxMB);
    return body || title;
  }

  /** @param {FileSnap[]} files */
  function rows(files) {
    return files.map((f) => {
      const line = el("span", { class: f.state === "refused" ? "up-line up-bad" : "up-line" }, [sheetLine(f)]);
      sheetLines.set(f.id, line);
      const item = el("li", { class: "up-item" }, [
        icon(glyphOf(f.name)),
        el("span", { class: "up-text" }, [el("strong", { class: "up-title" }, [f.name]), line]),
      ]);
      if (!["saved", "sent", "refused", "checking"].includes(f.state)) item.append(closer(f, "sheet"));
      return item;
    });
  }
  function openSheet() {
    if (!sheet) {
      sheet = el("dialog", { class: "up-sheet" });
      sheet.addEventListener("click", (e) => e.target === sheet && sheet?.close());
      host.append(sheet);
    }
    paintSheet();
    if (!sheet.open) sheet.showModal();
  }
  /** Rebuilt only when the files or their states change; otherwise only the lines move, so focus and taps hold. */
  function paintSheet() {
    if (!sheet || !last) return;
    const files = last.files.filter((f) => f.state !== "paused" && f.state !== "canceled");
    const key = files.map((f) => `${f.id}:${f.state}`).join(",");
    if (key !== sheetKey) {
      sheetKey = key;
      sheet.setAttribute("aria-label", batchTitle);
      sheet.replaceChildren(el("ul", { class: "up-list glass glass-pane" }, rows(files)));
    } else for (const f of files) setText(/** @type {HTMLElement} */ (sheetLines.get(f.id)), sheetLine(f));
  }

  /** @param {FileSnap[]} files @param {Batch} batch */
  function several(files, batch) {
    const saved = files.filter((f) => f.state === "saved" || f.state === "sent").length;
    const active = batch.active;
    batchTitle = active ? `Uploading ${files.length} Files` : `${saved} ${saved === 1 ? "File" : "Files"} Saved`;
    show({
      title: batchTitle,
      label: `Uploading ${files.length} Files`,
      line: active ? progressLine(batch.loaded, batch.total, batch.etaMs) : "",
      say: files.some((f) => f.state === "waiting") ? "Waiting for a Connection" : "",
      glyph: ICONS["file-text"],
      fill: active ? batch.fraction : 1,
      sheen: active,
      press: openSheet,
      slot: [],
    });
    if (!active) leaveIn(SAVED_MS);
  }

  /** @param {FileSnap} f */
  function paused(f) {
    const title = `${f.name} Is Paused`;
    show({
      title,
      wrap: true,
      line: "Choose the file again to finish.",
      label: title,
      glyph: glyphOf(f.name),
      fill: null,
      sheen: false,
      press: null,
      slot: [
        keep(`choose:${f.id}`, () =>
          button("Choose File", () => {
            picking = f.id;
            picker.click();
          }),
        ),
        closer(f, "pill"),
      ],
    });
  }

  /**
   * Each cancel, and each refusal once. A batch's refusals wait for its end and are one toast that opens the sheet,
   * where each file has its own line. A guest's refusal is the page's own state ("This File Can't Be Sent"), no toast.
   * @param {Batch} batch
   */
  function tell(batch) {
    const fresh = (/** @type {string} */ state) => batch.files.filter((f) => f.state === state && !told.has(f.id));
    const canceled = fresh("canceled");
    const refused = batch.files.length > 1 && batch.active ? [] : fresh("refused");
    for (const f of [...canceled, ...refused]) told.add(f.id);
    for (const f of canceled) toast({ title: "Upload Canceled", body: `${f.name} wasn't added.` });
    const [one] = refused;
    if (refused.length > 1) {
      batchTitle = `${refused.length} Files Couldn't Be Added`;
      toast({
        title: batchTitle,
        body: "",
        error: true,
        action: { label: "See Why", run: openSheet },
      });
    } else if (one) toast({ ...refusalToast(one.name, one.error ?? "", maxMB), error: true });
  }

  /** @param {Batch} batch */
  function render(batch) {
    last = batch;
    onChange?.(batch);
    if (!guest) tell(batch);
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
    if (live.length === 1 && one) single(one, batch);
    else if (live.length) several(live, batch);
    else if (rest) paused(rest);
    else hide();
    if (sheet?.open) paintSheet();
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
    },
  };
}
