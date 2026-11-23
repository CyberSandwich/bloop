// Zod schemas for the WebSocket frames a client may send (docs/interfaces.md section 1).
// The shared type-only contract is src/shared/protocol.ts; these must accept exactly those shapes.
import { z } from "zod";
import type { PhoneMsgIn, ScreenMsgIn } from "../shared/protocol.ts";

export const MAX_FRAME_BYTES = 4096;

const frame = <T extends string>(t: T) => z.object({ v: z.literal(1), t: z.literal(t) }).strict();
const openMode = z.enum(["protocol", "download", "pdf"]);

export const screenFrame = z.discriminatedUnion("t", [
  frame("hello").extend({ sid: z.string().max(128) }),
  frame("code.next"),
  frame("open.click"),
  frame("launched").extend({ mode: openMode }),
  frame("ping"),
]) satisfies z.ZodType<ScreenMsgIn>;

export const phoneFrame = z.discriminatedUnion("t", [
  frame("hello").extend({ pid: z.string().max(128) }),
  frame("ping"),
]) satisfies z.ZodType<PhoneMsgIn>;
