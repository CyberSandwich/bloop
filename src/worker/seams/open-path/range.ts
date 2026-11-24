// One `Range: bytes=` request against a body of known size (RFC 9110 14.2). A header that does not parse, names
// another unit or asks for several ranges is ignored and the body is answered whole (200), as the RFC allows; only a
// well-formed single range that the body cannot satisfy is refused (416) (VID-02).

export interface ByteRange {
  offset: number;
  length: number;
}

/** The unit is case-insensitive; whitespace may sit around the range. A comma (several ranges) does not match. */
const SPEC = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i;

/** The one range the header asks for, `unsatisfiable` (416) when out of bounds, or null to ignore the header. */
export function parseRange(header: string, size: number): ByteRange | "unsatisfiable" | null {
  const m = SPEC.exec(header);
  if (!m) return null;
  const [first, last] = [m[1] as string, m[2] as string];
  if (first === "" && last === "") return null;
  if (first === "") {
    // A suffix: the last n bytes, clamped to the whole body.
    const n = Number(last);
    return n === 0 || size <= 0 ? "unsatisfiable" : { offset: Math.max(0, size - n), length: Math.min(n, size) };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return null; // invalid syntax, not unsatisfiable
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return { offset: start, length: end - start + 1 };
}
