// The entry every caller uses to convert a file version: U's upload complete, L's Try Again, P1's guest and demo drops.
// It refuses cheaply and in order (switch, queue, per-day take), claims the version's one run, and hands it to the
// Converter. It never throws: a caller gets `queued`, `exists` or `skipped` with a code, and the row says the same.
import type { Target } from "../do/converter-schema.ts";
import { isExt, KIND_BY_EXT } from "./contract.ts";
import type { ConvertDeps } from "./deps-types.ts";
import { locate, type OwnerKind } from "./keys.ts";
import { deadlineSeconds, PROFILES, type ProfileName } from "./profile.ts";
import { claimRun, markFailed, markSkipped, queueDepth } from "./results.ts";

export interface StartRequest {
  ownerKind: OwnerKind;
  /** The library file id, or the guest session id. */
  fileId: string;
  version: number;
  profile: ProfileName;
  /** What the per-day take counts: the user id (library), or the IP hash (guest and demo). */
  scope: string;
  target: Target;
}

export type StartResult =
  /** A run was handed to the Converter. */
  | { state: "queued" }
  /** A run is already live or done for this version, or it has used its starts: nothing was started. */
  | { state: "exists" }
  /** Nothing ran; `code` says why and is on the row. `gone` (the file is not there) writes no row. */
  | { state: "skipped"; code: string; retryAfterSeconds?: number };

/** Queue caps: queued plus running rows, overall, per user and for public (guest and demo) files. */
export const QUEUE_CAPS = { all: 100, user: 5, public: 10 } as const;

const meterFor = (req: StartRequest) =>
  req.ownerKind === "library" ? "convert_user" : req.profile === "demo" ? "convert_demo" : "convert_guest";

export async function startConversion(deps: ConvertDeps, req: StartRequest): Promise<StartResult> {
  try {
    return await begin(deps, req);
  } catch (e) {
    deps.log(JSON.stringify({ evt: "convert_start_error", error: e instanceof Error ? e.message : "unknown" }));
    return { state: "skipped", code: "busy" };
  }
}

async function begin(deps: ConvertDeps, req: StartRequest): Promise<StartResult> {
  const gates = await deps.gates();
  if (gates.mode === "off") return { state: "skipped", code: "off" };
  const loc = await locate(deps.db, req.ownerKind, req.fileId, req.version);
  if (!loc) return { state: "skipped", code: "gone" };

  // A library file's owner comes from its row: the queue cap, the per-day take and the progress target never trust a
  // caller's word for whose file this is. A guest's scope (the IP hash) is not in D1, so it stays the caller's.
  const scope = loc.userId ?? req.scope;
  const target: Target = loc.userId ? { kind: "library", userId: loc.userId } : req.target;
  const now = deps.now();
  const runId = deps.newRunId();
  const key = { fileId: req.fileId, version: req.version, runId };
  const claim = () =>
    claimRun(deps.db, { fileId: req.fileId, version: req.version, ownerKind: req.ownerKind, runId, now });
  /** Records a refusal on the row: the claim first, so a live run is never overwritten. */
  const refuse = async (code: string, final = false): Promise<StartResult> => {
    if (!(await claim())) return { state: "exists" };
    await (final ? markFailed : markSkipped)(deps.db, key, code, now);
    return { state: "skipped", code };
  };

  if (!isExt(loc.ext)) return refuse("unsupported", true);
  const kind = KIND_BY_EXT[loc.ext];
  if (kind === "video" && (req.profile === "demo" || gates.convertVideo === "off")) return refuse("video_off");
  if (gates.convert === "off") return refuse("off");
  if (gates.convert === "account_only" && req.ownerKind === "guest" && req.profile === "full") {
    return refuse("account_only");
  }
  if (deadlineSeconds(kind, loc.ext, loc.bytes, PROFILES[req.profile]) > deps.leaseMaxSeconds) {
    return refuse("too_large", true);
  }
  const depth = await queueDepth(deps.db, loc.userId);
  const full =
    depth.all >= QUEUE_CAPS.all ||
    (req.ownerKind === "library" ? depth.user >= QUEUE_CAPS.user : depth.guest >= QUEUE_CAPS.public);
  if (full) return refuse("queue_full");

  if (!(await claim())) return { state: "exists" };
  const taken = await deps.spend.take(meterFor(req), 1, scope);
  if (!taken.ok) {
    const code = taken.reason === "cap_hit" ? "daily_limit" : "busy";
    await markSkipped(deps.db, key, code, now);
    return { state: "skipped", code, retryAfterSeconds: taken.retryAfterSeconds };
  }
  try {
    const result = await deps.converter(req.fileId, req.version).enqueue({
      runId,
      ownerKind: req.ownerKind,
      target,
      fileId: req.fileId,
      version: req.version,
      profile: req.profile,
      scope,
      enqueuedAt: now,
    });
    if (result === "busy") throw new Error("the version's Converter holds another run");
  } catch (e) {
    deps.log(JSON.stringify({ evt: "convert_enqueue_failed", error: e instanceof Error ? e.message : "unknown" }));
    await markSkipped(deps.db, key, "busy", now);
    return { state: "skipped", code: "busy" };
  }
  return { state: "queued" };
}
