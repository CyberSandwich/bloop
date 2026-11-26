// The library page's pure parts: its words, its rules for rows and Up Next, and its fetch wrapper.
import { describe, expect, it } from "vitest";
import {
  dateText,
  deletesIn,
  emptyTrashLine,
  fontSentence,
  fullLine,
  kindOf,
  pagesWord,
  positionText,
  preparingText,
  quotaLine,
  quotaShare,
  reasonOf,
  sizeText,
  T,
  trashUses,
} from "../../public/js/core/copy-library.js";
import {
  allRows,
  cached,
  canTick,
  type List,
  move,
  nameParts,
  type Row,
  rowLine,
  status,
  tick,
  upNextRows,
  withOrder,
  withoutRow,
  withRow,
} from "../../public/js/library/model.js";
import { createNet } from "../../public/js/library/net.js";
import { NEVER_SAY } from "./never-say.ts";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const NOW = Date.UTC(2026, 10, 26, 12, 0);
const TZ = "UTC";

const row = (over: Partial<Row> = {}): Row => ({
  id: "f1",
  name: "Lecture 5.pptx",
  ext: "pptx",
  bytes: 18 * MB,
  status: "ready",
  updatedAt: NOW - 3_600_000,
  selected: false,
  disabled: false,
  derived: { state: "ready" },
  ...over,
});

const list = (over: Partial<List> = {}): List => ({
  view: "files",
  sort: "updated",
  files: [row({ id: "a" }), row({ id: "b", name: "Reading list.pdf", ext: "pdf" }), row({ id: "c" })],
  next: null,
  uploads: [],
  upNext: [],
  quota: { used: 0, reserved: 0, limit: 5 * GB },
  trash: { count: 0, bytes: 0 },
  limits: { upNext: 12, trashDays: 30, maxFileBytes: 500 * MB },
  switches: { uploads: "on", previews: "on", export: "on" },
  account: { state: "active" },
  ...over,
});

describe("library words", () => {
  it("sizes in the spec's units: KB under 1 MB, one decimal under 10, whole above", () => {
    expect([340 * KB, 2 * MB, 3.4 * MB, 18 * MB, 22.4 * MB, 1.2 * GB, 100].map(sizeText)).toEqual([
      "340 KB",
      "2 MB",
      "3.4 MB",
      "18 MB",
      "22 MB",
      "1.2 GB",
      "1 KB",
    ]);
  });

  it("the quota line: GB with one decimal, MB under 1 GB, 0 when empty, the hint from 90 percent", () => {
    const q = (used: number, reserved = 0) => quotaLine({ used, reserved, limit: 5 * GB });
    expect(q(1.2 * GB)).toBe("1.2 of 5 GB used");
    expect(q(340 * MB)).toBe("340 MB of 5 GB used");
    expect(q(0)).toBe("0 of 5 GB used");
    expect(q(4.6 * GB)).toBe("4.6 of 5 GB used. Delete files or empty the trash to add more.");
    expect(q(5 * GB)).toBe("5 of 5 GB used. Delete files or empty the trash to add more.");
    // The bar counts reserved bytes, so an upload in flight can tip it over.
    expect(q(4.4 * GB, 0.2 * GB)).toContain("Delete files");
    expect(quotaShare({ used: GB, reserved: GB, limit: 4 * GB })).toBe(0.5);
  });

  it("the trash line and the Up Next limit come from the answer's numbers", () => {
    expect(trashUses(240 * MB, 5 * GB)).toBe("Trash uses 240 MB of your 5 GB.");
    expect(fullLine(12)).toBe("A talk takes up to 12 files. Untick one first.");
    expect(emptyTrashLine(3)).toBe("3 files are deleted for good. This can't be undone.");
    expect(emptyTrashLine(1)).toBe("1 file is deleted for good. This can't be undone.");
  });

  it("names each kind and its glyph, unknown ones as a plain file", () => {
    expect(["pptx", "PDF", "docx", "xlsx", "jpg", "mov", "zzz"].map((e) => kindOf(e).word)).toEqual([
      "PowerPoint",
      "PDF",
      "Word document",
      "Excel spreadsheet",
      "JPEG image",
      "QuickTime video",
      "File",
    ]);
    expect(kindOf("xlsx").glyph).toBe("file-spreadsheet");
    expect([pagesWord("pptx", 24), pagesWord("pdf", 1)]).toEqual(["24 slides", "1 page"]);
  });

  it("the date part: Edited today, Edited 3 Nov, Presented 10:02 when presenting came last", () => {
    expect(dateText({ updatedAt: NOW - 3_600_000 }, NOW, TZ)).toBe("Edited today");
    expect(dateText({ updatedAt: Date.UTC(2026, 10, 3, 9) }, NOW, TZ)).toBe("Edited 3 Nov");
    expect(
      dateText({ updatedAt: Date.UTC(2026, 10, 3), lastPresentedAt: Date.UTC(2026, 10, 26, 10, 2) }, NOW, TZ),
    ).toBe("Presented 10:02");
    expect(dateText({ updatedAt: Date.UTC(2026, 9, 1), lastPresentedAt: Date.UTC(2026, 10, 18, 10) }, NOW, TZ)).toBe(
      "Presented 18 Nov",
    );
    // The same day a year ago is not today.
    expect(dateText({ updatedAt: Date.UTC(2025, 10, 26, 11) }, NOW, TZ)).toBe("Edited 26 Nov");
  });

  it("each refusal says its one sentence, anything else the type sentence", () => {
    expect(["macros", "encrypted", "damaged", undefined, "x"].map(reasonOf)).toEqual([
      "This file has macros.",
      "This file is password protected.",
      "This file is damaged.",
      "This file type can't be shown in bloop.",
      "This file type can't be shown in bloop.",
    ]);
  });

  it("the font warning names one, two or three fonts, and counts more", () => {
    expect(fontSentence(["Aptos"])).toBe(
      "Aptos isn't on bloop's slides, so a close match is used. PowerPoint on the room PC may have it.",
    );
    expect(fontSentence(["Aptos", "Grandview"])).toBe(
      "Aptos and Grandview aren't on bloop's slides, so a close match is used. PowerPoint on the room PC may have them.",
    );
    expect(fontSentence(["A", "B", "C"])).toMatch(/^A, B and C aren't/);
    expect(fontSentence(["A", "B", "C", "D"])).toMatch(/^4 fonts aren't on bloop's slides/);
  });

  it("the trash countdown says tomorrow on the last day and is soon under 3 days", () => {
    const day = 86_400_000;
    expect(deletesIn(NOW + 29 * day, NOW)).toEqual({ text: "Deletes in 29 days", soon: false });
    expect(deletesIn(NOW + 2 * day, NOW)).toEqual({ text: "Deletes in 2 days", soon: true });
    expect(deletesIn(NOW + 3_600_000, NOW)).toEqual({ text: "Deletes tomorrow", soon: true });
  });

  it("progress and moves read as the spec writes them", () => {
    expect(preparingText(undefined, undefined)).toBe("Preparing Slides");
    expect(preparingText(12, 40)).toBe("12 of 40 Slides");
    expect(positionText("Lecture 5.pptx", 2, 3)).toBe("Lecture 5.pptx, position 2 of 3");
  });

  it("every string is US English, free of the never-say list, and titles are Title Case without a period", () => {
    const all = Object.values(T).join("\n").toLowerCase();
    expect(NEVER_SAY.filter((phrase) => all.includes(phrase))).toEqual([]);
    expect(all).not.toMatch(/cancelled|colour|organis/);
    const small = new Set("a an the and but or nor for as at by in of on to with is".split(" "));
    for (const key of ["title", "upNext", "allFiles", "movedTitle", "cleared", "fullTitle", "emptyTitle", "paused"]) {
      const text = T[key as keyof typeof T];
      expect(
        text.split(" ").filter((w) => /^[a-z]/.test(w) && !small.has(w)),
        text,
      ).toEqual([]);
      expect(text.endsWith("."), text).toBe(false);
    }
  });
});

describe("library rows", () => {
  it("a name's ellipsis always keeps the extension, however short the name", () => {
    expect(nameParts("Lecture 5.pptx")).toEqual(["Lecture 5", ".pptx"]);
    expect(nameParts("A very long lecture title that goes on.pptx")).toEqual([
      "A very long lecture title that go",
      "es on.pptx",
    ]);
    expect(nameParts("README")).toEqual(["README", ""]);
    expect(nameParts(".env")).toEqual([".env", ""]);
    expect(nameParts("a.b.tar")).toEqual(["a.b", ".tar"]);
  });

  it("only a ready, enabled, convertible, settled file gets a tick", () => {
    expect(canTick(row())).toBe(true);
    expect(canTick(row({ status: "checking" }))).toBe(false);
    expect(canTick(row({ disabled: true }))).toBe(false);
    expect(canTick(row({ derived: { state: "failed" } }))).toBe(false);
    expect(canTick(row({ upload: "u1" }))).toBe(false);
    // Preparing can be ticked: it opens in PowerPoint either way.
    expect(canTick(row({ derived: { state: "preparing" } }))).toBe(true);
  });

  it("line 2 is kind, size and date; a refused or disabled file says its reason instead", () => {
    expect(rowLine(row(), NOW, TZ)).toBe("PowerPoint · 18 MB · Edited today");
    expect(rowLine(row({ upload: "u1" }), NOW, TZ)).toBe("PowerPoint · 18 MB");
    expect(rowLine(row({ derived: { state: "failed" }, refusal: "macros" }), NOW, TZ)).toBe("");
    expect(status(row({ derived: { state: "failed" }, refusal: "macros" }))).toEqual({
      tone: "rose",
      chip: "Can't Show Slides",
      reason: "This file has macros.",
      fonts: "",
    });
    expect(status(row({ disabled: true })).chip).toBe("Unavailable");
    expect(status(row({ derived: { state: "preparing", done: 12, total: 40 } }))).toMatchObject({
      tone: "amber",
      chip: "12 of 40 Slides",
    });
    expect(status(row({ derived: { state: "ready", fontsMissing: ["A", "B"] } })).fonts).toBe("Missing 2 Fonts");
  });

  it("open uploads lead All Files, newest first, and an upload whose row exists is that row", () => {
    const l = list({
      uploads: [
        { uploadId: "u1", fileId: "n1", name: "Old.pptx", bytes: 10, createdAt: 1 },
        { uploadId: "u2", fileId: "n2", name: "New.pdf", bytes: 10, createdAt: 2 },
        { uploadId: "u3", fileId: "a", name: "Lecture 5.pptx", bytes: 10, createdAt: 3 },
      ],
      files: [row({ id: "a" }), row({ id: "r", status: "refused" })],
    });
    const rows = allRows(l);
    expect(rows.map((r) => [r.id, r.upload ?? null, r.ext])).toEqual([
      ["n2", "u2", "pdf"],
      ["n1", "u1", "pptx"],
      ["a", null, "pptx"],
    ]);
  });

  it("Up Next lists its rows in its order and skips an id with no row", () => {
    expect(upNextRows(list({ upNext: ["c", "zz", "a"] })).map((r) => r.id)).toEqual(["c", "a"]);
  });
});

describe("Up Next changes", () => {
  it("a tick appends, an untick removes, a doubled tick changes nothing, the 13th stays off", () => {
    expect(tick(["a"], "b", true, 12)).toEqual({ order: ["a", "b"], full: false });
    expect(tick(["a", "b"], "a", false, 12)).toEqual({ order: ["b"], full: false });
    expect(tick(["a"], "a", true, 12)).toEqual({ order: ["a"], full: false });
    const twelve = Array.from({ length: 12 }, (_, i) => `f${i}`);
    expect(tick(twelve, "x", true, 12)).toEqual({ order: twelve, full: true });
  });

  it("a move holds inside the ends", () => {
    expect(move(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(move(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(move(["a", "b", "c"], "a", 5)).toEqual(["b", "c", "a"]);
    expect(move(["a", "b"], "x", 1)).toEqual(["a", "b"]);
  });

  it("a row's new state mirrors into Up Next; a trashed row leaves both; an order sets every tick", () => {
    const l = list({ upNext: ["a"], files: [row({ id: "a", selected: true }), row({ id: "b" })] });
    expect(withRow(l, row({ id: "b", selected: true })).upNext).toEqual(["a", "b"]);
    expect(withRow(l, row({ id: "a", selected: false })).upNext).toEqual([]);
    expect(withRow(l, row({ id: "a", name: "New.pptx", selected: true })).files[0]?.name).toBe("New.pptx");
    const gone = withoutRow(l, "a");
    expect([gone.files.map((f) => f.id), gone.upNext]).toEqual([["b"], []]);
    const set = withOrder(l, ["b"]);
    expect(set.files.map((f) => f.selected)).toEqual([false, true]);
  });

  it("a stored copy that is not a list answer is no copy", () => {
    expect(cached(null)).toBeNull();
    expect(cached("{")).toBeNull();
    expect(cached('{"files": 1}')).toBeNull();
    expect(cached(JSON.stringify(list()))?.files).toHaveLength(3);
  });
});

describe("library fetch wrapper", () => {
  const reply = (status: number, body: string, headers: Record<string, string> = {}) =>
    (async () => new Response(status === 304 ? null : body, { status, headers })) as unknown as typeof fetch;

  it("sends JSON with the cookie on writes and nothing on reads", async () => {
    const seen: RequestInit[] = [];
    const net = createNet({
      fetch: (async (_path: string, init: RequestInit) => {
        seen.push(init);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await net.call("PATCH", "/api/library/a", { selected: true });
    await net.call("GET", "/api/library", undefined, { "If-None-Match": '"x"' });
    expect(seen.map((i) => [i.method, i.body ?? null, i.credentials])).toEqual([
      ["PATCH", '{"selected":true}', "same-origin"],
      ["GET", null, "same-origin"],
    ]);
    const [write, read] = seen.map((i) => i.headers as Record<string, string>);
    expect(write?.["Content-Type"]).toBe("application/json");
    expect(read?.["If-None-Match"]).toBe('"x"');
  });

  it("keeps 304 as unchanged, the server's code as the refusal, a thrown fetch as offline", async () => {
    expect(await createNet({ fetch: reply(304, "") }).call("GET", "/x")).toMatchObject({ ok: true, status: 304 });
    expect(await createNet({ fetch: reply(409, '{"code":"up_next_full"}') }).call("PATCH", "/x")).toMatchObject({
      ok: false,
      code: "up_next_full",
    });
    expect(await createNet({ fetch: reply(502, "<html>") }).call("GET", "/x")).toMatchObject({ code: "service_down" });
    expect(await createNet({ fetch: reply(200, "<html>") }).call("GET", "/x")).toMatchObject({
      code: "network_blocked",
    });
    const thrown = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await createNet({ fetch: thrown }).call("GET", "/x")).toMatchObject({ ok: false, code: "offline" });
  });

  it("a read that hangs past the timeout counts as offline", async () => {
    const hang = ((_p: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("abort"))),
      )) as unknown as typeof fetch;
    expect(await createNet({ fetch: hang, timeoutMs: 5 }).call("GET", "/x")).toMatchObject({ code: "offline" });
  });
});
