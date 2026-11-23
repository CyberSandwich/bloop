// The Screen object's storage schema: numbered steps, each run once, in order, when an object wakes on an older
// version (CLAUDE.md "Durable Object schema"). A step never edits what an earlier one wrote in place.
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
    const links = kv.get<Omit<LinkRecord, "item">[]>("links");
    if (links)
      kv.put(
        "links",
        links.map((r) => ({ item: 0, ...r })),
      );
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

/** Brings stored state up to SCHEMA_VERSION. A fresh object (no `meta`) is written at the current version by `create`. */
export function migrate(kv: Kv): void {
  if (kv.get("meta") === undefined) return;
  let version = kv.get<number>(SCHEMA_KEY) ?? 1;
  while (version < SCHEMA_VERSION) {
    version += 1;
    STEPS[version]?.(kv);
    kv.put(SCHEMA_KEY, version);
  }
}
