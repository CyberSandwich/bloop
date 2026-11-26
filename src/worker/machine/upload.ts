// A guest's send: from a claim to an offered file, or back to the claim when it fails.
import { withIds } from "../items.ts";
import type { EventOf, Machine, MachineConfig, Step } from "../machine.ts";
import { fail, newSession, ok, SECOND, unconfirmed } from "./step.ts";

export function uploadStart(m: Machine, ev: EventOf<"upload.start">): Step {
  // A scan does not say what the phone will do. A phone that claimed as an owner and now sends a file
  // becomes a guest here, and gives up its list and account.
  const { pairing } = m;
  if (!pairing || (m.state !== "claimed" && m.state !== "choosing")) return fail("wrong_state");
  if (m.state === "choosing" && pairing.kind !== "owner") return fail("wrong_state");
  if (unconfirmed(m)) return fail("match_required");
  const guest = { ...pairing, kind: "guest" as const, listed: [], userId: null };
  return ok({ ...m, pairing: guest, state: "uploading", upload: null, uploadAt: ev.now + ev.timeoutSeconds * SECOND }, [
    { fx: "push", to: "both" },
  ]);
}

/**
 * How far the send has got, for the screen's pill. Monotonic: a lower count than stored (a part report that arrived
 * late) changes nothing, so the pill never moves back. The first report fixes the total; another total is refused.
 */
export function uploadProgress(m: Machine, ev: EventOf<"upload.progress">): Step {
  const { bytes, total } = ev;
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(total) || bytes < 0 || bytes > total) {
    return fail("bad_request");
  }
  if (m.state !== "uploading") return fail("wrong_state");
  const held = m.upload ?? null;
  if (held && held.total !== total) return fail("bad_request");
  if (held && bytes <= held.bytes) return ok(m);
  return ok({ ...m, upload: { bytes, total } }, [{ fx: "push", to: "screen" }]);
}

export function uploadDone(m: Machine, ev: EventOf<"upload.done">, cfg: MachineConfig): Step {
  if (m.state !== "uploading") return fail("wrong_state");
  const session = newSession(withIds([{ kind: "file", ...ev.file }]), [0]);
  const offerAt = ev.now + cfg.claimTimeoutSeconds * SECOND;
  return ok({ ...m, state: "offered", session, upload: null, uploadAt: null, offerAt }, [
    { fx: "audit", type: "guest.uploaded", actor: "phone" },
    { fx: "push", to: "both" },
  ]);
}

/** Back to the claim, the pick kept: a new file goes through `upload.start` again on the same pairing (UP-09). */
export function uploadFailed(m: Machine, ev: EventOf<"upload.failed">): Step {
  if (m.state !== "uploading") return fail("wrong_state");
  return ok({ ...m, state: "claimed", upload: null, uploadAt: null }, [
    { fx: "audit", type: "guest.refused", actor: "phone", cause: ev.error },
    { fx: "metric", name: "failure", cause: ev.error },
    { fx: "push", to: "both" },
  ]);
}
