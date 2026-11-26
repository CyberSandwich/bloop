// Shared harness for the corpus: starts the image the way CI does (`docker run --network none --read-only`,
// non-root, tmpfs for /work and /tmp, which is stricter than the deployed platform) and drives it from the
// host. A --network none container publishes no ports, so requests are curl run inside the container's
// network namespace (sudo nsenter). Linux only; CI is the arbiter.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordTiming, splitTiming } from "./result.mjs";

export const IMAGE = process.env.IMAGE ?? "bloop-converter:ci";
export const here = fileURLToPath(new URL(".", import.meta.url));
export const FIX = join(here, "..", "fixtures");
export const GEN = join(FIX, "generated");
export const MEDIA = join(FIX, "media");
export const work = mkdtempSync(join(tmpdir(), "bloop-corpus-"));

export const failures = [];
export const timings = [];
let seq = 0;

export function check(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
  return cond;
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export const docker = (...args) => sh("docker", args);

export function start({ env = {}, name, cpus } = {}) {
  const cname = `bloop-corpus-${process.pid}-${uniq()}`;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = docker(
    "run",
    "-d",
    "--name",
    cname,
    ...(cpus ? ["--cpus", String(cpus)] : []),
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/work:rw,nosuid,nodev,noexec,mode=0700,uid=10001,gid=10001,size=8g",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=2g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "2048",
    "--memory",
    "6g",
    ...envArgs,
    IMAGE,
  );
  if (r.code !== 0) throw new Error(`docker run failed: ${r.err}`);
  const pid = docker("inspect", "-f", "{{.State.Pid}}", cname).out;
  return { name: cname, pid, label: name };
}

export function stop(c) {
  if (failures.length) {
    const logs = docker("logs", "--tail", "40", c.name);
    console.log(`  --- container log (${c.name}) ---\n${logs.out}\n${logs.err}\n  ---`);
  }
  docker("rm", "-f", c.name);
}

/** Runs a command inside the container's network namespace, on the host's filesystem. */
export const inNs = (c, args) => sh("sudo", ["-n", "nsenter", "-t", c.pid, "-n", "--", ...args]);

export const curl = (c, args) => inNs(c, ["curl", "-sS", "--max-time", "1800", ...args]);

export async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function healthy(c) {
  for (let i = 0; i < 60; i++) {
    if (curl(c, ["-f", "http://127.0.0.1:8080/healthz"]).code === 0) return true;
    await sleep(500);
  }
  return false;
}

export const URL_BASE = "http://127.0.0.1:8080";
export const DEFAULT_CHUNK = 64 << 20;

/** Sends one request and returns its status code and body text. */
export function request(c, method, path, extra = []) {
  const r = curl(c, ["-X", method, "-H", "Expect:", "-w", "\n%{http_code}", ...extra, `${URL_BASE}${path}`]);
  const i = r.out.lastIndexOf("\n");
  return { code: Number(r.out.slice(i + 1)), text: r.out.slice(0, i) };
}

/** Splits the file into chunks, hashing the whole as it goes. */
export function chunkFile(file, chunk) {
  const size = statSync(file).size;
  const dir = mkdtempSync(join(work, "chunks-"));
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  const paths = [];
  const buf = Buffer.alloc(Math.min(chunk, size));
  for (let off = 0; off < size; off += chunk) {
    const n = readSync(fd, buf, 0, Math.min(chunk, size - off), off);
    hash.update(buf.subarray(0, n));
    const p = join(dir, `c${paths.length}`);
    writeFileSync(p, buf.subarray(0, n));
    paths.push(p);
  }
  closeSync(fd);
  return { size, sha256: hash.digest("hex"), paths };
}

/** The upload contract: PUT each chunk, then POST /job/start. Returns the first non-200 chunk status, else the start status. */
export function post(c, id, ext, file, { chunk } = {}) {
  chunk ??= DEFAULT_CHUNK;
  const { size, sha256, paths } = chunkFile(file, chunk);
  for (const [i, p] of paths.entries()) {
    const r = request(c, "PUT", `/job/input/${i}`, ["-T", p]);
    if (r.code !== 200) return r.code;
  }
  const body = JSON.stringify({ jobId: id, ext, size, sha256, chunks: paths.length });
  return request(c, "POST", "/job/start", ["-H", "Content-Type: application/json", "--data-binary", body]).code;
}

export function getJSON(c, path) {
  const r = request(c, "GET", path);
  let body = null;
  try {
    body = JSON.parse(r.text);
  } catch {}
  return { code: r.code, body };
}

/** Polls to a terminal state. The first time the status lists ready files, those are fetched mid-job and recorded. */
export async function finish(c, limitMs = 20 * 60 * 1000) {
  const t0 = Date.now();
  let early = null;
  const stageAt = {}; // when each stage was first seen, in ms from the start of polling
  for (;;) {
    const { body } = getJSON(c, "/job/status");
    if (body?.stage) stageAt[body.stage] ??= Date.now() - t0;
    if (body?.ready?.length && !early) {
      early = { status: body, hashes: {} };
      try {
        for (const p of body.ready) early.hashes[p] = sha(download(c, p, join(work, `early-${uniq()}`)));
      } catch (e) {
        // A job that fails withdraws page 1 between the status and the fetch; any other failure is real.
        if (getJSON(c, "/job/status").body?.state !== "failed") throw e;
        early = null;
      }
    }
    if (body && (body.state === "done" || body.state === "failed"))
      return { status: body, ms: Date.now() - t0, early, stageAt };
    if (Date.now() - t0 > limitMs) throw new Error("job did not finish in time");
    await sleep(500);
  }
}

export function download(c, path, dest) {
  const r = curl(c, ["-f", "-o", dest, `${URL_BASE}/out/${path}`]);
  if (r.code !== 0) throw new Error(`download ${path}: ${r.err}`);
  return readFileSync(dest);
}

export const sha = (buf) => createHash("sha256").update(buf).digest("hex");

export function webpWidth(b) {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return 0;
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8 ") return b.readUInt16LE(26) & 0x3fff;
  if (kind === "VP8L") return (b.readUInt32LE(21) & 0x3fff) + 1;
  if (kind === "VP8X") return (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
  return 0;
}

/** Runs one fixture to a terminal state and, when it finished, pulls every output into a directory. */
export async function runJob(c, file, ext, { id = "corpus-job", chunk } = {}) {
  const code = post(c, id, ext, file, { chunk });
  if (code !== 202) throw new Error(`upload answered ${code}`);
  const { status, ms, early, stageAt } = await finish(c);
  const { result: out, timing } = splitTiming({ status, ms, early, stageAt, files: {}, manifest: null });
  recordTiming(out, timing);
  if (status.state === "done") {
    const dir = join(work, `out-${uniq()}`);
    mkdirSync(dir, { recursive: true });
    const { body: manifest } = getJSON(c, "/out/manifest.json");
    out.manifest = manifest;
    for (const f of manifest.files) {
      const dest = join(dir, f.path.replaceAll("/", "__"));
      const buf = download(c, f.path, dest);
      check(buf.length === f.size && sha(buf) === f.sha256, `${f.path}: downloaded bytes match the manifest`);
      out.files[f.path] = buf;
    }
  }
  return out;
}

export function expectDeckOutputs(r, pages, label, { widths = [3840, 1920, 480], total = pages } = {}) {
  const m = r.manifest;
  if (!check(m && r.status.state === "done", `${label}: job is done (status ${JSON.stringify(r.status)})`)) return null;
  check(m.kind === "deck" || m.kind === "doc" || m.kind === "pdf" || m.kind === "sheet", `${label}: kind`);
  check(
    m.pages?.total === total && m.pages?.rendered === pages,
    `${label}: manifest.pages ${JSON.stringify(m.pages)}, want ${total} total and ${pages} rendered`,
  );
  check(
    ["slides", "pdf", "notes"].every((g) => m.groups?.[g]?.ok === true),
    `${label}: every output group passed (${JSON.stringify(m.groups)})`,
  );
  check(
    r.status.pages?.done === pages && r.status.pages?.total === pages,
    `${label}: final status.pages ${JSON.stringify(r.status.pages)}`,
  );
  check(r.files["doc.pdf"]?.toString("latin1", 0, 5) === "%PDF-", `${label}: doc.pdf is a pdf`);
  for (let n = 1; n <= pages; n++) {
    for (const w of widths) {
      const b = r.files[`s/${n}/${w}.webp`];
      check(b && webpWidth(b) === w, `${label}: s/${n}/${w}.webp is a ${w} px webp`);
    }
  }
  check(!r.files[`s/${pages + 1}/${widths.at(-1)}.webp`], `${label}: no page beyond ${pages}`);
  check(
    r.files["t.webp"] && webpWidth(r.files["t.webp"]) === widths.at(-1),
    `${label}: t.webp is as wide as the smallest rendition`,
  );
  const slides = JSON.parse(r.files["slides.json"]);
  const notes = JSON.parse(r.files["notes.json"]);
  const meta = JSON.parse(r.files["meta.json"]);
  check(
    slides.v === 1 &&
      JSON.stringify(slides.widths) === JSON.stringify(widths) &&
      slides.pages.length === pages &&
      slides.pages.every((p, i) => p.n === i + 1 && p.w === widths[0] && p.h > 0),
    `${label}: slides.json widths and pages`,
  );
  check(!("notes" in slides) && !JSON.stringify(slides).includes("text"), `${label}: slides.json carries no notes`);
  check(notes.v === 1 && Array.isArray(notes.notes), `${label}: notes.json shape`);
  check(/^[0-9a-f]{64}$/.test(meta.sha256) && Array.isArray(meta.fontsMissing), `${label}: meta.json shape`);
  return { slides, notes, meta };
}

/** A number that is unique within this run. */
export function uniq() {
  return seq++;
}

/** Page 1 must be fetchable while the job runs, and be the very bytes the manifest lists. */
export function checkEarly(r, pages, label, { strict, widths = [3840] }) {
  if (!r.early) return check(!strict, `${label}: status.ready listed page 1 before the job was done`);
  for (const [p, h] of Object.entries(r.early.hashes))
    check(r.manifest?.files.find((f) => f.path === p)?.sha256 === h, `${label}: early ${p} matches the manifest`);
  check(
    r.early.status.ready.includes(`s/1/${widths[0]}.webp`) && r.early.status.pages?.total === pages,
    `${label}: early status ${JSON.stringify(r.early.status)}`,
  );
  if (strict)
    check(
      r.early.status.state === "running" && r.early.status.pages.done < pages,
      `${label}: page 1 was fetched mid-job (${JSON.stringify(r.early.status.pages)})`,
    );
}
