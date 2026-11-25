/** The network a client address belongs to: an IPv6 host rotates through its whole /64, so that prefix stands for it. */
export function network(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [head = "", tail] = ip.split("::");
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const full = [...front, ...new Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return full
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":");
}
