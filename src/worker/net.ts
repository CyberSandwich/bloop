/** An IPv6 address as its eight groups, a compressed form expanded. */
function groups(ip: string): number[] {
  const [head = "", tail] = ip.split("::");
  const parts = (part: string) => (part === "" ? [] : part.split(":"));
  const front = parts(head);
  const back = tail === undefined ? [] : parts(tail);
  const full = [...front, ...new Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return full.map((g) => Number.parseInt(g, 16));
}

const DOTTED_TAIL = /:(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * The network a client address belongs to: an IPv6 host rotates through its whole /64, so that prefix stands for it.
 * An IPv4-mapped address (`::ffff:a.b.c.d`, or its hex form `::ffff:cb00:7109`) is its IPv4 address: as a /64 every
 * mapped client would share the key `0:0:0:0`. A zone id (`%eth0`) names an interface, not a host, and is dropped.
 */
export function network(address: string): string {
  if (!address.includes(":")) return address;
  const ip = address.replace(/%.*$/, "");
  const dotted = DOTTED_TAIL.exec(ip);
  // A dotted tail stands for the last two groups.
  const g = groups(dotted ? `${ip.slice(0, dotted.index + 1)}0:0` : ip);
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    if (dotted) return dotted[1] as string;
    const [hi = 0, lo = 0] = g.slice(6);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return g
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(":");
}
