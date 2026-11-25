// Local stand-in for the R2 EU endpoint, used when UPLOAD_MODE=proxy in development and tests. Owned by the uploads change. Empty until it lands.
import type { Route } from "../router.ts";

export const devR2Routes: readonly Route[] = [];
