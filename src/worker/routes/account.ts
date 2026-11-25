// Account routes (/api/me extensions: passkeys, sessions, email change, deletion, restore, audit). Owned by the accounts change (ADR 0014); empty until it lands, so every path answers 404.
import type { Route } from "../router.ts";

export const accountRoutes: readonly Route[] = [];
