// The guest routes of the multipart pipeline (/api/guest/uploads) against `wrangler dev`, proxy mode: a large file in
// parts, a resend that resumes, a member's cookie that is no credential, and a session's end that aborts what is open.
// The refusals and the read path are guest-drop.test.ts's; a member's guest drop is upload-client.test.ts's.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validDeck, validVideo } from "../zip-builder.ts";
import {
  createGuestUpload,
  guestHeaders,
  guestRow,
  type Opened,
  pairPhone,
  problemCode,
  putGuestPart,
  sendDrop,
} from "./drop-client.ts";
import { Api, startPairing } from "./pairing-client.ts";
import type { Wrangler } from "./wrangler.ts";

const MIB = 1024 * 1024;
let wrangler: Wrangler;
let api: Api;
beforeAll(async () => {
  // The guest cap is raised for the 89 MB case only; production keeps GUEST_MAX_BYTES.
  wrangler = await startPairing({ GUEST_MAX_BYTES: String(90 * MIB), UPLOAD_MODE: "proxy" }, { migrate: true });
  api = new Api(wrangler.url);
}, 120_000);
afterAll(() => wrangler?.stop());

const deck = validDeck();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const uploadRow = (id: string) =>
  wrangler.d1(
    `SELECT owner_kind, bucket, user_id, completed_at IS NOT NULL AS completed, aborted_at IS NOT NULL AS aborted FROM upload WHERE id = '${id}'`,
  )[0];

function member(id: string): string {
  const cookie = id.padEnd(43, "x");
  const now = Date.now();
  wrangler.d1(
    `INSERT INTO app_user (id, tid, oid, email, email_norm, created_at, last_seen_at) VALUES ('${id}', 'email', '${id}', '${id}@example.test', '${id}@example.test', 0, 0)`,
  );
  wrangler.d1(
    `INSERT INTO phone_session (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('${sha(cookie)}', '${id}', ${now}, ${now}, ${now + 86_400_000})`,
  );
  return cookie;
}
const cookieOf = (sid: string) => ({ Cookie: `__Host-bloop_sid=${sid}` });

describe("UP-09 retry: a guest's resend resumes its upload", () => {
  it("UP-09 retry: an 89 MB guest file goes up in parts through the Worker, and a resend after part 1 resumes it", async () => {
    const { socket, pid } = await pairPhone(api);
    const bytes = validVideo("isom", 89_000_000);
    const name = "Talk.mp4";
    const made = await createGuestUpload(api, pid, bytes, { name });
    expect(made.status).toBe(201);
    const first = (await made.json()) as Opened & { mode: string; urls: { n: number; url: string }[] };
    expect(first.mode).toBe("proxy");
    expect(first.parts).toBe(Math.ceil(bytes.length / first.partBytes));
    expect(first.parts).toBeGreaterThan(1);
    expect(first.urls[0]).toEqual({ n: 1, url: `/api/guest/uploads/${first.uploadId}/parts/1` });
    const one = await putGuestPart(api, pid, first.uploadId, 1, bytes.subarray(0, first.partBytes));
    expect(one.status).toBe(200);
    await socket.waitFor((f) => f.t === "upload.progress" && f.uploadId === first.uploadId);

    // The page reloads: the same file again is the same upload with part 1 done, never a second row.
    const again = await createGuestUpload(api, pid, bytes, { name });
    expect(again.status).toBe(200);
    const resumed = (await again.json()) as Opened;
    expect([resumed.uploadId, resumed.done]).toEqual([first.uploadId, [1]]);
    const res = await sendDrop(api, pid, bytes, { name });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "offered", kind: "guest", items: [{ name, type: "mp4" }] });

    expect(uploadRow(first.uploadId)).toEqual({
      owner_kind: "guest",
      bucket: "guest",
      user_id: null,
      completed: 1,
      aborted: 0,
    });
    const session = String(guestRow(wrangler.d1)?.session_id);
    expect(wrangler.d1(`SELECT count(*) AS n FROM upload WHERE session_id = '${session}'`)).toEqual([{ n: 1 }]);
    expect(guestRow(wrangler.d1)).toMatchObject({ bytes: bytes.length, type: "mp4", deleted_at: null });
    expect(wrangler.r2Has(String(guestRow(wrangler.d1)?.r2_key))).toBe(true);
    socket.close();
  }, 180_000);
});

describe("UP-03 owner: a guest route answers to the pairing alone", () => {
  it("UP-03 owner: a member cookie with no pairing is no guest, and a guest id is not the member's", async () => {
    const sid = member("cookieonly");
    const alone = await createGuestUpload(api, null, deck, { headers: cookieOf(sid) });
    expect([alone.status, await problemCode(alone)]).toEqual([401, "unauthorized"]);

    const { socket, pid } = await pairPhone(api);
    const opened = (await (await createGuestUpload(api, pid, deck, { headers: cookieOf(sid) })).json()) as Opened;
    for (const path of [`/api/uploads/${opened.uploadId}`, `/api/guest/uploads/${opened.uploadId}`]) {
      const res = await fetch(`${api.base}${path}`, { headers: { Origin: api.base, ...cookieOf(sid) } });
      expect([path, res.status]).toEqual([path, path.startsWith("/api/guest") ? 401 : 404]);
    }
    const listed = await fetch(`${api.base}/api/uploads`, { headers: { Origin: api.base, ...cookieOf(sid) } });
    expect(((await listed.json()) as { uploads: unknown[] }).uploads).toEqual([]);
    socket.close();
  });
});

describe("UP-04 abort: a session's end aborts its open uploads", () => {
  it("UP-04 abort: the phone's cancel closes an open guest multipart before the session's files go", async () => {
    const { socket, pid } = await pairPhone(api);
    const bytes = validVideo("isom", 20 * MIB);
    const opened = (await (await createGuestUpload(api, pid, bytes, { name: "Clip.mp4" })).json()) as Opened;
    expect((await putGuestPart(api, pid, opened.uploadId, 1, bytes.subarray(0, opened.partBytes))).status).toBe(200);
    expect(uploadRow(opened.uploadId)).toMatchObject({ completed: 0, aborted: 0 });

    expect((await api.post("/api/cancel", {}, { auth: pid })).status).toBe(200);
    expect(uploadRow(opened.uploadId)).toMatchObject({ completed: 0, aborted: 1 });
    expect(guestRow(wrangler.d1)?.deleted_at).not.toBeNull();
    const late = await putGuestPart(api, pid, opened.uploadId, 2, bytes.subarray(opened.partBytes));
    expect(late.status).toBeGreaterThanOrEqual(400);
    socket.close();
  });

  it("UP-04 abort: a guest's own cancel closes its upload and returns the screen to claimed", async () => {
    const { socket, pid } = await pairPhone(api);
    const opened = (await (await createGuestUpload(api, pid, deck)).json()) as Opened;
    await socket.stateWhere((v) => v.state === "uploading");
    const gone = await fetch(`${api.base}/api/guest/uploads/${opened.uploadId}`, {
      method: "DELETE",
      headers: guestHeaders(api, pid),
    });
    expect(gone.status).toBe(204);
    expect(uploadRow(opened.uploadId)).toMatchObject({ aborted: 1 });
    await socket.stateWhere((v) => v.state === "claimed");
    expect((await sendDrop(api, pid, deck)).status).toBe(200);
    socket.close();
  });
});
