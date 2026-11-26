// The phone's Open on a link item, and the screen's answer (LINK-02).
import { IN_SESSION } from "../../../public/js/shared/session.js";
import type { EventOf, Machine, Step } from "../machine.ts";
import { fail, ok } from "./step.ts";

export function linkOpen(m: Machine, ev: EventOf<"link.open">): Step {
  // Like `control`, a demo's remote: a live screen has no viewer. Only an approved LINK item by id.
  if (!IN_SESSION.includes(m.state) || !m.session || m.mode === "live") return fail("wrong_state");
  if (!m.session.items.some((i) => i.kind === "link" && i.id === ev.item)) return fail("file_not_found");
  // The clock keeps `n` above any earlier session's, so a screen page that outlives a session still acts on the new ask.
  const n = Math.max((m.session.linkOpen?.n ?? 0) + 1, ev.now);
  return ok({ ...m, session: { ...m.session, linkOpen: { item: ev.item, n, opened: null } } }, [
    { fx: "push", to: "both" },
  ]);
}

export function linkOpened(m: Machine, ev: EventOf<"link.opened">): Step {
  const asked = m.session?.linkOpen;
  if (!IN_SESSION.includes(m.state) || !m.session || !asked) return fail("wrong_state");
  // One answer per ask: a stale ask, or a second answer to this one, changes nothing.
  if (ev.n !== asked.n || asked.opened !== null) return ok(m);
  const answer = { ...asked, opened: ev.opened, ...(ev.refused ? { refused: true as const } : {}) };
  return ok({ ...m, session: { ...m.session, linkOpen: answer } }, [{ fx: "push", to: "both" }]);
}
