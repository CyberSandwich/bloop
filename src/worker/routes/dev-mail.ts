// The dev mailbox (GET /api/dev/mailbox), mounted only when DEV_MAILBOX=1, which config refuses on a non-local origin. Owned by the accounts change. Empty until it lands.
import type { Route } from "../router.ts";

export const devMailRoutes: readonly Route[] = [];
