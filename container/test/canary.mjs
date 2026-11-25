// Listens on a loopback port and logs one line per connection. The corpus runs it inside a converter's
// network namespace, so a converter that fetched an external relationship would leave a line behind.
// Usage: node canary.mjs <port> <logfile>; it exits when its stdin closes or receives anything.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const [port, log] = [Number(process.argv[2]), process.argv[3]];
writeFileSync(log, "");
const server = createServer((socket) => {
  appendFileSync(log, "connection\n");
  socket.on("error", () => {});
  socket.destroy();
});
server.listen(port, "127.0.0.1", () => process.stdout.write("listening\n"));
process.stdin.on("data", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
