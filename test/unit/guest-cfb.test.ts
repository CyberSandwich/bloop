import { describe, expect, it } from "vitest";
import { CFB_LIMITS, scanCfb } from "../../src/worker/seams/guest-drop/cfb.ts";
import { buildCfb } from "../cfb-builder.ts";
import { reader } from "../zip-builder.ts";

const scan = (names: string[], options = {}) => scanCfb(reader(buildCfb(names, options)));
const WORD = ["WordDocument", "1Table", "\x05SummaryInformation"];

describe("DROP-12 cfb: clean files", () => {
  it("passes a document with only its own streams", async () => {
    expect(await scan(WORD)).toEqual({ ok: true });
  });

  it("passes a directory that spans several sectors", async () => {
    expect(await scan(Array.from({ length: 40 }, (_, i) => `Stream${i}`))).toEqual({ ok: true });
  });
});

describe("DROP-12 cfb: refused storages", () => {
  it.each([
    ["Word macros", ["WordDocument", "Macros", "VBA", "dir"], "macro storage"],
    ["Excel macros", ["Workbook", "_VBA_PROJECT_CUR"], "macro storage"],
    ["embedded objects", [...WORD, "ObjectPool"], "embedded object"],
    ["a packaged object", [...WORD, "\x01Ole10Native"], "embedded object"],
    ["an encrypted package", ["EncryptionInfo", "EncryptedPackage"], "encrypted storage"],
    ["data spaces", ["\x06DataSpaces", "WordDocument"], "encrypted storage"],
  ])("refuses %s", async (_, names, reason) => {
    const verdict = await scan(names);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason });
  });

  it("maps macros to macro_content and encryption to bad_structure", async () => {
    expect(await scan(["VBA"])).toMatchObject({ error: "macro_content" });
    expect(await scan(["EncryptedPackage"])).toMatchObject({ error: "bad_structure" });
  });

  it("compares names without case", async () => {
    expect(await scan(["objectpool"])).toMatchObject({ ok: false, reason: "embedded object" });
    expect(await scan(["vba"])).toMatchObject({ ok: false, reason: "macro storage" });
  });
});

describe("DROP-12 cfb: hostile structure is bounded", () => {
  it("stops on a cyclic directory chain", async () => {
    expect(await scan(WORD, { cyclic: true })).toMatchObject({ ok: false, reason: "cfb directory chain" });
  });

  it("stops on a DIFAT sector that links to itself", async () => {
    expect(await scan(WORD, { difatCycle: true })).toMatchObject({ ok: false, error: "bad_structure" });
  });

  it("stops reading at the sector budget and refuses the file as unscannable", async () => {
    const names = Array.from({ length: 4 * CFB_LIMITS.maxSectorReads }, (_, i) => `S${i}`);
    const file = buildCfb(names);
    let reads = 0;
    const counted = {
      size: file.length,
      read: async (at: number, n: number) => {
        reads++;
        return file.slice(at, at + n);
      },
    };
    expect(await scanCfb(counted)).toMatchObject({ ok: false, reason: "cfb unscannable" });
    expect(reads).toBe(CFB_LIMITS.maxSectorReads + 1);
  });

  it("passes a directory that fits the budget", async () => {
    const names = Array.from({ length: 4 * (CFB_LIMITS.maxSectorReads - 6) }, (_, i) => `S${i}`);
    expect(await scan(names)).toEqual({ ok: true });
  });

  it.each([3, 4, 6, 255])("refuses a directory entry of type %i", async (type) => {
    expect(await scan(WORD, { lastEntryType: type })).toMatchObject({ ok: false, reason: "cfb entry type" });
  });

  it("skips an unallocated entry", async () => {
    expect(await scan(WORD, { lastEntryType: 0 })).toEqual({ ok: true });
  });

  it("refuses a directory sector past the end of the file", async () => {
    expect(await scan(WORD, { outOfRange: true })).toMatchObject({ ok: false, reason: "cfb directory sector" });
  });

  it("refuses a short file and a wrong magic as bad_type", async () => {
    expect(await scanCfb(reader(new Uint8Array(100)))).toMatchObject({ ok: false, error: "bad_type" });
    expect(await scanCfb(reader(new Uint8Array(1024)))).toMatchObject({ ok: false, error: "bad_type" });
  });

  it("refuses a header with a bad sector size", async () => {
    const file = buildCfb(WORD);
    new DataView(file.buffer).setUint16(30, 7, true);
    expect(await scanCfb(reader(file))).toMatchObject({ ok: false, reason: "cfb header" });
  });

  it("refuses a file cut off inside the directory", async () => {
    const file = buildCfb(WORD);
    expect(await scanCfb(reader(file.slice(0, 512 + 512)))).toMatchObject({ ok: false, error: "bad_structure" });
  });
});
