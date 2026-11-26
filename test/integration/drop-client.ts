// Helpers for the guest-drop tests: a guest phone paired to a live screen, and a file sent over the guest upload routes.
import { createHash } from "node:crypto";
import { ERRORS } from "../../public/js/shared/errors.js";
import { type Api, claim, openScreen, type Screen, type Socket } from "./pairing-client.ts";

export interface GuestPhone {
  screen: Screen;
  socket: Socket;
  pid: string;
}

/** A live screen and a phone that claimed its code. `kind: "owner"` is the default scan: the drop turns it into a guest. */
export async function pairPhone(api: Api, kind: "owner" | "guest" = "guest"): Promise<GuestPhone> {
  const { screen, socket, code } = await openScreen(api, "live");
  const claimed = await claim(api, code, kind);
  if (claimed.status !== 200) throw new Error(`claim failed: ${claimed.status}`);
  return { screen, socket, pid: claimed.body.pid };
}

export interface SendOptions {
  origin?: string | null;
  name?: string;
  /** Extra headers on every request of the upload. */
  headers?: Record<string, string>;
  /** Stops after the create: the upload stays open with no part sent. */
  openOnly?: boolean;
}

export interface Opened {
  uploadId: string;
  parts: number;
  partBytes: number;
  done: number[];
}

const GUEST = "/api/guest/uploads";
const asBytes = (body: string | Uint8Array) => (typeof body === "string" ? new TextEncoder().encode(body) : body);

/** The engine's identity of a file; any value unique to the name and the bytes serves the routes. */
export const fingerprintOf = (name: string, bytes: Uint8Array) =>
  createHash("sha256").update(name).update(bytes).digest("hex");

export function guestHeaders(api: Api, pid: string | null, options: Pick<SendOptions, "origin" | "headers"> = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.origin !== null) headers.Origin = options.origin ?? api.base;
  if (pid) headers.Authorization = `Bearer ${pid}`;
  return headers;
}

export const createGuestUpload = (api: Api, pid: string | null, bytes: Uint8Array, options: SendOptions = {}) => {
  const name = options.name ?? "Talk.pptx";
  return fetch(`${api.base}${GUEST}`, {
    method: "POST",
    headers: { ...guestHeaders(api, pid, options), "Content-Type": "application/json" },
    body: JSON.stringify({ name, bytes: bytes.length, fingerprint: fingerprintOf(name, bytes) }),
  });
};

export const putGuestPart = (api: Api, pid: string, uploadId: string, n: number, body: Uint8Array, extra = {}) =>
  fetch(`${api.base}${GUEST}/${uploadId}/parts/${n}`, {
    method: "PUT",
    headers: { ...guestHeaders(api, pid), ...extra, "Content-Type": "application/octet-stream" },
    body,
  });

export const completeGuestUpload = (api: Api, pid: string, uploadId: string, extra = {}) =>
  fetch(`${api.base}${GUEST}/${uploadId}/complete`, {
    method: "POST",
    headers: { ...guestHeaders(api, pid), ...extra, "Content-Type": "application/json" },
    body: "{}",
  });

/**
 * Sends a file as the phone's engine does: create, every part, complete. Answers as one request would: the phone view
 * (200) once the file is ready, or the refusal as a problem response with its code's status, whichever step refused.
 */
export async function sendDrop(api: Api, pid: string | null, body: string | Uint8Array, options: SendOptions = {}) {
  const bytes = asBytes(body);
  const made = await createGuestUpload(api, pid, bytes, options);
  if (!made.ok || options.openOnly || !pid) return made;
  const opened = (await made.json()) as Opened;
  for (let n = 1; n <= opened.parts; n++) {
    if (opened.done.includes(n)) continue;
    const part = bytes.subarray((n - 1) * opened.partBytes, n * opened.partBytes);
    const put = await putGuestPart(api, pid, opened.uploadId, n, part, options.headers);
    if (!put.ok) return put;
  }
  const done = await completeGuestUpload(api, pid, opened.uploadId, options.headers);
  if (!done.ok) return done;
  const answer = (await done.json()) as { state: string; file: { refusal?: keyof typeof ERRORS } };
  if (answer.state === "ready") {
    return fetch(`${api.base}/api/pair/state`, { headers: guestHeaders(api, pid, options) });
  }
  const code = answer.file.refusal ?? "internal";
  return new Response(JSON.stringify({ code }), { status: ERRORS[code].status });
}

/** A guest drop accepted and opened on the screen: the socket and the view link the screen received. */
export async function openGuestView(api: Api, bytes: Uint8Array, name: string) {
  const { socket, pid } = await pairPhone(api);
  const res = await sendDrop(api, pid, bytes, { name });
  if (res.status !== 200) throw new Error(`drop failed: ${res.status}`);
  socket.send({ t: "open.click" });
  const open = await socket.waitFor((f) => f.t === "open");
  return { socket, url: (open.links as { view: string }).view };
}

export const problemCode = async (res: Response) => ((await res.json()) as { code: string }).code;

/** The one row `guest_file` holds for a session id, or the newest when the id is not given. */
export const guestRow = (d1: (sql: string) => Record<string, unknown>[], sessionId?: string) =>
  d1(
    `SELECT session_id, r2_key, bytes, type, sha256, name, deleted_at FROM guest_file ${
      sessionId ? `WHERE session_id = '${sessionId}'` : "ORDER BY created_at DESC LIMIT 1"
    }`,
  )[0];
