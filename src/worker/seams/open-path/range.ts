// One `Range: bytes=` request against a body of known size (RFC 9110 14.2). A request with several ranges, or a
// header that does not parse, is refused rather than answered whole: nothing here guesses what a client meant (VID-02).

export interface ByteRange {
  offset: number;
  length: number;
}

const SPEC = /^bytes=(\d*)-(\d*)$/;

/** The one range the header asks for, or `unsatisfiable` (416) for anything out of bounds, malformed or multiple. */
export function parseRange(header: string, size: number): ByteRange | "unsatisfiable" {
  const m = SPEC.exec(header.trim());
  if (!m || size <= 0) return "unsatisfiable";
  const [first, last] = [m[1] as string, m[2] as string];
  if (first === "" && last === "") return "unsatisfiable";
  if (first === "") {
    // A suffix: the last n bytes, clamped to the whole body.
    const n = Number(last);
    return n === 0 ? "unsatisfiable" : { offset: Math.max(0, size - n), length: Math.min(n, size) };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}
