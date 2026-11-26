// Every code a conversion row can carry in `derived.error`. docs/conversion.md owns what each means and says; a test
// fails when a code here has no row there. Pure.
import { CONTAINER_ERRORS } from "./contract.ts";

/** A new container may be started once more for these (at most 2 starts per version, ever). */
export const RETRYABLE = ["start_failed", "interrupted", "store_failed"] as const;

/** Final: the same file fails the same way. */
export const FAILED_FINAL = [
  ...CONTAINER_ERRORS.filter((c) => c !== "upload_failed" && c !== "internal"),
  "too_many_pages",
  "deadline",
  "input_mismatch",
  "input_missing",
  "unsupported",
  "internal",
] as const;

/** No container ran: a refusal, so the row is `skipped` and a later claim may start it. */
export const SKIPPED = [
  "off",
  "account_only",
  "video_off",
  "daily_limit",
  "daily_budget",
  "busy",
  "queue_full",
] as const;

export const CODES: readonly string[] = [...RETRYABLE, ...FAILED_FINAL, ...SKIPPED];

export const isRetryable = (code: string): boolean => (RETRYABLE as readonly string[]).includes(code);

/** The most starts one version gets across every claim. */
export const MAX_ATTEMPTS = 2;
