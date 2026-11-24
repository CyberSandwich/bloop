// Helpers for the guest-drop tests: a guest phone paired to a live screen, and raw PUT /api/drop requests.
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

export interface PutOptions {
  origin?: string | null;
  contentType?: string | null;
  /** Percent-decoded name; sent in `X-Bloop-Name`. */
  name?: string;
  headers?: Record<string, string>;
}

export const putDrop = (api: Api, pid: string | null, body: string | Uint8Array, options: PutOptions = {}) => {
  const headers: Record<string, string> = { ...options.headers };
  if (options.origin !== null) headers.Origin = options.origin ?? api.base;
  if (options.contentType !== null) headers["Content-Type"] = options.contentType ?? "application/octet-stream";
  if (pid) headers.Authorization = `Bearer ${pid}`;
  headers["X-Bloop-Name"] = encodeURIComponent(options.name ?? "Talk.pptx");
  return fetch(`${api.base}/api/drop`, { method: "PUT", headers, body });
};

/** A guest drop accepted and opened on the screen: the socket and the view link the screen received. */
export async function openGuestView(api: Api, bytes: Uint8Array, name: string, contentType: string) {
  const { socket, pid } = await pairPhone(api);
  const res = await putDrop(api, pid, bytes, { name, contentType });
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
