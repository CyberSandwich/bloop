// CONVERT_MODE=stub: a fake job server in place of the container, so the whole path (upload, convert, store, publish,
// cancel) runs under `wrangler dev` and in tests with no Docker. config.ts refuses the mode on a non-local origin.
// A failure is chosen by the original's first bytes: `BLOOP-STUB:<mode>`, honored only here.
import type { Store } from "../do/converter-schema.ts";
import { sha256Hex } from "./outputs.ts";
import type { ContainerPort } from "./port.ts";
import type { Profile } from "./profile.ts";
import { buildStubOutputs, stubWebp } from "./stub-outputs.ts";

export const STUB_MODES = [
  "timeout",
  "bomb",
  "bad_webp",
  "extra_file",
  "slow",
  "crash_once",
  "pages60",
  "pages301",
] as const;
type Mode = (typeof STUB_MODES)[number] | null;

interface JobState {
  env: Record<string, string>;
  jobId: string | null;
  ext: string;
  size: number;
  sha256: string;
  mode: Mode;
  startedAt: number;
  chunks: number[];
}

const KEY = "stub";
const MARKER = "BLOOP-STUB:";
const SLOW_MS = 180_000;
const STEP_MS = 1_000;
const enc = new TextEncoder();
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (code: string, status: number): Response => json({ error: code }, status);

function modeOf(head: Uint8Array): Mode {
  const text = new TextDecoder().decode(head.subarray(0, 64));
  if (!text.startsWith(MARKER)) return null;
  const name = text.slice(MARKER.length).split(/[^a-z_0-9]/)[0];
  return (STUB_MODES as readonly string[]).includes(name ?? "") ? (name as Mode) : null;
}

const profileOf = (env: Record<string, string>): Profile => ({
  name: env.BLOOP_MAX_PAGES === "40" ? "demo" : "full",
  widths: (env.BLOOP_WIDTHS ?? "1920,480").split(",").map(Number),
  maxPages: Number(env.BLOOP_MAX_PAGES ?? 300),
  maxUnpacked: 0,
  totalBytes: 0,
});

export function stubPort(storage: Pick<Store, "get" | "put">, now: () => number = Date.now): ContainerPort {
  let up = false;
  const read = () => storage.get<JobState>(KEY);

  async function outputs(s: JobState) {
    const pages = s.mode === "pages60" ? 60 : s.mode === "pages301" ? 301 : 3;
    const out = await buildStubOutputs(s.jobId ?? "", s.ext, profileOf(s.env), s.sha256, { pages, notes: [2] });
    if (s.mode === "bad_webp") {
      const w = profileOf(s.env).widths[0] ?? 1920;
      const bad = stubWebp(w - 1, 1080, 2);
      out.files.set(`s/2/${w}.webp`, bad);
      const entry = out.manifest.files.find((f) => f.path === `s/2/${w}.webp`);
      if (entry) Object.assign(entry, { size: bad.length, sha256: await sha256Hex(bad) });
    }
    if (s.mode === "extra_file") {
      const bytes = enc.encode("<script>1</script>");
      out.files.set("evil.html", bytes);
      out.manifest.files.push({
        path: "evil.html",
        size: bytes.length,
        sha256: await sha256Hex(bytes),
        type: "text/html",
      });
    }
    return out;
  }

  const state = (
    s: JobState,
  ): { state: string; stage: string | null; error: string | null; done: boolean; pages: number } => {
    const elapsed = now() - s.startedAt;
    if (s.mode === "bomb") return { state: "failed", stage: "inspect", error: "bomb", done: false, pages: 0 };
    if (s.mode === "timeout") return { state: "failed", stage: "convert", error: "timeout", done: false, pages: 0 };
    if (s.mode === "crash_once" && s.jobId?.endsWith("_a1"))
      return { state: "idle", stage: null, error: null, done: false, pages: 0 };
    if (s.mode === "slow" && elapsed < SLOW_MS)
      return { state: "running", stage: "rasterize", error: null, done: false, pages: 1 };
    if (elapsed < STEP_MS) return { state: "running", stage: "rasterize", error: null, done: false, pages: 1 };
    return { state: "done", stage: "done", error: null, done: true, pages: 3 };
  };

  return {
    start(env) {
      up = true;
      void storage.put(KEY, {
        env,
        jobId: null,
        ext: "",
        size: 0,
        sha256: "",
        mode: null,
        startedAt: 0,
        chunks: [],
      } satisfies JobState);
    },
    running: () => up,
    destroy: async () => {
      up = false;
    },
    setInactivity: async () => undefined,
    async fetch(path, init) {
      const s = await read();
      if (!up || !s) return err("not_running", 503);
      const url = new URL(path, "http://container");
      const method = init.method ?? "GET";
      if (url.pathname === "/healthz") return new Response("ok");
      if (method === "PUT" && url.pathname.startsWith("/job/input/")) {
        const n = Number(url.pathname.slice("/job/input/".length));
        if (s.jobId) return err("already_started", 409);
        const bytes = new Uint8Array(await new Response(init.body as NonNullable<RequestInit["body"]>).arrayBuffer());
        if (n === 0) s.mode = modeOf(bytes);
        s.chunks[n] = bytes.length;
        await storage.put(KEY, s);
        return json({ n, size: bytes.length });
      }
      if (method === "POST" && url.pathname === "/job/start") {
        if (s.jobId) return err("already_started", 409);
        const body = JSON.parse(String(init.body)) as {
          jobId: string;
          ext: string;
          size: number;
          sha256: string;
          chunks: number;
        };
        if (s.chunks.length !== body.chunks || s.chunks.reduce((a, b) => a + b, 0) !== body.size)
          return err("chunks_mismatch", 422);
        Object.assign(s, { jobId: body.jobId, ext: body.ext, size: body.size, sha256: body.sha256, startedAt: now() });
        await storage.put(KEY, s);
        return json({ state: "running" }, 202);
      }
      if (!s.jobId)
        return url.pathname === "/job/status"
          ? json({ state: "idle", stage: null, pct: 0, error: null, pages: null, ready: [] })
          : err("not_ready", 409);
      const st = state(s);
      if (url.pathname === "/job/status") {
        const pages = st.state === "running" || st.done ? { done: st.pages, total: 3 } : null;
        return json({ state: st.state, stage: st.stage, pct: st.done ? 100 : 40, error: st.error, pages, ready: [] });
      }
      if (!st.done) return err("not_ready", 409);
      const out = await outputs(s);
      if (url.pathname === "/out/manifest.json") return json(out.manifest);
      const file = out.files.get(url.pathname.slice("/out/".length));
      return file ? new Response(file as Uint8Array<ArrayBuffer>) : err("not_found", 404);
    },
  };
}
