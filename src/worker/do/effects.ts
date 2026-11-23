// Applies the machine's effects, in order, for the Screen object. No Cloudflare types, so unit tests
// drive it with fakes. Each effect maps to one seam; the stubs are replaced by their modules.
import type { OpenMode } from "../../shared/protocol.ts";
import type { AuditEvent, AuditLog } from "../audit.ts";
import type { Effect, FileRef, Machine } from "../machine.ts";
import type { Metrics } from "../metrics.ts";
import type { CodeDirectory } from "../seams/pairing.ts";
import type { Meta } from "../views.ts";

/** Seams owned by later modules: the open path (links), file sources and guest drop (purge). */
export interface SessionSeams {
  /** Mints the link set for the approved file and sends `open` to the screen. */
  mint(purpose: OpenMode): Promise<void>;
  revokeLinks(): Promise<void>;
  /** Deletes a guest object and drops any in-memory access token. `file` is null when none was stored yet. */
  purge(input: { sessionId: string | null; file: FileRef | null }): Promise<void>;
}

export const noopSeams: SessionSeams = {
  async mint() {},
  async revokeLinks() {},
  async purge() {},
};

export interface EffectDeps {
  directory: Pick<CodeDirectory, "put" | "remove">;
  audit: Pick<AuditLog, "record">;
  metrics: Pick<Metrics, "record">;
  seams: SessionSeams;
  push(to: "screen" | "phone" | "both"): void;
  /** Close sockets and delete all storage. */
  deleteAll(): Promise<void>;
}

export interface EffectContext {
  meta: Meta;
  prev: Machine;
  next: Machine;
  now: number;
}

function auditDetail(fx: Extract<Effect, { fx: "audit" }>, { prev, next }: EffectContext): AuditEvent["detail"] {
  const session = next.session ?? prev.session;
  const withFile = fx.type === "approved" || fx.type === "ended" || fx.type === "guest.uploaded";
  const withReason = fx.type === "canceled" || fx.type === "ended";
  return {
    ...(withFile && session ? { fileName: session.file.name, source: session.file.source } : {}),
    ...(withReason && next.endReason ? { reason: next.endReason } : {}),
    ...(fx.cause ? { cause: fx.cause } : {}),
  };
}

/** A failing audit or metrics write must not stop the session from ending or the screen from updating. */
export async function bestEffort(write: Promise<void>): Promise<void> {
  try {
    await write;
  } catch {
    console.error("record_failed");
  }
}

/**
 * Runs the effects in order. Returns `collided: true` when the Directory already maps the new code
 * to another screen: the caller draws again, and nothing after the put (the push) has run.
 */
export async function runEffects(
  effects: Effect[],
  ctx: EffectContext,
  deps: EffectDeps,
): Promise<{ collided: boolean }> {
  const { meta, prev, next, now } = ctx;
  const pairing = next.pairing ?? prev.pairing;
  for (const fx of effects) {
    switch (fx.fx) {
      case "directory.put":
        if ((await deps.directory.put(fx.code, meta.screenRef, fx.expiresAt)) === "collision")
          return { collided: true };
        break;
      case "directory.remove":
        await deps.directory.remove(fx.code);
        break;
      case "push":
        deps.push(fx.to);
        break;
      case "mint":
        await deps.seams.mint(fx.purpose);
        break;
      case "revokeLinks":
        await deps.seams.revokeLinks();
        break;
      case "purge":
        await deps.seams.purge({ sessionId: pairing?.sessionId ?? null, file: fx.file });
        break;
      case "audit":
        if (pairing) {
          await bestEffort(
            deps.audit.record({
              sessionId: pairing.sessionId,
              at: now,
              actor: fx.actor,
              type: fx.type,
              detail: auditDetail(fx, ctx),
            }),
          );
        }
        break;
      case "metric":
        if (pairing) {
          await bestEffort(
            deps.metrics.record({
              at: now,
              mode: meta.mode,
              kind: pairing.kind,
              roomId: meta.roomId,
              name: fx.name,
              ...(fx.ms !== undefined ? { ms: fx.ms } : {}),
              ...(fx.cause ? { cause: fx.cause } : {}),
            }),
          );
        }
        break;
      case "deleteAll":
        await deps.deleteAll();
        break;
    }
  }
  return { collided: false };
}
