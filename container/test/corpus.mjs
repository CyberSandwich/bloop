// Runs the fixture corpus against the built image, the way production runs it:
// `docker run --network none --read-only`, non-root, tmpfs for /work and /tmp.
//
// A --network none container publishes no ports, so the runner talks to it from the host with curl
// entered into the container's network namespace (sudo nsenter). Linux only; CI is the arbiter.
//
// Usage: IMAGE=bloop-converter:ci node container/test/corpus.mjs
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectVba } from "../fixtures/inject-vba.mjs";

const IMAGE = process.env.IMAGE ?? "bloop-converter:ci";
const here = fileURLToPath(new URL(".", import.meta.url));
const FIX = join(here, "..", "fixtures");
const GEN = join(FIX, "generated");
const MEDIA = join(FIX, "media");
const SENTINEL = "/tmp/bloop-macro-ran";
const CANARY_PORT = 8099;
const work = mkdtempSync(join(tmpdir(), "bloop-corpus-"));

const failures = [];
const timings = [];
let seq = 0;

function check(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
  return cond;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const docker = (...args) => sh("docker", args);

function start({ env = {}, name } = {}) {
  const cname = `bloop-corpus-${process.pid}-${seq++}`;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = docker(
    "run",
    "-d",
    "--name",
    cname,
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

function stop(c) {
  if (failures.length) {
    const logs = docker("logs", "--tail", "40", c.name);
    console.log(`  --- container log (${c.name}) ---\n${logs.out}\n${logs.err}\n  ---`);
  }
  docker("rm", "-f", c.name);
}

/** Runs a command inside the container's network namespace, on the host's filesystem. */
const inNs = (c, args) => sh("sudo", ["-n", "nsenter", "-t", c.pid, "-n", "--", ...args]);

const curl = (c, args) => inNs(c, ["curl", "-sS", "--max-time", "1800", ...args]);

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function healthy(c) {
  for (let i = 0; i < 60; i++) {
    if (curl(c, ["-f", "http://127.0.0.1:8080/healthz"]).code === 0) return true;
    await sleep(500);
  }
  return false;
}

const URL_BASE = "http://127.0.0.1:8080";
const DEFAULT_CHUNK = 64 << 20;

/** Sends one request and returns its status code and body text. */
function request(c, method, path, extra = []) {
  const r = curl(c, ["-X", method, "-H", "Expect:", "-w", "\n%{http_code}", ...extra, `${URL_BASE}${path}`]);
  const i = r.out.lastIndexOf("\n");
  return { code: Number(r.out.slice(i + 1)), text: r.out.slice(0, i) };
}

/** Splits the file into chunks, hashing the whole as it goes. */
function chunkFile(file, chunk) {
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
function post(c, id, ext, file, { chunk } = {}) {
  chunk ??= DEFAULT_CHUNK;
  const { size, sha256, paths } = chunkFile(file, chunk);
  for (const [i, p] of paths.entries()) {
    const r = request(c, "PUT", `/job/input/${i}`, ["-T", p]);
    if (r.code !== 200) return r.code;
  }
  const body = JSON.stringify({ jobId: id, ext, size, sha256, chunks: paths.length });
  return request(c, "POST", "/job/start", ["-H", "Content-Type: application/json", "--data-binary", body]).code;
}

function getJSON(c, path) {
  const r = request(c, "GET", path);
  let body = null;
  try {
    body = JSON.parse(r.text);
  } catch {}
  return { code: r.code, body };
}

/** Polls to a terminal state. The first time the status lists ready files, those are fetched mid-job and recorded. */
async function finish(c, limitMs = 20 * 60 * 1000) {
  const t0 = Date.now();
  let early = null;
  for (;;) {
    const { body } = getJSON(c, "/job/status");
    if (body?.ready?.length && !early) {
      early = { status: body, hashes: {} };
      for (const p of body.ready) early.hashes[p] = sha(download(c, p, join(work, `early-${seq++}`)));
    }
    if (body && (body.state === "done" || body.state === "failed")) return { status: body, ms: Date.now() - t0, early };
    if (Date.now() - t0 > limitMs) throw new Error("job did not finish in time");
    await sleep(500);
  }
}

function download(c, path, dest) {
  const r = curl(c, ["-f", "-o", dest, `${URL_BASE}/out/${path}`]);
  if (r.code !== 0) throw new Error(`download ${path}: ${r.err}`);
  return readFileSync(dest);
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function webpWidth(b) {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return 0;
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8 ") return b.readUInt16LE(26) & 0x3fff;
  if (kind === "VP8L") return (b.readUInt32LE(21) & 0x3fff) + 1;
  if (kind === "VP8X") return (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
  return 0;
}

/** Runs one fixture to a terminal state and, when it finished, pulls every output into a directory. */
async function runJob(c, file, ext, { id = "corpus-job", chunk } = {}) {
  const code = post(c, id, ext, file, { chunk });
  if (code !== 202) throw new Error(`upload answered ${code}`);
  const { status, ms, early } = await finish(c);
  const out = { status, ms, early, files: {}, manifest: null };
  if (status.state === "done") {
    const dir = join(work, `out-${seq++}`);
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

function expectDeckOutputs(r, pages, label, { widths = [3840, 1920, 480], total = pages } = {}) {
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
  check(r.files["t.webp"] && webpWidth(r.files["t.webp"]) === 480, `${label}: t.webp is 480 px`);
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

async function expectRefusal(fixtureName, ext, code, { env } = {}) {
  console.log(`refusal ${fixtureName} -> ${code}`);
  const c = start({ env });
  try {
    check(await healthy(c), `${fixtureName}: container is healthy`);
    const t0 = Date.now();
    const r = await runJob(c, join(GEN, fixtureName), ext);
    check(
      r.status.state === "failed" && r.status.error === code,
      `${fixtureName}: failed with ${code} (got ${JSON.stringify(r.status)})`,
    );
    check(getJSON(c, "/out/manifest.json").code === 409, `${fixtureName}: no manifest after a refusal`);
    console.log(`  ${Date.now() - t0} ms`);
    return c;
  } finally {
    stop(c);
  }
}

/** Page 1 must be fetchable while the job runs, and be the very bytes the manifest lists. */
function checkEarly(r, pages, label, { strict, widths = [3840] }) {
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

async function caseDeck(
  fixtureName,
  ext,
  pages,
  assert,
  { timing = false, env, widths, total, strictEarly = false } = {},
) {
  console.log(`corpus ${fixtureName}`);
  const c = start({ env });
  try {
    check(await healthy(c), `${fixtureName}: container is healthy`);
    const file = join(GEN, fixtureName);
    const r = await runJob(c, file, ext);
    if (timing) timings.push(`${fixtureName}: ${(r.ms / 1000).toFixed(1)} s for ${pages} pages`);
    const got = expectDeckOutputs(r, pages, fixtureName, { widths, total });
    if (got) {
      check(got.meta.sha256 === sha(readFileSync(file)), `${fixtureName}: meta.sha256 is the SHA-256 of the upload`);
      checkEarly(r, pages, fixtureName, { strict: strictEarly, widths });
      assert?.(got, r);
    }
    // CONV-07: the container is spent after one job.
    check(post(c, "second", ext, file) === 409, `${fixtureName}: a second job is refused`);
  } finally {
    stop(c);
  }
}

function macroSideEffect(c) {
  return docker("exec", c.name, "test", "-e", SENTINEL).code === 0;
}

async function caseMacro(file, ext) {
  console.log(`macro ${file}`);
  const c = start();
  try {
    check(await healthy(c), `${file}: container is healthy`);
    const r = await runJob(c, file, ext);
    const label = file.split("/").pop();
    check(r.status.state === "done", `${label}: the converter still converts it (status ${JSON.stringify(r.status)})`);
    check(!macroSideEffect(c), `CONV-03 macros: ${label} left no ${SENTINEL}`);
  } finally {
    stop(c);
  }
}

const RELAXED = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Filter/Import/VBA"><prop oor:name="Executable" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Filter/Import/VBA"><prop oor:name="Executable" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Impress/Filter/Import/VBA"><prop oor:name="Executable" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`;

/** The positive control: with macro security off, the same file must fire its macro, or the test above proves nothing. */
function macroRun(file, mode, profile) {
  const dir = join(work, `control-${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "relaxed.xcu"), RELAXED);
  const name = file.split("/").pop();
  const registry = profile === "relaxed" ? "/ctl/relaxed.xcu" : "/opt/bloop/lo-registry.xcu";
  const flags = `--headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P`;
  // "convert" is the path the job server uses. "open" loads the document the way a user would, which is where
  // document-open events run; it is polled for the sentinel and then abandoned.
  const run =
    mode === "convert"
      ? `HOME="$P" soffice ${flags} --convert-to pdf --outdir "$P/out" /fx/${name} >/dev/null 2>&1`
      : `(HOME="$P" soffice ${flags} /fx/${name} >/dev/null 2>&1 &) ; for i in $(seq 1 40); do [ -e ${SENTINEL} ] && break; sleep 0.5; done`;
  const script = [
    "set -u",
    "P=$(mktemp -d)",
    'mkdir -p "$P/user"',
    `cp ${registry} "$P/user/registrymodifications.xcu"`,
    run,
    `if [ -e ${SENTINEL} ]; then echo FIRED; else echo SILENT; fi`,
  ].join("\n");
  const fxDir = file.slice(0, file.lastIndexOf("/"));
  const r = docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--workdir",
    "/tmp",
    "--tmpfs",
    "/tmp:rw,mode=1777,size=2g",
    "--tmpfs",
    "/work:rw,mode=0700,uid=10001,gid=10001",
    "-v",
    `${fxDir}:/fx:ro`,
    "-v",
    `${dir}:/ctl:ro`,
    "--entrypoint",
    "bash",
    IMAGE,
    "-c",
    script,
  );
  const result = r.out.split("\n").pop();
  console.log(`  ${name} ${mode} with the ${profile} profile: ${result}`);
  return result === "FIRED";
}

/**
 * The positive control. With macro security off the file must fire its macro by some path, or "no side effect"
 * proves nothing; and the production registry must keep the same path silent.
 */
function macroProof(file, { mustFire = true } = {}) {
  const name = file.split("/").pop();
  const fired = {};
  for (const mode of ["convert", "open"]) fired[mode] = macroRun(file, mode, "relaxed");
  if (mustFire)
    check(fired.convert || fired.open, `CONV-03 macros: ${name} fires its macro when security is off (the control)`);
  else
    console.log(
      `  ${name}: control ${fired.convert || fired.open ? "fires" : "does not fire (unverified, backstopped by the upload refusal)"}`,
    );
  for (const mode of ["convert", "open"]) {
    if (fired[mode])
      check(
        !macroRun(file, mode, "production"),
        `CONV-03 macros: ${name} stays silent under the production registry (${mode})`,
      );
  }
  return fired;
}

// A throwaway profile used only to make the legacy fixtures: VBA is loaded and saved, never executed.
const LEGACY_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
${["Writer", "Calc", "Impress"].map((a) => `<item oor:path="/org.openoffice.Office.${a}/Filter/Import/VBA"><prop oor:name="Load" oor:op="fuse"><value>true</value></prop></item>\n<item oor:path="/org.openoffice.Office.${a}/Filter/Import/VBA"><prop oor:name="Save" oor:op="fuse"><value>true</value></prop></item>`).join("\n")}
</oor:items>
`;

const LEGACY = [
  ["macro.odt", "doc", "MS Word 97"],
  ["macro.ods", "xls", "MS Excel 97"],
  ["macro.odp", "ppt", "MS PowerPoint 97"],
];

/** Converts the ODF macro fixtures to the legacy binary formats; returns the files that carry a VBA storage. */
function makeLegacyMacros() {
  const outDir = join(GEN, "legacy");
  mkdirSync(outDir, { recursive: true });
  const ctl = join(work, "legacy-profile");
  mkdirSync(ctl, { recursive: true });
  writeFileSync(join(ctl, "legacy.xcu"), LEGACY_PROFILE);
  const lines = [
    "set -u",
    "P=$(mktemp -d)",
    'mkdir -p "$P/user"',
    'cp /ctl/legacy.xcu "$P/user/registrymodifications.xcu"',
  ];
  for (const [src, ext, filter] of LEGACY) {
    lines.push(
      `HOME="$P" soffice --headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P --convert-to '${ext}:${filter}' --outdir /out /fx/${src} >/dev/null 2>&1`,
    );
  }
  const uid = `${process.getuid()}:${process.getgid()}`;
  docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    uid,
    "--workdir",
    "/tmp",
    "--tmpfs",
    "/tmp:rw,mode=1777,size=2g",
    "-v",
    `${GEN}:/fx:ro`,
    "-v",
    `${outDir}:/out`,
    "-v",
    `${ctl}:/ctl:ro`,
    "--entrypoint",
    "bash",
    IMAGE,
    "-c",
    lines.join("\n"),
  );
  const good = [];
  for (const [, ext] of LEGACY) {
    const f = join(outDir, `macro.${ext}`);
    if (!existsSync(f)) {
      console.log(`  legacy ${ext}: not produced`);
      continue;
    }
    // CFB directory names are UTF-16LE.
    const hasVba = (b) => ["_VBA_PROJECT_CUR", "Macros"].some((m) => b.includes(Buffer.from(m, "utf16le")));
    let buf = readFileSync(f);
    const fromLibreOffice = hasVba(buf);
    if (!fromLibreOffice) {
      // LibreOffice does not turn an ODF Basic library into a VBA project; add the storages ourselves.
      buf = injectVba(buf);
      writeFileSync(f, buf);
    }
    console.log(
      `  legacy ${ext}: ${buf.length} B, VBA storage from ${fromLibreOffice ? "LibreOffice" : "the synthetic injector"}`,
    );
    if (hasVba(buf)) good.push(f);
  }
  return good;
}

async function caseExternal(fixtureName, ext) {
  console.log(`external ${fixtureName}`);
  const c = start();
  const log = join(work, `canary-${seq++}.log`);
  const canary = spawn(
    "sudo",
    ["-n", "nsenter", "-t", c.pid, "-n", "--", process.execPath, join(here, "canary.mjs"), String(CANARY_PORT), log],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  try {
    check(await healthy(c), `${fixtureName}: container is healthy`);
    await sleep(1500);
    // The control: a connection from inside the namespace is seen, so silence below means something.
    inNs(c, [process.execPath, "-e", `require("net").connect(${CANARY_PORT},"127.0.0.1",function(){this.end()})`]);
    await sleep(500);
    const seen = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    check(seen() === 1, `${fixtureName}: the canary hears a deliberate connection (heard ${seen()})`);
    const r = await runJob(c, join(GEN, fixtureName), ext);
    check(r.status.state === "done", `${fixtureName}: converts (status ${JSON.stringify(r.status)})`);
    check(
      seen() === 1,
      `DROP-14 external: ${fixtureName} made no connection to its external targets (heard ${seen() - 1})`,
    );
  } finally {
    canary.stdin.end("stop\n");
    stop(c);
  }
}

async function caseMedia() {
  console.log("video hevc.mov");
  let c = start();
  try {
    check(await healthy(c), "hevc.mov: container is healthy");
    const r = await runJob(c, join(MEDIA, "hevc.mov"), "mov");
    check(r.status.state === "done", `hevc.mov: done (status ${JSON.stringify(r.status)})`);
    const mp4 = r.files["m/0.mp4"];
    check(mp4 && mp4.toString("latin1", 4, 8) === "ftyp", "hevc.mov: m/0.mp4 is an mp4");
    check(r.files["t.webp"] && webpWidth(r.files["t.webp"]) <= 480, "hevc.mov: t.webp thumbnail");
    const meta = JSON.parse(r.files["meta.json"] ?? "{}");
    check(
      meta.video?.w === 320 && meta.video?.h === 180 && meta.video?.durationMs > 1000,
      `hevc.mov: meta.video ${JSON.stringify(meta.video)}`,
    );
    check(
      !r.files["doc.pdf"] && !Object.keys(r.files).some((p) => p.startsWith("s/")),
      "hevc.mov: no document outputs",
    );
  } finally {
    stop(c);
  }
  console.log("image photo.heic");
  c = start();
  try {
    check(await healthy(c), "photo.heic: container is healthy");
    const r = await runJob(c, join(MEDIA, "photo.heic"), "heic");
    check(r.status.state === "done", `photo.heic: done (status ${JSON.stringify(r.status)})`);
    const jpg = r.files["i/1920.jpg"];
    check(jpg && jpg[0] === 0xff && jpg[1] === 0xd8, "photo.heic: i/1920.jpg is a jpeg");
    check(r.files["t.webp"] && webpWidth(r.files["t.webp"]) === 480, "photo.heic: t.webp is 480 px");
  } finally {
    stop(c);
  }
}

async function casePdfActive() {
  console.log("pdf-js.pdf");
  const c = start();
  try {
    check(await healthy(c), "pdf-js.pdf: container is healthy");
    const r = await runJob(c, join(GEN, "pdf-js.pdf"), "pdf");
    const got = expectDeckOutputs(r, 2, "pdf-js.pdf");
    if (got) {
      const pdf = r.files["doc.pdf"].toString("latin1");
      check(
        !/\/JavaScript|\/Launch|\/EmbeddedFile|\/OpenAction/.test(pdf),
        "DROP-13 pdf-active: doc.pdf carries no script, launch or attachment",
      );
    }
  } finally {
    stop(c);
  }
}

async function caseTimeoutAndCaps() {
  console.log("timeout and caps");
  let c = start({ env: { BLOOP_TIMEOUT_RASTERIZE: "1" } });
  try {
    check(await healthy(c), "timeout: container is healthy");
    const r = await runJob(c, join(GEN, "deck-100.pptx"), "pptx");
    check(
      r.status.state === "failed" && r.status.error === "timeout",
      `CONV-02 caps: a 1 s rasterize limit fails the job (got ${JSON.stringify(r.status)})`,
    );
    const top = docker("top", c.name).out;
    check(!/pdftoppm|vips/.test(top), "CONV-02 caps: no renderer survives the timeout");
  } finally {
    stop(c);
  }
  c = start({ env: { BLOOP_MAX_INPUT: "1000" } });
  try {
    check(await healthy(c), "max input: container is healthy");
    check(post(c, "big", "pptx", join(GEN, "plain.pptx")) === 413, "CONV-02 caps: an upload over the limit gets 413");
    check(getJSON(c, "/job/status").body?.error === "too_large", "CONV-02 caps: status says too_large");
  } finally {
    stop(c);
  }
}

/** The chunked upload and the response rules, against a real container with no network. */
async function caseUploadContract() {
  console.log("upload contract");
  let c = start({ env: { BLOOP_MAX_CHUNK: "1000" } });
  try {
    check(await healthy(c), "chunks: container is healthy");
    const file = join(GEN, "plain.pptx");
    const over = request(c, "PUT", "/job/input/0", ["-T", file]);
    check(
      over.code === 413 && over.text.includes("chunk_too_large"),
      `chunks: a chunk over BLOOP_MAX_CHUNK gets 413 (${over.code} ${over.text})`,
    );
    check(getJSON(c, "/job/status").body?.state === "idle", "chunks: an oversized chunk does not spend the container");
    const wrong = JSON.stringify({ jobId: "j", ext: "pptx", size: 1, sha256: "0".repeat(64), chunks: 1 });
    const mismatch = request(c, "POST", "/job/start", ["-H", "Content-Type: application/json", "--data-binary", wrong]);
    check(mismatch.code === 422, `chunks: a start that does not match the chunks gets 422 (${mismatch.code})`);
    const r = await runJob(c, file, "pptx", { chunk: 1000 });
    const got = expectDeckOutputs(r, 2, "plain.pptx in 1000 B chunks");
    check(
      got?.meta.sha256 === sha(readFileSync(file)),
      "chunks: the input assembled from 1000 B chunks hashes as the file",
    );
  } finally {
    stop(c);
  }

  c = start();
  try {
    check(await healthy(c), "bodies: container is healthy");
    for (const [method, path] of [
      ["GET", "/nowhere"],
      ["POST", "/healthz"],
      ["GET", "/job/start"],
      ["PUT", "/job/input/x"],
      ["POST", "/job/start"],
      ["GET", "/out/manifest.json"],
      ["GET", "/out/s/1/3840.webp"],
    ]) {
      const r = request(c, method, path);
      check(
        r.code >= 400 && r.text.length > 0,
        `every response has a body: ${method} ${path} -> ${r.code} ${r.text.length} B`,
      );
    }
  } finally {
    stop(c);
  }

  console.log("big.pdf");
  c = start();
  try {
    check(await healthy(c), "big.pdf: container is healthy");
    const file = join(GEN, "big.pdf");
    check(statSync(file).size > 100 << 20, "big.pdf: the fixture is over 100 MiB");
    const r = await runJob(c, file, "pdf");
    const got = expectDeckOutputs(r, 1, "big.pdf");
    check(
      got?.meta.sha256 === sha(readFileSync(file)),
      "big.pdf: a file over 100 MiB arrives intact in chunks, with no network",
    );
  } finally {
    stop(c);
  }
}

async function caseIsolation() {
  console.log("isolation");
  const c = start();
  try {
    check(await healthy(c), "isolation: container is healthy");
    const exec = (...a) => docker("exec", c.name, ...a);
    check(exec("id", "-u").out === "10001", "CONV-01 isolation: runs as uid 10001");
    check(
      exec("sh", "-c", "touch /usr/bloop-write-test").code !== 0,
      "CONV-01 isolation: the root filesystem is read-only",
    );
    check(exec("sh", "-c", "touch /work/ok /tmp/ok").code === 0, "CONV-01 isolation: /work and /tmp are writable");
    check(
      exec("cat", "/opt/bloop/lo-registry.xcu").out.includes("MacroSecurityLevel"),
      "CONV-03 macros: the job user can read the lockdown registry (a perms regression would fail every job as internal)",
    );
    check(
      exec("sh", "-c", "ls /sys/class/net").out === "lo",
      `CONV-01 isolation: only a loopback interface (got ${exec("sh", "-c", "ls /sys/class/net").out})`,
    );
    check(exec("bash", "-c", "exec 3<>/dev/tcp/1.1.1.1/53").code !== 0, "CONV-01 isolation: no route to the internet");
    const info = JSON.parse(docker("inspect", c.name).out)[0].HostConfig;
    check(
      info.NetworkMode === "none" && info.ReadonlyRootfs === true,
      "CONV-01 isolation: started with --network none --read-only",
    );
    check(
      exec("sh", "-c", "find / -xdev -perm /6000 -type f 2>/dev/null | head -1").out === "",
      "CONV-01 isolation: no setuid or setgid binary",
    );
  } finally {
    stop(c);
  }
  console.log("image contents");
  const pkgs = docker("run", "--rm", "--entrypoint", "sh", IMAGE, "-c", "dpkg -l | awk '{print $2}'").out;
  check(!/openjdk|default-jre|libreoffice-java|^jre/m.test(pkgs), "image: no Java runtime");
  for (const need of [
    "libreoffice-impress",
    "libreoffice-writer",
    "libreoffice-calc",
    "poppler-utils",
    "libvips-tools",
    "ffmpeg",
    "fonts-crosextra-carlito",
    "fonts-crosextra-caladea",
    "fonts-liberation2",
    "fonts-noto-core",
  ]) {
    check(new RegExp(`^${need}`, "m").test(pkgs), `image: ${need} is installed`);
  }
  const fonts = docker("run", "--rm", "--entrypoint", "fc-list", IMAGE, ":", "family").out.toLowerCase();
  for (const f of ["carlito", "caladea", "liberation sans", "noto sans"]) check(fonts.includes(f), `image: font ${f}`);
}

async function main() {
  if (process.platform !== "linux") throw new Error("the corpus needs Linux (nsenter)");
  for (const f of ["plain.pptx", "bomb.pptx"]) {
    if (!existsSync(join(GEN, f))) throw new Error(`missing ${f}: run node container/fixtures/make.mjs first`);
  }
  await caseDeck("plain.pptx", "pptx", 2, (got) => {
    check(
      got.notes.notes.length === 0 && got.slides.motion === false && got.slides.media === false,
      "plain.pptx: no notes, no motion, no media",
    );
    check(got.meta.fontsMissing.length === 0, `plain.pptx: no missing fonts (got ${got.meta.fontsMissing})`);
  });
  await caseDeck("animated.pptx", "pptx", 3, (got) =>
    check(got.slides.motion === true, "animated.pptx: motion is flagged"),
  );
  await caseDeck("notes.pptx", "pptx", 3, (got) => {
    const [a, b] = got.notes.notes;
    check(
      got.notes.notes.length === 2 &&
        a.n === 1 &&
        a.text === "Open with the numbers.\nPause here." &&
        b.n === 3 &&
        b.text.length === 4000,
      `notes.pptx: notes ${JSON.stringify(got.notes.notes).slice(0, 200)}`,
    );
  });
  await caseDeck("aptos.pptx", "pptx", 2, (got) =>
    check(
      got.meta.fontsMissing.includes("Aptos") && got.meta.fontsMissing.includes("Aptos Display"),
      `aptos.pptx: fontsMissing ${got.meta.fontsMissing}`,
    ),
  );
  await caseDeck("deck-20.pptx", "pptx", 20, null, { timing: true });
  await caseDeck("deck-100.pptx", "pptx", 100, null, { timing: true, strictEarly: true });
  await caseDeck("plain.pptx", "pptx", 2, null, { env: { BLOOP_WIDTHS: "1280,640,320" }, widths: [1280, 640, 320] });
  await caseDeck("pages-301.pdf", "pdf", 40, null, { env: { BLOOP_MAX_PAGES: "40" }, total: 301 });
  await casePdfActive();
  await caseMedia();
  for (const f of ["macro.odp", "macro.odt", "macro.ods"]) {
    await caseMacro(join(GEN, f), f.split(".")[1]);
    macroProof(join(GEN, f));
  }
  const legacy = makeLegacyMacros();
  check(
    legacy.length === LEGACY.length,
    `legacy macro fixtures: ${legacy.length} of ${LEGACY.length} carry a VBA storage`,
  );
  for (const f of legacy) {
    await caseMacro(f, f.split(".").pop());
    console.log(`  legacy control ${f}: ${JSON.stringify(macroProof(f, { mustFire: false }))}`);
  }
  await caseExternal("external.pptx", "pptx");
  await caseExternal("external.docx", "docx");
  await expectRefusal("bomb.pptx", "pptx", "bomb");
  await expectRefusal("bad-magic.pptx", "pptx", "bad_magic");
  await caseUploadContract();
  await caseTimeoutAndCaps();
  await caseIsolation();

  const summary = ["## Corpus timings", "", ...timings.map((t) => `- ${t}`)].join("\n");
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: "a" });
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\ncorpus passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
