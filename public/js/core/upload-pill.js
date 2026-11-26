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

/** @param {string} name "Talk.pptm" @returns {string} the extension of its macro-free twin, ".pptx" */
const plain = (name) => `.${/\.(\w{3})m$/i.exec(name)?.[1] ?? "ppt"}x`;

/**
 * The toast for a refused file: the spec's strings only (docs/ux/upload.md section 4). A code it has no string for
 * reads as the plain "Can't Be Added".
 * @param {string} name
 * @param {string} code
 * @param {number | undefined} maxMB the library's file cap, from the API
 * @returns {{title: string, body: string}}
 */
export function refusalToast(name, code, maxMB) {
  const cant = `${name} Can't Be Added`;
  switch (code) {
    case "bad_type":
      return {
        title: "This File Type Isn't Supported",
        body: "bloop takes decks, documents, PDFs, spreadsheets, text, photos and videos.",
      };
    case "empty":
      return { title: "This File Is Empty", body: "" };
    case "too_large":
      return {
        title: "File Too Large",
        body: maxMB ? `bloop takes files up to ${maxMB} MB.` : "",
      };
    case "quota_exceeded":
    case "library_full":
      return { title: "Not Enough Space", body: "Delete files or empty the trash to add this one." };
    case "macro_content":
      return { title: cant, body: `This file has macros. Save a copy without them as ${plain(name)}.` };
    case "encrypted":
      return { title: cant, body: "This file is password protected. Remove the password, then add it again." };
    case "bad_structure":
      return { title: cant, body: "This file is damaged. Open it on your computer and save it again." };
    default:
      return { title: cant, body: "Try again in a moment." };
  }
}

/**
 * Starts the engine and its pill on a page.
 * @param {object} [options]
 * @param {"library" | "guest"} [options.kind]
 * @param {string} [options.pid] a guest's credential
 * @param {number} [options.maxMB] the file cap the "File Too Large" line names
 * @param {((fileId: string) => Promise<unknown>) | null} [options.upNext] ticks a file; null where Up Next is full
 * @param {{append: (node: Node) => void}} [options.host]
 */
export async function mountUploads({ kind = "library", pid, maxMB, upNext = null, host = document.body } = {}) {
  const [{ createUploader, formatBytes, etaLabel }, { pill, CLOSE }] = await Promise.all([
    import("./upload.js"),
    import("./pill.js"),
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
  /** Files whose pill has come and gone. @type {Set<number>} */
  const gone = new Set();
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
  const closer = (f, where) =>
    keep(`close:${where}:${f.id}`, () => {
      const b = el("button", { class: "up-close", type: "button", "aria-label": `Cancel Upload of ${f.name}` }, [
        icon(CLOSE),
      ]);
      b.addEventListener("click", () => uploader.cancel(f.id));
      return b;
    });

  /** @param {Parameters<typeof pill>[0]} next */
  function show(next) {
    clearTimeout(/** @type {any} */ (leaveTimer));
    if (face) face.update(next);
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
      for (const f of last?.files ?? []) if (f.state !== "paused") gone.add(f.id);
      face?.leave();
      face = null;
      sheet?.close();
    }, ms);
  }
  function hide() {
    clearTimeout(/** @type {any} */ (leaveTimer));
    face?.leave();
    face = null;
  }

  /** @param {FileSnap} f @param {Batch} batch the line under a file's title, by its state */
  function lineOf(f, batch) {
    if (f.state === "uploading") {
      const left = batch.etaMs;
      return `${formatBytes(f.loaded, f.size)}${left === null ? "" : ` · ${etaLabel(left)}`}`;
    }
    if (f.state === "waiting")
      return waitingLong ? "Keep this page open. It finishes when you're back online." : "Waiting for a Connection";
    if (f.state === "checking") return f.name;
    return f.state === "saved" || f.state === "sent" ? f.name : "Starting";
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
                ticking = false;
                return;
              }
              face?.update({ title: "Added to Up Next", slot: [] });
              leaveIn(SAVED_MS);
            }),
          )
        : null;
    show({
      title: checking ? "Checking Your File" : f.state === "saved" ? "Saved" : f.state === "sent" ? "Sent" : f.name,
      line: lineOf(f, batch),
      label: `Uploading ${f.name}`,
      glyph: glyphOf(f.name),
      fill:
        f.state === "queued" || f.state === "fingerprinting" || f.state === "starting"
          ? null
          : checking || done
            ? 1
            : f.fraction,
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
            ? "Can't Be Added"
            : "Waiting";

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
      line: active
        ? `${formatBytes(batch.loaded, batch.total)}${batch.etaMs === null ? "" : ` · ${etaLabel(batch.etaMs)}`}`
        : "",
      label: `Uploading ${files.length} Files`,
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
    show({
      title: `${f.name} Is Paused`,
      line: "Choose the file again to finish.",
      label: `${f.name} Is Paused`,
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

  /** @param {Batch} batch */
  function render(batch) {
    last = batch;
    for (const f of batch.files) {
      if (told.has(f.id) || (f.state !== "refused" && f.state !== "canceled")) continue;
      told.add(f.id);
      if (f.state === "canceled") toast({ title: "Upload Canceled", body: `${f.name} wasn't added.` });
      else toast({ ...refusalToast(f.name, f.error ?? "", maxMB), error: true });
    }
    const live = batch.files.filter(
      (f) => f.state !== "paused" && f.state !== "refused" && f.state !== "canceled" && !gone.has(f.id),
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
    dispose() {
      clearTimeout(/** @type {any} */ (leaveTimer));
      clearTimeout(/** @type {any} */ (longWait));
      uploader.dispose();
      hide();
      sheet?.remove();
    },
  };
}
