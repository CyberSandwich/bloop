import { readFileSync } from "node:fs";

/** The phrases in tools/never-say.txt, lowercased: one per line, `#` lines are comments. */
export const NEVER_SAY = readFileSync(new URL("../../tools/never-say.txt", import.meta.url), "utf8")
  .split("\n")
  .map((l) => l.trim().toLowerCase())
  .filter((l) => l && !l.startsWith("#"));
