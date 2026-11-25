// The typed-code page's strings (the rules: copy.js).
/** @import {PhoneStateKey} from "../../../src/shared/protocol.ts" */
import { TYPED_WRONG } from "./copy.js";

export const TYPED_LETTERS = "Codes don't use 0, 1, I, L, O or U.";
/** The typed-code page's one sentence beside the field, per failure a claim can return. */
const TYPED = /** @type {Partial<Record<PhoneStateKey, string>>} */ ({
  typed_wrong: TYPED_WRONG,
  expired: "That code changed. Enter the new one.",
  taken: "That code was used. Enter the new one.",
  offline: "You're offline. Check your connection.",
  rate_limited: "Too many tries. Wait a minute.",
  framed: "Open this page directly.",
});
export const typedError = (/** @type {PhoneStateKey} */ key) => TYPED[key] ?? "Unable to check the code. Try again.";
