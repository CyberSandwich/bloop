// How a validator reads a stored object. Every `RangeReader.read` is a billed R2 operation and a D1 meter write
// (r2.ts), so a validator never loops over entries calling the reader: it asks `readParts` for all the parts it
// needs, through a reader from `planReads`.
//
//   small object  read whole, once; every later read is a slice of it
//   large object  at most `maxReads` reads, then `ReadBudgetExceeded`; `readParts` sorts the wanted entries by
//                 offset and coalesces near ones into one range per cluster
//
// The sizes a zip declares are claims (zip.ts): here `compressed` only sizes the bytes a read asks for, which are
// bounded by `maxEach` and `maxTotal` and by the real object size, and are measured once they arrive.
import type { RangeReader } from "./index.ts";
import { dataStart, LOCAL_HEADER_BYTES, type ZipEntry } from "./zip.ts";

export const READ_PLAN = {
  /**
   * Up to this size the object is read whole in one operation. 16 MiB is an eighth of the 128 MB isolate, leaving
   * room for the inflate buffers, and covers nearly every deck; a larger one pays for ranges.
   */
  smallObjectBytes: 16 * 1024 * 1024,
  /** Reads one validation may spend on a large object: head, end record, directory, then the coalesced parts. */
  maxReads: 64,
  /** Wanted entries closer than this share a read, so a deck's slide and rels parts (small, adjacent) cost one. */
  coalesceGapBytes: 1024 * 1024,
  /** A shared read never grows past this (one entry larger than it still gets its own). */
  maxReadBytes: 8 * 1024 * 1024,
  /** Room after the name for the local header's extra field; a longer one costs one more read. */
  headerSlackBytes: 1024,
} as const;

export class ReadBudgetExceeded extends Error {}

/** A reader whose operations stay within the plan: one whole-object read, or at most `maxReads` range reads. */
export function planReads(r: RangeReader): RangeReader {
  if (r.size <= READ_PLAN.smallObjectBytes) {
    let whole: Promise<Uint8Array> | undefined;
    return {
      size: r.size,
      read: async (offset, length) => {
        whole ??= r.read(0, r.size);
        return (await whole).subarray(offset, offset + length);
      },
    };
  }
  let reads = 0;
  return {
    size: r.size,
    read: (offset, length) => {
      if (++reads > READ_PLAN.maxReads) throw new ReadBudgetExceeded();
      return r.read(offset, length);
    },
  };
}

interface Want {
  index: number;
  entry: ZipEntry;
  start: number;
  end: number;
}

/**
 * The stored bytes of each entry (still compressed when its method is deflate), in the order given; null for one
 * whose local header is not where the directory says. Null overall when one entry is over `maxEach` bytes or all
 * are over `maxTotal`. Copies each part out, so no part pins a shared read.
 */
export async function readParts(
  r: RangeReader,
  entries: readonly ZipEntry[],
  limits: { maxEach: number; maxTotal: number },
): Promise<(Uint8Array | null)[] | null> {
  if (entries.some((e) => e.compressed > limits.maxEach)) return null;
  if (entries.reduce((n, e) => n + e.compressed, 0) > limits.maxTotal) return null;
  const encoder = new TextEncoder();
  const wants: Want[] = entries
    .map((entry, index) => {
      const head = LOCAL_HEADER_BYTES + encoder.encode(entry.name).length + READ_PLAN.headerSlackBytes;
      return {
        index,
        entry,
        start: entry.localOffset,
        end: Math.min(r.size, entry.localOffset + head + entry.compressed),
      };
    })
    .filter((w) => w.start < r.size)
    .sort((a, b) => a.start - b.start);

  const out: (Uint8Array | null)[] = entries.map(() => null);
  const take = async (group: Want[], from: number, to: number) => {
    const bytes = await r.read(from, to - from);
    for (const w of group) {
      const at = dataStart(bytes, w.start - from);
      if (at === null) continue;
      const size = w.entry.compressed;
      if (at + size <= bytes.length) out[w.index] = bytes.slice(at, at + size);
      else if (from + at + size <= r.size) {
        const rest = await r.read(from + at, size);
        out[w.index] = rest.length === size ? rest.slice() : null;
      }
    }
  };

  let group: Want[] = [];
  let [from, to] = [0, 0];
  for (const w of wants) {
    const apart = w.start - to > READ_PLAN.coalesceGapBytes || Math.max(to, w.end) - from > READ_PLAN.maxReadBytes;
    if (group.length > 0 && apart) {
      await take(group, from, to);
      group = [];
    }
    if (group.length === 0) [from, to] = [w.start, w.end];
    group.push(w);
    to = Math.max(to, w.end);
  }
  if (group.length > 0) await take(group, from, to);
  return out;
}
