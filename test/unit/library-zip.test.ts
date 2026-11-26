import { spawnSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32 } from "../../src/worker/crc32.ts";
import { exportPath } from "../../src/worker/library/names.ts";
import { type Archive, type EntryInput, layoutArchive, piecesOf, type Segment } from "../../src/worker/library/zip.ts";
import { SPAWN_TIMEOUT } from "./spawn.ts";

const text = (s: string) => new TextEncoder().encode(s);
const when = new Date(Date.UTC(2026, 10, 26, 13, 45, 30));

function render(archive: Archive, objects: Record<string, Uint8Array>): Uint8Array {
  const out = new Uint8Array(archive.length);
  for (const s of archive.segments) {
    out.set("bytes" in s.source ? s.source.bytes : (objects[s.source.key] as Uint8Array), s.start);
  }
  return out;
}

const sample = (): { inputs: EntryInput[]; objects: Record<string, Uint8Array> } => {
  const deck = text("deck bytes ".repeat(100));
  return {
    objects: { "u/u1/a/v1/orig": deck },
    inputs: [
      { name: "README.txt", modified: when, bytes: text("hello") },
      { name: "Files/Lecture.pptx", modified: when, key: "u/u1/a/v1/orig", size: deck.length, crc: crc32(deck) },
      { name: "Files/empty.pdf", modified: when, bytes: new Uint8Array() },
      { name: "data.json", modified: when, bytes: text('{"format":"bloop-export"}') },
    ],
  };
};

/** An independent reader: end record, then the directory, then each local header. */
function read(zip: Uint8Array) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  let count = v.getUint16(end + 10, true);
  let size = v.getUint32(end + 12, true);
  let offset = v.getUint32(end + 16, true);
  if (offset === 0xffffffff || count === 0xffff) {
    const locator = end - 20;
    expect(v.getUint32(locator, true)).toBe(0x07064b50);
    const rec = Number(v.getBigUint64(locator + 8, true));
    expect(v.getUint32(rec, true)).toBe(0x06064b50);
    count = Number(v.getBigUint64(rec + 32, true));
    size = Number(v.getBigUint64(rec + 40, true));
    offset = Number(v.getBigUint64(rec + 48, true));
  }
  const entries = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const csize = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    let header = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (header === 0xffffffff) header = Number(v.getBigUint64(at + 46 + nameLen + 4, true));
    expect(v.getUint32(header, true)).toBe(0x04034b50);
    const localFlags = v.getUint16(header + 6, true);
    const localCrc = v.getUint32(header + 14, true);
    const localSize = v.getUint32(header + 18, true);
    const localName = v.getUint16(header + 26, true);
    const localExtra = v.getUint16(header + 28, true);
    const start = header + 30 + localName + localExtra;
    entries.push({
      name,
      flags,
      method,
      crc,
      size: csize,
      local: { flags: localFlags, crc: localCrc, size: localSize },
      data: zip.subarray(start, start + csize),
    });
    at += 46 + nameLen + extraLen;
  }
  expect(at).toBe(offset + size);
  return entries;
}

describe("LIB-07 zip layout", { timeout: SPAWN_TIMEOUT }, () => {
  it("reads back: names, bytes, STORE, UTF-8 flag set, descriptor flag clear, local CRC equals central", () => {
    const { inputs, objects } = sample();
    const archive = layoutArchive(inputs);
    const zip = render(archive, objects);
    expect(zip.length).toBe(archive.length);
    const got = read(zip);
    expect(got.map((e) => e.name)).toEqual(inputs.map((i) => i.name));
    for (const e of got) {
      expect(e.method).toBe(0);
      expect(e.flags & 0x0800).toBe(0x0800);
      expect(e.flags & 0x0008).toBe(0);
      expect(e.local).toEqual({ flags: e.flags, crc: e.crc, size: e.size });
      expect(crc32(e.data)).toBe(e.crc);
    }
    expect(new TextDecoder().decode(got[0]?.data)).toBe("hello");
    expect(got[1]?.data).toEqual(objects["u/u1/a/v1/orig"]);
    expect(got[2]?.size).toBe(0);
  });

  it("python's zipfile accepts it and its CRC test passes", () => {
    const probe = spawnSync("python3", ["--version"]);
    if (probe.status !== 0) return;
    const { inputs, objects } = sample();
    const dir = mkdtempSync(join(tmpdir(), "zip-"));
    try {
      const path = join(dir, "a.zip");
      writeFileSync(path, render(layoutArchive(inputs), objects));
      const r = spawnSync("python3", [
        "-I",
        "-c",
        "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip(), len(z.namelist()))",
        path,
      ]);
      expect(r.stdout.toString().trim()).toBe("None 4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("LIB-07 deterministic: the same entries give the same bytes, and the DOS time is the UTC time", () => {
    const { inputs, objects } = sample();
    const a = render(layoutArchive(inputs), objects);
    const b = render(layoutArchive(inputs), objects);
    expect(a).toEqual(b);
    const v = new DataView(a.buffer);
    const time = v.getUint16(10, true);
    const date = v.getUint16(12, true);
    expect([time >> 11, (time >> 5) & 63, (time & 31) * 2]).toEqual([13, 45, 30]);
    expect([(date >> 9) + 1980, (date >> 5) & 15, date & 31]).toEqual([2026, 11, 26]);
  });

  it("LIB-07 crc: only in-memory entries are hashed, and an object's CRC is the one given", () => {
    const { inputs } = sample();
    const archive = layoutArchive(inputs);
    const object = inputs[1] as Extract<EntryInput, { key: string }>;
    expect(archive.entries[1]).toEqual({ name: "Files/Lecture.pptx", size: object.size, crc: object.crc });
    const wrong = layoutArchive([{ ...object, crc: 7 }]);
    expect(wrong.entries[0]?.crc).toBe(7);
  });

  it("LIB-07 deterministic: a range from every segment boundary, plus or minus 1, joins to the whole", () => {
    const { inputs, objects } = sample();
    const archive = layoutArchive(inputs);
    const whole = render(archive, objects);
    const joined = (start: number, end: number) => {
      const parts = piecesOf(archive, start, end).map((p) => {
        const bytes = "bytes" in p.source ? p.source.bytes : (objects[p.source.key] as Uint8Array);
        return bytes.subarray(p.offset, p.offset + p.length);
      });
      return Uint8Array.from(parts.flatMap((p) => [...p]));
    };
    const cuts = new Set<number>([0, archive.length - 1]);
    for (const s of archive.segments)
      for (const d of [-1, 0, 1]) cuts.add(Math.min(Math.max(s.start + d, 0), archive.length - 1));
    for (const a of cuts) {
      expect(joined(a, archive.length - 1)).toEqual(whole.subarray(a));
      for (const b of cuts) if (b >= a) expect(joined(a, b)).toEqual(whole.subarray(a, b + 1));
    }
    expect(joined(0, 10 ** 9)).toEqual(whole);
  });

  it("refuses an entry that cannot be written: empty name, 64 KiB name, size past 32 bits", () => {
    expect(() => layoutArchive([{ name: "", modified: when, bytes: text("x") }])).toThrow(RangeError);
    expect(() => layoutArchive([{ name: "x".repeat(65536), modified: when, bytes: text("x") }])).toThrow(RangeError);
    expect(() => layoutArchive([{ name: "big", modified: when, key: "k", size: 0xffffffff, crc: 0 }])).toThrow(
      RangeError,
    );
  });

  it("LIB-07 zip64: past 4 GiB of offsets the directory gets the extra, the end record and the locator, and python reads it", () => {
    const sizes = 4_000_000_000;
    const inputs: EntryInput[] = [
      { name: "a.bin", modified: when, key: "a", size: sizes, crc: 1 },
      { name: "b.bin", modified: when, key: "b", size: sizes, crc: 2 },
      { name: "c.bin", modified: when, key: "c", size: 10, crc: 3 },
    ];
    const archive = layoutArchive(inputs);
    expect(archive.length).toBeGreaterThan(8_000_000_000);
    const probe = spawnSync("python3", ["--version"]);
    if (probe.status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "zip64-"));
    try {
      const path = join(dir, "big.zip");
      const fd = openSync(path, "w");
      ftruncateSync(fd, archive.length);
      const tail: Segment[] = archive.segments.filter((s) => "bytes" in s.source);
      for (const s of tail) writeSync(fd, (s.source as { bytes: Uint8Array }).bytes, 0, s.length, s.start);
      closeSync(fd);
      const r = spawnSync("python3", [
        "-I",
        "-c",
        "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print([(i.filename, i.header_offset, i.file_size) for i in z.infolist()])",
        path,
      ]);
      expect(r.status, r.stderr.toString()).toBe(0);
      expect(r.stdout.toString().trim()).toBe(
        "[('a.bin', 0, 4000000000), ('b.bin', 4000000035, 4000000000), ('c.bin', 8000000070, 10)]",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LIB-07 exportPath", () => {
  const paths = (folder: "Files" | "Trash", names: string[]) => {
    const used = new Set<string>();
    return names.map((n) => exportPath(folder, n, used));
  };

  it("prefixes the folder and keeps a plain name", () => {
    expect(paths("Files", ["Lecture.pptx"])).toEqual(["Files/Lecture.pptx"]);
    expect(paths("Trash", ["a.pdf"])).toEqual(["Trash/a.pdf"]);
  });

  it("dedupes without case, before the extension", () => {
    expect(paths("Files", ["Lecture.pptx", "lecture.PPTX", "LECTURE.pptx"])).toEqual([
      "Files/Lecture.pptx",
      "Files/lecture (2).PPTX",
      "Files/LECTURE (3).pptx",
    ]);
  });

  it("replaces separators, controls, bidi and Windows-forbidden characters, and cuts trailing dots and spaces", () => {
    expect(paths("Files", ["a/b\\c:d.pptx"])).toEqual(["Files/a_b_c_d.pptx"]);
    expect(paths("Files", [`x${String.fromCharCode(0x202e)}y\u0007z?.pdf`])).toEqual(["Files/x_y_z_.pdf"]);
    expect(paths("Files", ["name. . .pptx"])).toEqual(["Files/name.pptx"]);
    expect(paths("Files", ["..pptx"])).toEqual(["Files/file.pptx"]);
  });

  it("prefixes Windows device names", () => {
    expect(paths("Files", ["CON.pptx", "nul.pdf", "COM1.pdf", "console.pdf"])).toEqual([
      "Files/_CON.pptx",
      "Files/_nul.pdf",
      "Files/_COM1.pdf",
      "Files/console.pdf",
    ]);
  });

  it("nit: a device name is judged by the part before the first dot, and CONIN$ and CONOUT$ are devices", () => {
    expect(paths("Files", ["CON.tar.gz", "nul.backup.pdf", "CONIN$.pdf", "conout$.pdf", "com.ok.pdf"])).toEqual([
      "Files/_CON.tar.gz",
      "Files/_nul.backup.pdf",
      "Files/_CONIN$.pdf",
      "Files/_conout$.pdf",
      "Files/com.ok.pdf",
    ]);
  });

  it("nit: a lone surrogate becomes an underscore, and a whole emoji stays", () => {
    expect(paths("Files", ["a\ud800b.pdf", "😀.pdf"])).toEqual(["Files/a_b.pdf", "Files/😀.pdf"]);
  });

  it("holds the name to 200 UTF-8 bytes, cut on a character, keeping the extension, even when deduped", () => {
    const long = `${"é".repeat(150)}.pptx`;
    const [a, b] = paths("Files", [long, long]);
    for (const p of [a, b] as string[]) {
      expect(new TextEncoder().encode(p.slice("Files/".length)).length).toBeLessThanOrEqual(200);
      expect(p.endsWith(".pptx")).toBe(true);
    }
    expect(a).not.toBe(b);
    expect(b).toContain(" (2).pptx");
  });

  it("NFC-normalizes, so a decomposed and a composed name collide", () => {
    expect(paths("Files", ["é.pdf", "é.pdf"])).toEqual(["Files/é.pdf", "Files/é (2).pdf"]);
  });

  it("a name that is only refused characters or dots still gets a path", () => {
    expect(paths("Files", ["...", " "])[0]).toBe("Files/file");
  });
});
