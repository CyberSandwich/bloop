// A small reader and writer for version 3 Compound File Binary files (the container of .doc, .xls,
// .ppt), enough to add storages to a file LibreOffice wrote. Files over about 7 MB are refused.
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FATSECT = 0xfffffffd;
const SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;

/** Parses a CFB into a tree: {name, type: "root"|"storage"|"stream", children: [], data?: Buffer}. */
export function readCfb(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a compound file");
  if (buf.readUInt16LE(26) !== 3) throw new Error("only version 3 is supported");
  const sector = (n) => buf.subarray((n + 1) * SECTOR, (n + 2) * SECTOR);
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s !== FREE) difat.push(s);
  }
  let next = buf.readUInt32LE(68);
  while (next !== END && next !== FREE) {
    const sec = sector(next);
    for (let i = 0; i < 127; i++) {
      const s = sec.readUInt32LE(i * 4);
      if (s !== FREE) difat.push(s);
    }
    next = sec.readUInt32LE(508);
  }
  const fat = [];
  for (const s of difat) {
    const sec = sector(s);
    for (let i = 0; i < SECTOR / 4; i++) fat.push(sec.readUInt32LE(i * 4));
  }
  const chain = (start) => {
    const out = [];
    for (let s = start, guard = 0; s !== END && s !== FREE; s = fat[s], guard++) {
      if (s === undefined || guard > fat.length) throw new Error("broken sector chain");
      out.push(s);
    }
    return out;
  };
  const read = (start, size) => Buffer.concat(chain(start).map(sector)).subarray(0, size);

  const dir = read(buf.readUInt32LE(48), Infinity);
  const entries = [];
  for (let i = 0; i + 128 <= dir.length; i += 128) {
    const e = dir.subarray(i, i + 128);
    const type = e[66];
    if (type === 0) {
      entries.push(null);
      continue;
    }
    const nameLen = e.readUInt16LE(64);
    entries.push({
      name: e.subarray(0, Math.max(0, nameLen - 2)).toString("utf16le"),
      type: type === 5 ? "root" : type === 1 ? "storage" : "stream",
      left: e.readUInt32LE(68),
      right: e.readUInt32LE(72),
      child: e.readUInt32LE(76),
      start: e.readUInt32LE(116),
      size: e.readUInt32LE(120),
    });
  }
  const root = entries[0];
  const miniStream = read(root.start, root.size);
  const miniFat = [];
  for (const s of chain(buf.readUInt32LE(60))) {
    const sec = sector(s);
    for (let i = 0; i < SECTOR / 4; i++) miniFat.push(sec.readUInt32LE(i * 4));
  }
  const miniRead = (start, size) => {
    const parts = [];
    for (let s = start, guard = 0; s !== END && s !== FREE; s = miniFat[s], guard++) {
      if (s === undefined || guard > miniFat.length) throw new Error("broken mini chain");
      parts.push(miniStream.subarray(s * MINI, (s + 1) * MINI));
    }
    return Buffer.concat(parts).subarray(0, size);
  };
  const build = (id) => {
    const e = entries[id];
    const node = { name: e.name, type: e.type, children: [] };
    if (e.type === "stream") node.data = e.size < CUTOFF ? miniRead(e.start, e.size) : read(e.start, e.size);
    const walk = (n) => {
      if (n === FREE) return;
      walk(entries[n].left);
      node.children.push(build(n));
      walk(entries[n].right);
    };
    if (e.type !== "stream") walk(e.child);
    return node;
  };
  return build(0);
}

const cmpNames = (a, b) =>
  a.name.length - b.name.length ||
  (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : a.name.toUpperCase() > b.name.toUpperCase() ? 1 : 0);

/** Serializes a tree from readCfb (or built by hand) to a version 3 compound file. */
export function writeCfb(root) {
  const flat = [];
  const addNode = (node) => {
    const id = flat.length;
    flat.push({ node, left: FREE, right: FREE, child: FREE, start: END, size: 0 });
    node.children?.sort(cmpNames);
    const ids = (node.children ?? []).map(addNode);
    const tree = (lo, hi) => {
      if (lo > hi) return FREE;
      const mid = (lo + hi) >> 1;
      flat[ids[mid]].left = tree(lo, mid - 1);
      flat[ids[mid]].right = tree(mid + 1, hi);
      return ids[mid];
    };
    flat[id].child = tree(0, ids.length - 1);
    return id;
  };
  addNode(root);

  const sectors = []; // Buffers, in order
  const fatEntries = [];
  const place = (data) => {
    const count = Math.max(1, Math.ceil(data.length / SECTOR));
    const first = sectors.length;
    for (let i = 0; i < count; i++) {
      const s = Buffer.alloc(SECTOR);
      data.copy(s, 0, i * SECTOR, Math.min(data.length, (i + 1) * SECTOR));
      sectors.push(s);
      fatEntries[first + i] = i === count - 1 ? END : first + i + 1;
    }
    return first;
  };

  const mini = [];
  const miniFat = [];
  for (const f of flat) {
    const d = f.node.data;
    if (f.node.type !== "stream") continue;
    f.size = d.length;
    if (d.length === 0) continue;
    if (d.length >= CUTOFF) {
      f.start = place(d);
    } else {
      const count = Math.ceil(d.length / MINI);
      f.start = miniFat.length;
      for (let i = 0; i < count; i++) {
        const s = Buffer.alloc(MINI);
        d.copy(s, 0, i * MINI, Math.min(d.length, (i + 1) * MINI));
        mini.push(s);
        miniFat.push(i === count - 1 ? END : miniFat.length + 1);
      }
    }
  }
  const rootEntry = flat[0];
  if (mini.length) {
    const ms = Buffer.concat(mini);
    rootEntry.start = place(ms);
    rootEntry.size = mini.length * MINI;
  }
  let miniFatStart = END;
  if (miniFat.length) {
    const mf = Buffer.alloc(Math.ceil(miniFat.length / 128) * SECTOR, 0xff);
    miniFat.forEach((v, i) => mf.writeUInt32LE(v, i * 4));
    miniFatStart = place(mf);
  }
  const dirBuf = Buffer.alloc(Math.ceil(flat.length / 4) * SECTOR);
  flat.forEach((f, i) => {
    const e = dirBuf.subarray(i * 128, (i + 1) * 128);
    const name = Buffer.from(f.node.name, "utf16le");
    name.copy(e, 0);
    e.writeUInt16LE(name.length + 2, 64);
    e[66] = f.node.type === "root" ? 5 : f.node.type === "storage" ? 1 : 2;
    e[67] = 1;
    e.writeUInt32LE(f.left, 68);
    e.writeUInt32LE(f.right, 72);
    e.writeUInt32LE(f.child, 76);
    e.writeUInt32LE(f.start, 116);
    e.writeUInt32LE(f.size, 120);
  });
  // Unused directory slots must read as free: type 0 and sibling links of NOSTREAM.
  for (let i = flat.length; i < dirBuf.length / 128; i++) {
    const e = dirBuf.subarray(i * 128, (i + 1) * 128);
    e.writeUInt32LE(FREE, 68);
    e.writeUInt32LE(FREE, 72);
    e.writeUInt32LE(FREE, 76);
  }
  const dirStart = place(dirBuf);

  let fatSectors = 1;
  while (Math.ceil((sectors.length + fatSectors) / 128) > fatSectors) fatSectors++;
  if (fatSectors > 109) throw new Error("file too large for this writer");
  const fatStart = sectors.length;
  for (let i = 0; i < fatSectors; i++) {
    sectors.push(Buffer.alloc(SECTOR));
    fatEntries[fatStart + i] = FATSECT;
  }
  const fatBuf = Buffer.concat(sectors.slice(fatStart));
  fatBuf.fill(0xff);
  fatEntries.forEach((v, i) => fatBuf.writeUInt32LE(v, i * 4));
  for (let i = 0; i < fatSectors; i++) fatBuf.copy(sectors[fatStart + i], 0, i * SECTOR, (i + 1) * SECTOR);

  const header = Buffer.alloc(SECTOR, 0);
  SIG.copy(header);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(dirStart, 48);
  header.writeUInt32LE(CUTOFF, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFat.length ? Math.ceil(miniFat.length / 128) : 0, 64);
  header.writeUInt32LE(END, 68);
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? fatStart + i : FREE, 76 + i * 4);
  return Buffer.concat([header, ...sectors]);
}

/** Finds a storage or stream by path, e.g. ["_VBA_PROJECT_CUR", "VBA", "dir"]. */
export function find(node, path) {
  return path.reduce((n, name) => n?.children?.find((c) => c.name === name), node);
}
