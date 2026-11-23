// The Screen object's storage schema: numbered steps (CLAUDE.md "Durable Object schema"). Each step checks the data's
// shape and writes only what is still old, and every step runs on every wake whatever the stored version: a rollback
// that wrote old-shape data under a newer version is repaired by the next deploy.
import type { FileRef, Machine } from "../machine.ts";
import type { LinkRecord } from "../seams/open-path/links.ts";
import type { Kv } from "./ledger.ts";

export const SCHEMA_KEY = "schemaVersion";
/** Version 1 had no key: a session held one `file`, and a link record had no `item`. */
export const SCHEMA_VERSION = 3;

type Session = NonNullable<Machine["session"]>;
type V1Session = Omit<Session, "items" | "mints"> & { file: FileRef; mints: number };

const STEPS: Record<number, (kv: Kv) => void> = {
  // 1 to 2: the session holds a list; the one file becomes a one-item list, and every link served item 0.
  2: (kv) => {
    const m = kv.get<Omit<Machine, "session"> & { session: V1Session | Machine["session"] }>("machine");
    if (m?.session && "file" in m.session) {
      const { file, ...rest } = m.session;
      kv.put("machine", { ...m, session: { ...rest, items: [{ kind: "file", ...file }] } });
    }
    const links = kv.get<(Omit<LinkRecord, "item"> & { item?: number })[]>("links");
    if (links?.some((r) => r.item === undefined)) {
      kv.put(
        "links",
        links.map((r) => ({ item: 0, ...r })),
      );
    }
  },
  // 2 to 3: the mint count is per item. The session-wide count stands for every item, so none gains a mint.
  3: (kv) => {
    const m = kv.get<
      Omit<Machine, "session"> & { session: (Omit<Session, "mints"> & { mints: number | number[] }) | null }
    >("machine");
    const s = m?.session;
    if (s && typeof s.mints === "number") {
      const count = s.mints;
      kv.put("machine", { ...m, session: { ...s, mints: s.items.map(() => count) } });
    }
  },
};

/** Brings stored state to SCHEMA_VERSION's shape. A fresh object (no `meta`) is written at the current version by `create`. */
export function migrate(kv: Kv): void {
  if (kv.get("meta") === undefined) return;
  for (let version = 2; version <= SCHEMA_VERSION; version++) STEPS[version]?.(kv);
  if (kv.get<number>(SCHEMA_KEY) !== SCHEMA_VERSION) kv.put(SCHEMA_KEY, SCHEMA_VERSION);
}
