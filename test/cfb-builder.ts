// Crafts small Compound File Binary files (version 3, 512 byte sectors) for the DROP-12 tests.
const SECTOR = 512;
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FATSECT = 0xfffffffd;
const ENTRIES_PER_SECTOR = SECTOR / 128;
const FAT_PER_SECTOR = SECTOR / 4;

export interface CfbOptions {
  /** Make the last directory sector link back to the first. */
  cyclic?: boolean;
  /** Add a DIFAT sector that links to itself. */
  difatCycle?: boolean;
  /** Point the directory start past the end of the file. */
  outOfRange?: boolean;
  /** The type byte of the last directory entry (1 storage, 2 stream, 5 root). */
  lastEntryType?: number;
}

export function buildCfb(names: string[], options: CfbOptions = {}): Uint8Array {
  const entries = ["Root Entry", ...names];
  const dirSectors = Math.ceil(entries.length / ENTRIES_PER_SECTOR);
  let fatSectors = 1;
  while (fatSectors * FAT_PER_SECTOR < fatSectors + dirSectors) fatSectors++;
  const extra = options.difatCycle ? 1 : 0;
  const total = fatSectors + dirSectors + extra;
  const out = new Uint8Array(SECTOR + total * SECTOR);
  const v = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  v.setUint16(24, 0x3e, true);
  v.setUint16(26, 3, true);
  v.setUint16(28, 0xfffe, true);
  v.setUint16(30, 9, true);
  v.setUint16(32, 6, true);
  v.setUint32(44, fatSectors, true);
  v.setUint32(48, options.outOfRange ? total + 10 : fatSectors, true);
  v.setUint32(56, 4096, true);
  v.setUint32(60, END, true);
  v.setUint32(68, options.difatCycle ? fatSectors + dirSectors : END, true);
  v.setUint32(72, options.difatCycle ? 1 : 0, true);
  for (let i = 0; i < 109; i++) v.setUint32(76 + i * 4, i < fatSectors ? i : FREE, true);

  const fat = new Uint32Array(fatSectors * FAT_PER_SECTOR).fill(FREE);
  for (let i = 0; i < fatSectors; i++) fat[i] = FATSECT;
  for (let i = 0; i < dirSectors; i++)
    fat[fatSectors + i] = i === dirSectors - 1 ? (options.cyclic ? fatSectors : END) : fatSectors + i + 1;
  const fatBytes = new Uint8Array(fat.buffer);
  out.set(fatBytes, SECTOR);

  const dirStart = SECTOR + fatSectors * SECTOR;
  entries.forEach((name, i) => {
    const at = dirStart + i * 128;
    for (let c = 0; c < name.length; c++) v.setUint16(at + c * 2, name.charCodeAt(c), true);
    v.setUint16(at + 64, (name.length + 1) * 2, true);
    const last = i === entries.length - 1 && options.lastEntryType !== undefined;
    v.setUint8(at + 66, last ? (options.lastEntryType as number) : i === 0 ? 5 : 1);
    v.setUint8(at + 67, 1);
    for (const off of [68, 72, 76]) v.setUint32(at + off, FREE, true);
  });
  if (options.difatCycle) {
    const at = SECTOR + (fatSectors + dirSectors) * SECTOR;
    for (let i = 0; i < FAT_PER_SECTOR - 1; i++) v.setUint32(at + i * 4, FREE, true);
    v.setUint32(at + SECTOR - 4, fatSectors + dirSectors, true);
  }
  return out;
}
