// The signed-in member behind a library request, as the library needs it: the user and the phone session's public id.
// A's resolver (auth/member.ts, label C) does the work: a live session of an active, unsuspended email member the launch
// lockout admits. A member in the deletion grace gets the card's data, never the library (library.md section 5).
import { resolveMember as resolveAccountMember } from "../auth/member.ts";
import type { Config } from "../config.ts";
import { fail } from "../http.ts";

export interface Member {
  userId: string;
  /** The phone session's public id: the only session name that leaves D1. */
  sessionPublicId: string;
}

export type Resolved = { ok: true; member: Member } | { ok: false; response: Response };

const deleting = async (deleteAfter: number | null): Promise<Response> => {
  const base = fail("account_deleting");
  if (deleteAfter === null) return base;
  return new Response(JSON.stringify({ ...((await base.json()) as object), deleteAfter }), base);
};

export async function resolveMember(request: Request, env: { DB: unknown }, config: Config): Promise<Resolved> {
  const who = await resolveAccountMember(request, env, config, { allowDeleting: true });
  if (!who.ok) return who;
  const { member } = who;
  if (member.session.publicId === null) return { ok: false, response: fail("auth_required") };
  if (member.status === "deleting") return { ok: false, response: await deleting(member.deleteAfter) };
  return { ok: true, member: { userId: member.userId, sessionPublicId: member.session.publicId } };
}
