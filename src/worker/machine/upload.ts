// A guest's send: from a claim to an offered file, or back to the claim when it fails.
import { withIds } from "../items.ts";
import type { EventOf, Machine, MachineConfig, Step } from "../machine.ts";
import { fail, newSession, ok, SECOND } from "./step.ts";

export function uploadStart(m: Machine, ev: EventOf<"upload.start">): Step {
  // A scan does not say what the phone will do. A phone that claimed as an owner and now sends a file
  // becomes a guest here, and gives up its list and account.
  const { pairing } = m;
  if (!pairing || (m.state !== "claimed" && m.state !== "choosing")) return fail("wrong_state");
  if (m.state === "choosing" && pairing.kind !== "owner") return fail("wrong_state");
  const guest = { ...pairing, kind: "guest" as const, listed: [], userId: null };
  return ok({ ...m, pairing: guest, state: "uploading", uploadAt: ev.now + ev.timeoutSeconds * SECOND }, [
    { fx: "push", to: "both" },
  ]);
}

export function uploadDone(m: Machine, ev: EventOf<"upload.done">, cfg: MachineConfig): Step {
  if (m.state !== "uploading") return fail("wrong_state");
  const session = newSession(withIds([{ kind: "file", ...ev.file }]), [0]);
  return ok({ ...m, state: "offered", session, uploadAt: null, offerAt: ev.now + cfg.claimTimeoutSeconds * SECOND }, [
    { fx: "audit", type: "guest.uploaded", actor: "phone" },
    { fx: "push", to: "both" },
  ]);
}

export function uploadFailed(m: Machine, ev: EventOf<"upload.failed">): Step {
  if (m.state !== "uploading") return fail("wrong_state");
  return ok({ ...m, state: "claimed", uploadAt: null }, [
    { fx: "audit", type: "guest.refused", actor: "phone", cause: ev.error },
    { fx: "metric", name: "failure", cause: ev.error },
    { fx: "push", to: "both" },
  ]);
}
