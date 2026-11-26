// The Screen object's storage schema, and the shared `applySteps` every object's numbered steps run through
// (docs/architecture.md 8.3, ADR 0002). Each step checks the data's shape and writes only what is still old, and every
// step runs on every wake whatever the stored version: a rollback that wrote old-shape data under a newer version is
// repaired by the next deploy.
import { LINK_PURPOSES } from "../../shared/protocol.ts";
import {
  type ItemDraft,
  type ItemRef,
  kindOf,
  launchIndex,
  shownFault,
  shownSchema,
  validDerived,
  validExtra,
  validLibraryRef,
  withIds,
} from "../items.ts";
import type { FileRef, Machine } from "../machine.ts";
import type { LinkRecord } from "../seams/open-path/links.ts";
import { idemRepair } from "../seams/pairing/idem.ts";
import type { Meta } from "../views.ts";
import type { Kv } from "./ledger.ts";

export const SCHEMA_KEY = "schemaVersion";
/** Version 1 had no key: a session held one `file`, and a link record had no `item`. */
export const SCHEMA_VERSION = 8;

type Session = NonNullable<Machine["session"]>;
type V1Session = Omit<Session, "items" | "minted"> & { file: FileRef; mints: number };
/** Versions 2 and 3: `mints` counted extra links, session-wide (2) or per item (3); the launch item's first was free. */
type OldMints = Omit<Session, "minted"> & { mints: number | number[] };
/** Versions 1 to 5: no item ids, no `shown`, no `seq`. */
type PreRemote = Omit<Session, "items" | "shown" | "seq"> & {
  items: (ItemDraft & { id?: string })[];
  shown?: unknown;
  seq?: unknown;
};

/** One numbered step: `now` is the wake's clock, for a step that has to stamp a change. */
type Step = (kv: Kv, now: number) => void;

const STEPS: Record<number, Step> = {
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
    const m = kv.get<Omit<Machine, "session"> & { session: OldMints | null }>("machine");
    const s = m?.session;
    if (s && typeof s.mints === "number") {
      const count = s.mints;
      kv.put("machine", { ...m, session: { ...s, mints: s.items.map(() => count) } });
    }
  },
  // 3 to 4: `minted` counts every link per item, the first included, so each item's first is free alike. The launch
  // item's free first was not in \`mints\`: add it.
  4: (kv) => {
    const m = kv.get<Omit<Machine, "session"> & { session: OldMints | Session | null }>("machine");
    const s = m?.session;
    if (s && "mints" in s && Array.isArray(s.mints)) {
      const { mints, ...rest } = s;
      const launch = launchIndex(s.items);
      kv.put("machine", { ...m, session: { ...rest, minted: mints.map((n, i) => (i === launch ? n + 1 : n)) } });
    }
  },
  // 4 to 5: a link record keeps the view-link audit state: the foreign IP hashes already audited, and whether a
  // refusal was. An old record has audited neither.
  5: (kv) => {
    const links = kv.get<(Omit<LinkRecord, "ips" | "refused"> & Partial<LinkRecord>)[]>("links");
    if (links?.some((r) => r.ips === undefined || r.refused === undefined)) {
      kv.put(
        "links",
        links.map((r) => ({ ips: [], refused: false, ...r })),
      );
    }
  },
  // 5 to 6: every item holds an `id`, and the session a `shown` and a `seq` per sender. Ids follow the stored order,
  // the order approval froze. A `shown` that names no file of this list or a page outside it becomes null, and so does
  // any `shown` once the list is renumbered, since its id may now name another item.
  6: (kv) => {
    const m = kv.get<Omit<Machine, "session"> & { session: PreRemote | null }>("machine");
    const s = m?.session;
    if (!m || !s) return;
    const hasIds = s.items.every((i) => typeof i.id === "string");
    const items = withIds(s.items);
    const shownOk =
      s.shown === null || (hasIds && validShown(s.shown, items, { mode: m.mode, kind: m.pairing?.kind ?? null }));
    const seqOk = isSeq(s.seq);
    if (hasIds && shownOk && seqOk) return;
    const seq = seqOk ? s.seq : { phone: 0, screen: 0 };
    kv.put("machine", { ...m, session: { ...s, items, shown: shownOk ? s.shown : null, seq } });
  },
  // 6 to 7: the machine counts its applied changes in `v`, which every view carries. Missing, or not a whole number,
  // it starts again at 0.
  7: (kv) => {
    const m = kv.get<Omit<Machine, "v"> & { v?: unknown }>("machine");
    if (m && !Number.isSafeInteger(m.v)) kv.put("machine", { ...m, v: 0 });
  },
  // 7 to 8: the live pick, kinds and conversion flags, upload progress, the start clock and the link origin.
  8: (kv, now) => {
    const meta = kv.get<Omit<Meta, "linkOrigin"> & { linkOrigin?: unknown }>("meta");
    if (meta && meta.linkOrigin !== "file" && meta.linkOrigin !== "main")
      kv.put("meta", { ...meta, linkOrigin: "file" });
    const m = kv.get<Machine>("machine");
    const repaired = m && repairMachine(m, now);
    if (m && repaired && repaired !== m) kv.put("machine", repaired);
    const endedNow = m?.state !== "ended" && repaired?.state === "ended";
    // A purpose this build does not know fails closed, so a record from a rolled-back build is never served.
    const purposes: readonly string[] = LINK_PURPOSES;
    const dead = (r: LinkRecord) => endedNow || !purposes.includes(r.purpose);
    const links = kv.get<LinkRecord[]>("links");
    if (links?.some((r) => !r.revoked && dead(r))) {
      kv.put(
        "links",
        links.map((r) => (r.revoked || !dead(r) ? r : { ...r, revoked: true })),
      );
    }
  },
};

const isNullableInt = (v: unknown): boolean => v === null || Number.isSafeInteger(v);
const KINDS: readonly unknown[] = ["deck", "pdf", "doc", "sheet", "text", "image", "video"];

/** Three distinct two-digit strings, the match among them. */
const validChoices = (v: unknown, match: string): boolean =>
  Array.isArray(v) &&
  v.length === 3 &&
  new Set(v).size === 3 &&
  v.every((c) => typeof c === "string" && /^\d{2}$/.test(c)) &&
  v.includes(match);

const validUpload = (v: unknown): boolean => {
  const u = v as { bytes?: unknown; total?: unknown } | null;
  return (
    u === null ||
    (typeof u === "object" &&
      Object.keys(u).length === 2 &&
      Number.isSafeInteger(u.bytes) &&
      Number.isSafeInteger(u.total) &&
      (u.bytes as number) >= 0 &&
      (u.bytes as number) <= (u.total as number))
  );
};

/** Step 8 over one stored machine: the same object when nothing is old, so the caller writes only a change. */
function repairMachine(m: Machine, now: number): Machine {
  let next = m;
  const p = m.pairing;
  if (p) {
    // A pairing from before the pick was paired under the passive match: refusing it would strand an approved talk.
    const confirmed = typeof p.confirmed === "boolean" ? p.confirmed : true;
    const choices = p.choices === null || validChoices(p.choices, p.match) ? (p.choices ?? null) : null;
    const phoneSession = typeof p.phoneSession === "string" ? p.phoneSession : null;
    if (confirmed !== p.confirmed || choices !== p.choices || phoneSession !== p.phoneSession) {
      next = { ...next, pairing: { ...p, confirmed, choices, phoneSession } };
    }
  }
  if (!validUpload(m.upload ?? null) || m.upload === undefined) next = { ...next, upload: null };
  const s = m.session;
  if (!s) return next;
  // A malformed library ref can never be served: the session ends rather than carry it.
  if (s.items.some((i) => i.kind === "file" && i.source === "library" && !validLibraryRef(i.ref))) {
    return endCorrupt(next, now);
  }
  const items = s.items.map((i) => {
    if (i.kind !== "file") return i;
    const show = i.show !== undefined && KINDS.includes(i.show) ? i.show : kindOf(i.type);
    const derived = i.derived === null || validDerived(i.derived) ? (i.derived ?? null) : null;
    return show === i.show && derived === i.derived ? i : { ...i, show, derived };
  });
  const extraOk =
    s.extra !== null &&
    typeof s.extra === "object" &&
    !Array.isArray(s.extra) &&
    Object.values(s.extra).every((e) => validExtra(e));
  const clock = (v: unknown) => (isNullableInt(v) ? (v as number | null) : null);
  const session = {
    ...s,
    items: items.every((i, n) => i === s.items[n]) ? s.items : items,
    extra: extraOk && s.extra ? s.extra : {},
    firstShownAt: clock(s.firstShownAt ?? null),
    startedAt: clock(s.startedAt ?? null),
    startBy: clock(s.startBy ?? null),
  };
  const same =
    session.items === s.items &&
    session.extra === s.extra &&
    session.firstShownAt === s.firstShownAt &&
    session.startedAt === s.startedAt &&
    session.startBy === s.startBy;
  return same ? next : { ...next, session };
}

/** The end `endSession` makes, without its effects; step 8 revokes the links. A code left in the Directory just lapses. */
const endCorrupt = (m: Machine, now: number): Machine => ({
  ...m,
  state: "ended",
  codes: { current: null, previous: null },
  pairing: m.pairing && { ...m.pairing, listed: [], userId: null, phoneSession: null, passHash: null },
  session: null,
  upload: null,
  uploadAt: null,
  offerAt: null,
  endedAt: now,
  endReason: "error",
  // With no socket the object closes at its next alarm; an open screen reads "ended" and asks for a new code.
  closeAt: m.sockets === 0 ? now : null,
});

const validShown = (v: unknown, items: readonly ItemRef[], view: Parameters<typeof shownFault>[2]): boolean => {
  const parsed = shownSchema.safeParse(v);
  return parsed.success && shownFault(items, parsed.data, view, true) === null;
};

const isSeq = (v: unknown): v is Session["seq"] => {
  const seq = v as Session["seq"] | null | undefined;
  return Number.isSafeInteger(seq?.phone) && Number.isSafeInteger(seq?.screen);
};

/**
 * Runs every numbered step up to `version`, then records it. Shared by every object that keeps a `schemaVersion`.
 * The stored version only rises: an older deploy after a newer one never lowers it.
 */
export function applySteps(kv: Kv, steps: Record<number, Step>, version: number, now = Date.now()): void {
  for (let v = 2; v <= version; v++) steps[v]?.(kv, now);
  const stored = kv.get<number>(SCHEMA_KEY);
  if (!Number.isSafeInteger(stored) || (stored as number) < version) kv.put(SCHEMA_KEY, version);
}

/**
 * Brings stored state to SCHEMA_VERSION's shape. A fresh object (no `meta`) is written at the current version by
 * `create`. `now` stamps an end a step makes; the idempotency rows are shape-checked by their adapter.
 */
export function migrate(kv: Kv, now = Date.now()): void {
  if (kv.get("meta") === undefined) return;
  applySteps(kv, STEPS, SCHEMA_VERSION, now);
  idemRepair(kv);
}
