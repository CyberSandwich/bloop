// CRC-32 (zip, PNG). Shared by every zip writer and reader.
const MASK = 0xffffffff;
const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 of `data`, continuing from `previous` (0 to start): `crc32(b, crc32(a))` is the CRC of `a` then `b`. */
export function crc32(data: Uint8Array, previous = 0): number {
  let c = (previous ^ MASK) >>> 0;
  for (let i = 0; i < data.length; i++) c = (TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ MASK) >>> 0;
}
