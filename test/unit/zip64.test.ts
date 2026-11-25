import { describe, expect, it } from "vitest";
import { crc32 } from "../../src/worker/crc32.ts";
import { centralRecord, endRecords, Zip64Writer } from "../../src/worker/library/zip64.ts";

const enc = new TextEncoder();
const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);
const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

interface Parsed {
  name: string;
  data: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

/** A minimal reader: end records (zip64 first), then the central directory, then each local entry and its descriptor. */
function readZip(zip: Uint8Array, { skipData = false } = {}): Parsed[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(u32(v, eocd)).toBe(0x06054b50);
  let [count, cdSize, cdOffset] = [u16(v, eocd + 10), u32(v, eocd + 12), u32(v, eocd + 16)];
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    expect(u32(v, eocd - 20)).toBe(0x07064b50);
    const at = u64(v, eocd - 20 + 8);
    expect(u32(v, at)).toBe(0x06064b50);
    [count, cdSize, cdOffset] = [u64(v, at + 32), u64(v, at + 40), u64(v, at + 48)];
    expect(at).toBe(cdOffset + cdSize);
  }
  const out: Parsed[] = [];
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    expect(u32(v, pos)).toBe(0x02014b50);
    const crc = u32(v, pos + 16);
    let size = u32(v, pos + 24);
    let offset = u32(v, pos + 42);
    const [nameLen, extraLen, commentLen] = [u16(v, pos + 28), u16(v, pos + 30), u16(v, pos + 32)];
    const name = new TextDecoder().decode(zip.subarray(pos + 46, pos + 46 + nameLen));
    let x = pos + 46 + nameLen;
    const extraEnd = x + extraLen;
    while (x < extraEnd) {
      const [id, len] = [u16(v, x), u16(v, x + 2)];
      if (id === 1) {
        let f = x + 4;
        if (u32(v, pos + 24) === 0xffffffff) {
          size = u64(v, f);
          f += 16;
        }
        if (u32(v, pos + 42) === 0xffffffff) offset = u64(v, f);
      }
      x += 4 + len;
    }
    pos = extraEnd + commentLen;
    let data: Uint8Array = new Uint8Array();
    if (!skipData) {
      expect(u32(v, offset)).toBe(0x04034b50);
      expect(u16(v, offset + 6) & 0x0808).toBe(0x0808);
      const start = offset + 30 + u16(v, offset + 26) + u16(v, offset + 28);
      data = zip.subarray(start, start + size);
      expect(u32(v, start + size)).toBe(0x08074b50);
      expect(u32(v, start + size + 4)).toBe(crc);
      expect(u64(v, start + size + 8)).toBe(size);
      expect(u64(v, start + size + 16)).toBe(size);
      expect(crc32(data)).toBe(crc);
    }
    out.push({ name, data, crc, size, offset });
  }
  expect(pos).toBe(cdOffset + cdSize);
  return out;
}

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });

async function build(entries: [string, Uint8Array[]][]): Promise<Uint8Array> {
  const zip = new Zip64Writer();
  const collected = new Response(zip.readable).arrayBuffer();
  for (const [name, chunks] of entries) await zip.add(name, streamOf(...chunks));
  await zip.finish();
  return new Uint8Array(await collected);
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("continues across chunks", () => {
    const [a, b] = [enc.encode("1234"), enc.encode("56789")];
    expect(crc32(b, crc32(a))).toBe(0xcbf43926);
  });
});

describe("zip64 writer", () => {
  it("writes entries that read back byte for byte", async () => {
    const big = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251);
    const zip = await build([
      ["data.json", [enc.encode('{"a":1}')]],
      ["files/é 中.bin", [big.subarray(0, 100_000), big.subarray(100_000, 200_000), big.subarray(200_000)]],
      ["empty.txt", []],
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["data.json", "files/é 中.bin", "empty.txt"]);
    expect(new TextDecoder().decode(entries[0]?.data)).toBe('{"a":1}');
    expect(entries[1]?.data).toEqual(big);
    expect(entries[2]?.size).toBe(0);
  });

  it("writes a valid archive with no entries", async () => {
    expect(readZip(await build([]))).toEqual([]);
  });

  it("stays valid past 65535 entries (zip64 end records)", async () => {
    const zip = await build(
      Array.from({ length: 70_000 }, (_, i) => [`f${i}`, i % 1000 === 0 ? [enc.encode(`#${i}`)] : []]),
    );
    const entries = readZip(zip);
    expect(entries).toHaveLength(70_000);
    expect(entries[69_999]?.name).toBe("f69999");
    expect(new TextDecoder().decode(entries[69_000]?.data)).toBe("#69000");
  }, 30_000);

  it("writes classic end records only while counts and offsets fit", async () => {
    const zip = await build([["a", [enc.encode("x")]]]);
    const v = new DataView(zip.buffer);
    expect(u32(v, zip.length - 22)).toBe(0x06054b50);
    expect(u32(v, zip.length - 22 - 20)).not.toBe(0x07064b50);
  });

  it("rejects a second add while an entry is open and a name over 65535 bytes", async () => {
    const zip = new Zip64Writer();
    void new Response(zip.readable).arrayBuffer().catch(() => {});
    let open!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        open = c;
      },
    });
    const first = zip.add("a", body);
    await expect(zip.add("b", streamOf())).rejects.toThrow("another entry is open");
    open.close();
    await first;
    const second = new Zip64Writer();
    void new Response(second.readable).arrayBuffer().catch(() => {});
    await expect(second.add("x".repeat(70_000), streamOf())).rejects.toThrow("name too long");
  });

  it("aborts the archive when a body fails", async () => {
    const zip = new Zip64Writer();
    const collected = new Response(zip.readable).arrayBuffer();
    const failing = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("partial"));
        c.error(new Error("source failed"));
      },
    });
    await expect(zip.add("a", failing)).rejects.toThrow("source failed");
    await expect(collected).rejects.toThrow("source failed");
  });
});

describe("zip64 records past 4 GiB", () => {
  const GIB = 2 ** 30;
  const record = {
    name: enc.encode("huge.bin"),
    crc: 0x12345678,
    size: 5 * GIB,
    offset: 6 * GIB,
    modified: new Date(2026, 0, 2),
  };

  it("moves a size and an offset over 32 bits into the zip64 extra", () => {
    const v = new DataView(centralRecord(record).buffer);
    expect(u32(v, 20)).toBe(0xffffffff);
    expect(u32(v, 24)).toBe(0xffffffff);
    expect(u32(v, 42)).toBe(0xffffffff);
    const extraAt = 46 + record.name.length;
    expect(u16(v, extraAt)).toBe(1);
    expect(u16(v, extraAt + 2)).toBe(24);
    expect([u64(v, extraAt + 4), u64(v, extraAt + 12), u64(v, extraAt + 20)]).toEqual([5 * GIB, 5 * GIB, 6 * GIB]);
  });

  it("keeps small values in the 32-bit fields", () => {
    const v = new DataView(centralRecord({ ...record, size: 10, offset: 20 }).buffer);
    expect([u32(v, 20), u32(v, 24), u32(v, 42), u16(v, 30)]).toEqual([10, 10, 20, 0]);
  });

  it("writes an offset-only extra when only the offset is large", () => {
    const v = new DataView(centralRecord({ ...record, size: 10 }).buffer);
    expect([u32(v, 24), u32(v, 42), u16(v, 30)]).toEqual([10, 0xffffffff, 12]);
  });

  it("builds the zip64 end record and locator for a directory past 4 GiB", () => {
    const end = endRecords(3, 200, 5 * GIB);
    const v = new DataView(end.buffer);
    expect(u32(v, 0)).toBe(0x06064b50);
    expect([u64(v, 32), u64(v, 40), u64(v, 48)]).toEqual([3, 200, 5 * GIB]);
    expect(u32(v, 56)).toBe(0x07064b50);
    expect(u64(v, 64)).toBe(5 * GIB + 200);
    expect([u16(v, 76 + 10), u32(v, 76 + 12), u32(v, 76 + 16)]).toEqual([0xffff, 0xffffffff, 0xffffffff]);
    expect(end.length).toBe(56 + 20 + 22);
  });
});

describe("zip64 entry names", () => {
  const stored = async (...names: string[]) =>
    readZip(await build(names.map((n) => [n, [enc.encode("x")]]))).map((e) => e.name);

  it("maps backslashes to slashes and drops drive letters, leading slashes and empty segments", async () => {
    expect(await stored("a\\b\\c.txt", "/abs/path.txt", "C:\\win\\x.txt", "d:rel.txt", "p//q.txt")).toEqual([
      "a/b/c.txt",
      "abs/path.txt",
      "win/x.txt",
      "rel.txt",
      "p/q.txt",
    ]);
  });

  it.each(["../evil", "a/../../evil", "a/./b", "..\\evil", "a/..", ".", "/", "", "C:\\"])(
    "rejects %j",
    async (name) => {
      const zip = new Zip64Writer();
      void new Response(zip.readable).arrayBuffer().catch(() => {});
      await expect(zip.add(name, streamOf())).rejects.toThrow("unsafe entry name");
    },
  );

  it.each(["a\x00b", "a\x01b", "a\x1fb", "a\x7fb", "a\nb"])("rejects control characters in %j", async (name) => {
    const zip = new Zip64Writer();
    void new Response(zip.readable).arrayBuffer().catch(() => {});
    await expect(zip.add(name, streamOf())).rejects.toThrow("unsafe entry name");
  });

  it("keeps the archive usable after rejecting a name", async () => {
    const zip = new Zip64Writer();
    const collected = new Response(zip.readable).arrayBuffer();
    await expect(zip.add("../x", streamOf())).rejects.toThrow();
    await zip.add("ok.txt", streamOf(enc.encode("fine")));
    await zip.finish();
    expect(readZip(new Uint8Array(await collected)).map((e) => e.name)).toEqual(["ok.txt"]);
  });

  it("numbers a repeated name before its extension, without regard to case", async () => {
    expect(await stored("a.txt", "a.txt", "A.TXT", "dir/b", "dir/b", "dir.v1/c", "dir.v1/c")).toEqual([
      "a.txt",
      "a (2).txt",
      "A (3).TXT",
      "dir/b",
      "dir/b (2)",
      "dir.v1/c",
      "dir.v1/c (2)",
    ]);
  });

  it("does not treat a leading dot as an extension", async () => {
    expect(await stored(".env", ".env")).toEqual([".env", ".env (2)"]);
  });

  it("clamps a date outside 1980 to 2107 and still reads back", async () => {
    const zip = new Zip64Writer();
    const collected = new Response(zip.readable).arrayBuffer();
    await zip.add("old", streamOf(), new Date(1970, 0, 1));
    await zip.add("far", streamOf(), new Date(2300, 5, 5));
    await zip.finish();
    const out = new Uint8Array(await collected);
    const v = new DataView(out.buffer);
    const years: number[] = [];
    for (let at = u32(v, out.length - 22 + 16), n = 0; n < 2; n++) {
      years.push(1980 + (u16(v, at + 14) >> 9));
      at += 46 + u16(v, at + 28) + u16(v, at + 30);
    }
    expect(years).toEqual([1980, 2107]);
  });
});
