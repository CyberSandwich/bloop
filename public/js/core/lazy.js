// Shared by /a's lazy controls.
/** @import {ErrorCode} from "../../../src/shared/protocol.ts" */
import { toast } from "./toast.js";

/** @type {Record<string, Promise<void> | undefined>} */
const sheets = {};

/** Never rejected: a failed load shows the part unstyled, and the next call tries again. */
export const styled = (/** @type {string} */ href) =>
  (sheets[href] ??= new Promise((done) => {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href });
    link.onload = () => done();
    link.onerror = () => {
      link.remove();
      sheets[href] = undefined;
      done();
    };
    document.head.append(link);
  }));

/** A refused change as a toast; an end needs none, since the socket pushes it. */
export const refused = (/** @type {string} */ title) => (/** @type {ErrorCode} */ code) => {
  if (["session_ended", "pairing_invalid", "wrong_state", "screen_gone"].includes(code)) return;
  toast({
    title,
    body:
      code === "rate_limited"
        ? "Too many changes at once. Wait a minute, then try again."
        : code === "offline"
          ? "Check the connection, then try again."
          : "Try again in a moment.",
    error: true,
  });
};
