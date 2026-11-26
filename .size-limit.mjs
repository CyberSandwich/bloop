// Every budget lives in tools/size/<area>.json (ADR 0025); size-limit reads the merged list from here. requests.json is
// the request budget the e2e reads, not a size entry.
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("./tools/size/", import.meta.url);

export default readdirSync(dir)
  .filter((file) => file.endsWith(".json") && file !== "requests.json")
  .sort()
  .flatMap((file) => JSON.parse(readFileSync(new URL(file, dir), "utf8")));
