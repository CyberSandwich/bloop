// The account export (docs/library.md, export): a snapshot of the user's account and library, laid out as a zip whose every
// byte is known before the first is sent. Nothing here hashes a stored file (its CRC is the row's) and every object key is
// asserted under the user's own prefix before it is read (LIB-07, LIB-01).
import { hmacHex } from "../ids.ts";
import type { LibraryBucket } from "./bucket.ts";
import { exportPath } from "./names.ts";
import type { LibDb } from "./store.ts";
import { type Archive, type EntryInput, layoutArchive, type Piece, piecesOf } from "./zip.ts";

export const EXPORT_FORMAT = "bloop-export";
export const EXPORT_VERSION = 1;

interface AccountRow {
  email: string | null;
  created_at: number;
  terms_version: string | null;
  terms_accepted_at: number | null;
  quota_bytes: number | null;
  used_bytes: number;
}

interface FileRecord {
  id: string;
  name: string;
  ext: string;
  bytes: number;
  r2_key: string;
  sha256: string | null;
  crc32: number | null;
  version: number;
  status: string;
  created_at: number;
  updated_at: number;
  last_presented_at: number | null;
  selected_at: number | null;
  trashed_at: number | null;
  purge_after: number | null;
  disabled_at: number | null;
  pages: number | null;
  has_notes: number | null;
  fonts_missing: string | null;
}

/** Everything the archive is made from; the same snapshot always lays out the same bytes. */
export interface Snapshot {
  userId: string;
  account: AccountRow;
  sessions: { label: string | null; method: string | null; created_at: number }[];
  passkeys: { name: string; created_at: number; last_used_at: number | null; backed_up: number }[];
  files: FileRecord[];
  /** The rows `/api/me/audit` shows: `at` is the row's time, `record` the shape that route answers. */
  audit: readonly { at: number; record: unknown }[];
  defaultQuotaBytes: number;
  /** The moment the snapshot stands for: a resume reuses the first run's, so the same archive comes out again. */
  takenAt: number;
}

export async function takeSnapshot(
  db: LibDb,
  userId: string,
  audit: Snapshot["audit"],
  defaultQuotaBytes: number,
  takenAt: number,
): Promise<Snapshot> {
  const account = await db
    .prepare(
      `SELECT email, created_at, terms_version, terms_accepted_at, quota_bytes, used_bytes
       FROM app_user WHERE id = ?1`,
    )
    .bind(userId)
    .first<AccountRow>();
  if (!account) throw new Error("export: no such user");
  const sessions = await db
    .prepare("SELECT label, method, created_at FROM phone_session WHERE user_id = ?1 ORDER BY created_at, public_id")
    .bind(userId)
    .all<Snapshot["sessions"][number]>();
  const passkeys = await db
    .prepare("SELECT name, created_at, last_used_at, backed_up FROM passkey WHERE user_id = ?1 ORDER BY created_at, id")
    .bind(userId)
    .all<Snapshot["passkeys"][number]>();
  const files = await db
    .prepare(
      `SELECT f.id, f.name, f.ext, f.bytes, f.r2_key, f.sha256, f.crc32, f.version, f.status, f.created_at, f.updated_at,
              f.last_presented_at, f.selected_at, f.trashed_at, f.purge_after, f.disabled_at,
              d.pages, d.has_notes, d.fonts_missing
       FROM library_file f LEFT JOIN derived d ON d.file_id = f.id AND d.version = f.version
       WHERE f.user_id = ?1 AND f.status != 'purged' ORDER BY f.id`,
    )
    .bind(userId)
    .all<FileRecord>();
  return {
    userId,
    account,
    sessions: sessions.results,
    passkeys: passkeys.results,
    files: files.results,
    audit: audit.filter((a) => a.at <= takenAt),
    defaultQuotaBytes,
    takenAt,
  };
}

/**
 * A file's bytes go in the archive when it has settled, is not disabled and is not already due for deletion at the
 * snapshot's moment (its purge may be running); such a file is listed without them.
 */
const included = (f: FileRecord, takenAt: number): boolean =>
  f.status === "ready" && f.disabled_at === null && !(f.purge_after !== null && f.purge_after <= takenAt);

const parseList = (text: string | null): unknown => {
  if (text === null) return [];
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
};

const readme = (snapshotAt: number, counts: { files: number; trash: number; disabled: number }): string =>
  [
    "This is your bloop export.",
    "",
    `Taken from your account as it stood at ${new Date(snapshotAt).toISOString()}.`,
    "",
    `Files/      your ${counts.files} file${counts.files === 1 ? "" : "s"}, with the names they have in your library.`,
    `Trash/      ${counts.trash} file${counts.trash === 1 ? "" : "s"} in your trash, which bloop deletes for good after its retention period.`,
    "data.json   your account details, sessions, passkeys (names only, no keys), your audit trail (without the exports themselves) and one line per file.",
    "",
    counts.disabled > 0
      ? `${counts.disabled} file${counts.disabled === 1 ? " was" : "s were"} disabled after a report. ${counts.disabled === 1 ? "It is" : "They are"} listed in data.json and their contents are not included.`
      : "No file was disabled.",
    "",
  ].join("\n");

export interface BuiltExport {
  archive: Archive;
  etag: string;
  snapshotAt: number;
}

/** The newest change the snapshot shows, so the archive does not depend on the wall clock. */
const snapshotTime = (s: Snapshot): number =>
  Math.max(0, ...s.files.map((f) => f.updated_at), ...s.audit.map((a) => a.at));

/** The ETag changes with anything the archive holds, and cannot be computed by someone who does not hold the key. */
async function etagFor(key: string, userId: string, entries: Archive["entries"]): Promise<string> {
  return `"${(await hmacHex(key, `${userId}\n${JSON.stringify(entries)}`)).slice(0, 32)}"`;
}

export async function buildExport(s: Snapshot, tokenKey: string): Promise<BuiltExport> {
  const snapshotAt = snapshotTime(s);
  const at = new Date(snapshotAt);
  const used = new Set<string>();
  const live = s.files.filter((f) => included(f, s.takenAt));
  const paths = new Map<string, string>();
  const place = (folder: "Files" | "Trash", files: FileRecord[]) =>
    files.map((f): EntryInput => {
      if (f.crc32 === null) throw new Error("export: a settled file has no crc");
      const path = exportPath(folder, f.name, used);
      paths.set(f.id, path);
      return {
        name: path,
        modified: new Date(f.updated_at),
        key: f.r2_key,
        size: f.bytes,
        crc: f.crc32,
      };
    });
  const filesEntries = place(
    "Files",
    live.filter((f) => f.trashed_at === null),
  );
  const trashEntries = place(
    "Trash",
    live.filter((f) => f.trashed_at !== null),
  );
  const selected = s.files
    .filter((f) => f.selected_at !== null)
    .sort((a, b) => (a.selected_at as number) - (b.selected_at as number) || a.id.localeCompare(b.id));
  const position = new Map(selected.map((f, i) => [f.id, i + 1]));
  const data = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    snapshotAt,
    account: {
      email: s.account.email,
      createdAt: s.account.created_at,
      termsVersion: s.account.terms_version,
      termsAcceptedAt: s.account.terms_accepted_at,
      quotaBytes: s.account.quota_bytes ?? s.defaultQuotaBytes,
      usedBytes: s.account.used_bytes,
    },
    sessions: s.sessions.map((x) => ({
      label: x.label,
      method: x.method,
      createdAt: x.created_at,
    })),
    passkeys: s.passkeys.map((x) => ({
      name: x.name,
      createdAt: x.created_at,
      lastUsedAt: x.last_used_at,
      backedUp: x.backed_up === 1,
    })),
    files: s.files.map((f) => ({
      id: f.id,
      path: paths.get(f.id) ?? null,
      name: f.name,
      ext: f.ext,
      bytes: f.bytes,
      sha256: f.sha256,
      crc32: f.crc32,
      version: f.version,
      status: f.status,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
      lastPresentedAt: f.last_presented_at,
      upNextPosition: position.get(f.id) ?? null,
      trashedAt: f.trashed_at,
      purgeAfter: f.purge_after,
      disabled: f.disabled_at !== null,
      derived: {
        pages: f.pages,
        hasNotes: f.has_notes === null ? null : f.has_notes === 1,
        fontsMissing: parseList(f.fonts_missing),
      },
    })),
    audit: s.audit.map((a) => a.record),
  };
  const encoder = new TextEncoder();
  const counts = {
    files: filesEntries.length,
    trash: trashEntries.length,
    disabled: s.files.filter((f) => f.disabled_at !== null).length,
  };
  const archive = layoutArchive([
    { name: "README.txt", modified: at, bytes: encoder.encode(readme(snapshotAt, counts)) },
    ...filesEntries,
    ...trashEntries,
    { name: "data.json", modified: at, bytes: encoder.encode(JSON.stringify(data, null, 2)) },
  ]);
  return { archive, etag: await etagFor(tokenKey, s.userId, archive.entries), snapshotAt };
}

/** The download's name, from the day it was taken. */
export const exportFilename = (now: number): string => `bloop-export-${new Date(now).toISOString().slice(0, 10)}.zip`;

/** While bytes flow, `beat` runs at most this often; the export lease is a few multiples of it. */
export const BEAT_MS = 60_000;

/**
 * Bytes `start` to `end` inclusive, in order. `done` runs once, on the end, a cancel or an error. `beat` renews the
 * lease while the client keeps reading; a download nobody reads stops beating, so its lease lapses by itself.
 */
export function exportStream(
  archive: Archive,
  start: number,
  end: number,
  source: { userId: string; bucket: LibraryBucket; now?: () => number },
  done: () => Promise<void>,
  beat: () => Promise<unknown> = async () => {},
): ReadableStream<Uint8Array> {
  const pieces = piecesOf(archive, start, end);
  const prefix = `u/${source.userId}/`;
  const clock = source.now ?? Date.now;
  let lastBeat = clock();
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let remaining = 0;
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await done();
  };
  const open = async (piece: Piece): Promise<void> => {
    if ("bytes" in piece.source) {
      const bytes = piece.source.bytes.subarray(piece.offset, piece.offset + piece.length);
      reader = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }).getReader();
    } else {
      const { key } = piece.source;
      if (!key.startsWith(prefix)) throw new Error("export: key outside the user's prefix");
      const whole = archive.segments.find((s) => "key" in s.source && s.source.key === key)?.length;
      const object = await source.bucket.get(
        key,
        piece.offset === 0 && piece.length === whole
          ? undefined
          : { range: { offset: piece.offset, length: piece.length } },
      );
      if (!object || object.size !== whole) throw new Error("export: object missing or changed");
      reader = object.body.getReader();
    }
    remaining = piece.length;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (clock() - lastBeat >= BEAT_MS) {
          lastBeat = clock();
          // A lease that could not be renewed only means the download may be cut later; the bytes still flow.
          await beat().catch(() => {});
        }
        for (;;) {
          if (reader === null) {
            const piece = pieces[next++];
            if (!piece) {
              controller.close();
              await finish();
              return;
            }
            await open(piece);
          }
          const read = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
          if (read.done) {
            if (remaining !== 0) throw new Error("export: object shorter than its entry");
            reader = null;
            continue;
          }
          remaining -= read.value.length;
          if (remaining < 0) throw new Error("export: object longer than its entry");
          controller.enqueue(read.value);
          return;
        }
      } catch (error) {
        controller.error(error);
        await reader?.cancel().catch(() => {});
        await finish();
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason).catch(() => {});
      await finish();
    },
  });
}
