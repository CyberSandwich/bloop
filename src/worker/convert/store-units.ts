// The store: what the Converter does with a finished job's outputs, one bounded unit per alarm. Every claim the
// container makes is checked again here (outputs.ts); a bad file drops its group, never the others'.
import type { JobRecord, Plan } from "../do/converter-schema.ts";
import { ContainerFault, type Courier } from "./courier.ts";
import { type Located, outputKey } from "./keys.ts";
import {
  buildSlidesJson,
  checkMeta,
  checkNotes,
  checkSlides,
  decideGroups,
  type Group,
  OutputError,
  type Piece,
  type PieceCtx,
  packPlan,
  sha256Hex,
  storedPaths,
} from "./outputs.ts";
import type { Profile } from "./profile.ts";
import { type ConvBucket, checkManifestFor, type ManifestName } from "./store-types.ts";

export interface StoreEnv {
  courier: Courier;
  /** Which of the container's manifests this store reads. */
  manifest: ManifestName;
  bucket: ConvBucket;
  loc: Located;
  profile: Profile;
  jobId: string;
  lengthStream(size: number): TransformStream<Uint8Array, Uint8Array>;
  /** Saves the record (a no-op once the run has ended). */
  persist(j: JobRecord): Promise<void>;
  /** True while this run still owns the record. */
  mine(j: JobRecord): Promise<boolean>;
  pageReady(): Promise<void>;
}

/** The unit names in the order they run: page 1 first, then the packs, then everything a reader needs last. */
export const unitOrder = (widths: readonly number[]): string[] => [
  "first",
  ...widths.map((w) => `pack:${w}`),
  "media",
  "image",
  "pdf",
  "notes",
  "slides.json",
];

const groupOfUnit = (unit: string): Group =>
  unit === "pdf"
    ? "pdf"
    : unit === "notes"
      ? "notes"
      : unit === "media"
        ? "media"
        : unit === "image"
          ? "image"
          : "slides";

/** The first unit at or after `from` whose group still passes, or null when the store is done. */
export function nextUnit(plan: Plan, widths: readonly number[], from: number): { unit: string; index: number } | null {
  const order = unitOrder(widths);
  for (let index = from; index < order.length; index++) {
    const unit = order[index] as string;
    if (plan.passed.includes(groupOfUnit(unit))) return { unit, index };
  }
  return null;
}

const ok = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (e) {
    if (e instanceof OutputError) return null;
    throw e;
  }
};

/** The checked manifest as parsed, so a container that answers differently later is caught (every claim is re-read). */
const manifestDigest = (manifest: unknown): Promise<string> =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));

/** Unit 0: the manifest and the three JSON files, so every later unit reads only checked values. */
export async function prepare(env: StoreEnv, j: JobRecord): Promise<{ fail: string } | null> {
  const loaded = await checkManifestFor(env.courier, {
    jobId: env.jobId,
    ext: env.loc.ext,
    profile: env.profile,
    manifest: env.manifest,
  });
  if ("fault" in loaded) return { fail: "output_invalid" };
  const { pieces, rendered, total } = loaded;
  const passed = new Set<Group>(loaded.passed);
  const kind = loaded.manifest.kind;
  const piece = (path: string): Piece => pieces.get(path) as Piece;
  const meta = await ok(async () => checkMeta(await env.courier.readPiece("meta.json", piece("meta.json")), { kind }));
  if (!meta) return { fail: "output_invalid" };
  if (j.sha256 && meta.sha256 !== j.sha256) return { fail: "input_mismatch" };
  if (env.profile.name === "full" && total > rendered) return { fail: "too_many_pages" };
  let pages: [number, number][] = [];
  let motion = false;
  let media = false;
  let noteCount = 0;
  if (passed.has("slides")) {
    const s = await ok(async () =>
      checkSlides(await env.courier.readPiece("slides.json", piece("slides.json")), { rendered, profile: env.profile }),
    );
    if (s) {
      pages = s.pages.map((p) => [p.w, p.h]);
      motion = s.motion;
      media = s.media;
    } else passed.delete("slides");
  }
  if (passed.has("notes")) {
    const notes = await ok(async () =>
      checkNotes(await env.courier.readPiece("notes.json", piece("notes.json")), { rendered }),
    );
    if (notes) noteCount = notes.length;
    else passed.delete("notes");
  }
  if (!decideGroups(kind, passed).ok) return { fail: "output_invalid" };
  j.plan = {
    manifest: await manifestDigest(loaded.manifest),
    rendered,
    total,
    passed: [...passed],
    pages,
    noteCount,
    motion,
    media,
    fonts: meta.fontsMissing ?? [],
    preview: loaded.preview,
  };
  j.unit = 0;
  await env.persist(j);
  return null;
}

/** A pack's pieces fetched one after another and guarded one by one; any bad piece errors the whole stream. */
function packStream(
  env: StoreEnv,
  list: readonly { path: string; length: number; sha256: string }[],
  ctx: PieceCtx,
): ReadableStream<Uint8Array> {
  let i = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      for (;;) {
        if (!reader) {
          const p = list[i++];
          if (!p) return controller.close();
          reader = (await env.courier.pieceBody(p.path, { size: p.length, sha256: p.sha256 }, ctx)).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        return controller.enqueue(value);
      }
    },
    cancel: async (reason) => {
      await reader?.cancel(reason);
    },
  });
}

/**
 * The full encode is stored: the 720p leaves the stored list, so the published outputs and the quota count only what is
 * served. Its key stays in `written` until the publish commits and the runner deletes it (`deleteRetiredPreview`).
 */
async function retirePreview(env: StoreEnv, j: JobRecord): Promise<void> {
  j.stored = j.stored.filter((s) => s.path !== "m/720.mp4");
  await env.persist(j);
}

/** After the row names the full encode: the 720p's object, no longer listed, is deleted. */
export async function deleteRetiredPreview(bucket: ConvBucket, prefix: string, j: JobRecord): Promise<void> {
  const key = outputKey(prefix, "m/720.mp4");
  if (!j.written.includes(key) || j.stored.some((s) => s.path === "m/720.mp4")) return;
  await bucket.delete(key);
  j.written = j.written.filter((k) => k !== key);
}

/** A group failed a check: its keys go and its later units are skipped. */
async function dropGroup(env: StoreEnv, j: JobRecord, plan: Plan, group: Group): Promise<void> {
  const names = new Set(storedPaths(group, env.profile.widths));
  const keys = [...names].map((rel) => outputKey(env.loc.prefix, rel));
  await env.bucket.delete(keys);
  j.stored = j.stored.filter((s) => !names.has(s.path));
  j.written = j.written.filter((k) => !keys.includes(k));
  plan.passed = plan.passed.filter((g) => g !== group);
  await env.persist(j);
}

/**
 * Puts one unit. A file that fails a check drops its group (and fails the job when no group is left); a container
 * or R2 fault throws a ContainerFault for the attempt.
 */
export async function putUnit(env: StoreEnv, j: JobRecord, unit: string): Promise<"ok" | "abandon"> {
  const plan = j.plan as Plan;
  const loaded = await checkManifestFor(env.courier, {
    jobId: env.jobId,
    ext: env.loc.ext,
    profile: env.profile,
    manifest: env.manifest,
  });
  if ("fault" in loaded) throw new ContainerFault("output_invalid", loaded.fault);
  if ((await manifestDigest(loaded.manifest)) !== plan.manifest)
    throw new ContainerFault("output_invalid", "manifest changed after it was checked");
  const { pieces } = loaded;
  const widths = env.profile.widths;
  const dims = plan.pages.map(([w, h]) => ({ w, h }));
  let failure: OutputError | undefined;
  const ctx: PieceCtx = {
    pages: dims,
    report: (e) => {
      failure ??= e;
    },
  };

  /** Records the key before the put, so a crash mid-put is still cleaned up; false when the run ended meanwhile. */
  const put = async (
    rel: string,
    source: ReadableStream<Uint8Array> | string,
    size: number,
    sha: string,
    check: boolean,
  ) => {
    const key = outputKey(env.loc.prefix, rel);
    if (!j.written.includes(key)) j.written.push(key);
    await env.persist(j);
    const body = typeof source === "string" ? source : source.pipeThrough(env.lengthStream(size));
    await env.bucket.put(key, body, check ? { sha256: sha } : {});
    if (!(await env.mine(j))) {
      await env.bucket.delete(key);
      return false;
    }
    // The thumbnail is stored again when the full encode replaces the 720p: one entry per name.
    j.stored = j.stored.filter((s) => s.path !== rel);
    j.stored.push({ path: rel, size, sha256: sha });
    return true;
  };
  const single = async (path: string): Promise<boolean> => {
    const piece = pieces.get(path) as Piece;
    return put(path, await env.courier.pieceBody(path, piece, ctx), piece.size, piece.sha256, true);
  };
  const singles = async (paths: string[]): Promise<boolean> => {
    for (const path of paths) if (!(await single(path))) return false;
    return true;
  };

  try {
    let kept = true;
    if (unit === "first") {
      kept = await singles(["t.webp", ...widths.map((w) => `s/1/${w}.webp`)]);
      if (kept) await env.pageReady();
    } else if (unit === "pdf") kept = await singles(["doc.pdf"]);
    else if (unit === "media") {
      // The 720p stored early is the final output when the full encode did not finish; a full one replaces it.
      const have720 = j.stored.some((s) => s.path === "m/720.mp4");
      kept = plan.preview ? have720 || (await singles(["m/720.mp4", "t.webp"])) : await singles(["m/0.mp4", "t.webp"]);
      if (kept && !plan.preview) await retirePreview(env, j);
    } else if (unit === "image") kept = await singles(["i/1920.jpg", "t.webp"]);
    else if (unit === "notes") {
      const piece = pieces.get("notes.json") as Piece;
      const bytes = (await env.courier.readPiece("notes.json", piece, ctx)) as Uint8Array<ArrayBuffer>;
      checkNotes(bytes, { rendered: plan.rendered });
      kept = await put("notes.json", new Blob([bytes]).stream(), bytes.length, piece.sha256, false);
    } else if (unit === "slides.json") {
      const slides = {
        v: 1 as const,
        widths: [...widths],
        pages: dims.map((d, i) => ({ n: i + 1, ...d })),
        motion: plan.motion,
        media: plan.media,
      };
      const text = JSON.stringify(
        buildSlidesJson(
          slides,
          { total: plan.total, rendered: plan.rendered },
          packPlan(plan.rendered, widths, pieces),
        ),
      );
      const bytes = new TextEncoder().encode(text);
      kept = await put("slides.json", text, bytes.length, await sha256Hex(bytes), false);
    } else {
      const w = Number(unit.slice("pack:".length));
      const pack = packPlan(plan.rendered, widths, pieces).find((p) => p.w === w);
      if (!pack) throw new ContainerFault("output_invalid", `no pack for ${w}`);
      // R2 cannot hash a pack as a whole: its digest is that of its pieces' hashes, which the guard checked one by one.
      const digest = await sha256Hex(new TextEncoder().encode(pack.pieces.map((p) => p.sha256).join("")));
      kept = await put(`s/${w}.pack`, packStream(env, pack.pieces, ctx), pack.size, digest, false);
    }
    return kept ? "ok" : "abandon";
  } catch (e) {
    if (!failure && !(e instanceof OutputError)) {
      if (e instanceof ContainerFault) throw e;
      throw new ContainerFault(
        env.courier.pastDeadline() ? "deadline" : "store_failed",
        e instanceof Error ? e.message : "put failed",
      );
    }
    await dropGroup(env, j, plan, groupOfUnit(unit));
    if (!decideGroups(loaded.manifest.kind, new Set(plan.passed)).ok) throw new ContainerFault("output_invalid", unit);
    return "ok";
  }
}
