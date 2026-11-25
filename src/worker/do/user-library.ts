// One per user (idFromName(userId), eu): conversion progress, the hibernating socket to library pages and the user's live
// screens (ADR 0015). The library change fills it; the stub keeps the binding and its migration deployable.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

export class UserLibrary extends DurableObject<Env> {}
