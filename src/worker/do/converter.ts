// One per conversion job (idFromName("<fid>:v<n>"), eu): owns the container and checks every output before it is stored
// (ADR 0019). The converter change fills it; the container entry in wrangler.jsonc arrives with its image.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

export class Converter extends DurableObject<Env> {}
