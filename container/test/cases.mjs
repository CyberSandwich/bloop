// Corpus cases: one container per case, one job per container.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_MARKER, LINK_PATH } from "../fixtures/lib.mjs";
import {
  check,
  checkEarly,
  docker,
  expectDeckOutputs,
  GEN,
  getJSON,
  healthy,
  IMAGE,
  inNs,
  MEDIA,
  post,
  request,
  runJob,
  sha,
  sleep,
  start,
  stop,
  timings,
  uniq,
  webpWidth,
  work,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CANARY_PORT = 8099;

export async function expectRefusal(fixtureName, ext, code, { env } = {}) {
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

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Milliseconds each stage took, from when status first showed it. */
function stageDurations(r) {
  const s = r.stageAt;
  return { convert: (s.rasterize ?? r.ms) - (s.convert ?? 0), rasterize: r.ms - (s.rasterize ?? r.ms) };
}

function stageTimes(r) {
  const d = stageDurations(r);
  return `${secs(r.ms)} (convert ${secs(d.convert)}, rasterize ${secs(d.rasterize)})`;
}

export async function caseDeck(
  fixtureName,
  ext,
  pages,
  assert,
  { timing = false, env, widths, total, strictEarly = false, cpus } = {},
) {
  console.log(`corpus ${fixtureName}${cpus ? ` (${cpus} CPU)` : ""}`);
  const c = start({ env, cpus });
  try {
    check(await healthy(c), `${fixtureName}: container is healthy`);
    const file = join(GEN, fixtureName);
    const r = await runJob(c, file, ext);
    if (timing) timings.push(`${fixtureName}${cpus ? ` at ${cpus} CPU` : ""}: ${stageTimes(r)} for ${pages} pages`);
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

export async function caseExternal(fixtureName, ext) {
  console.log(`external ${fixtureName}`);
  const c = start();
  const log = join(work, `canary-${uniq()}.log`);
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

export async function caseMedia() {
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

export async function casePdfActive() {
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

export async function caseTimeoutAndCaps() {
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
  c = start({ env: { BLOOP_TIMEOUT_CONVERT: "1" } });
  try {
    check(await healthy(c), "convert timeout: container is healthy");
    const r = await runJob(c, join(GEN, "deck-100.pptx"), "pptx");
    check(
      r.status.state === "failed" && r.status.error === "timeout",
      `CONV-02 caps: a 1 s convert limit fails the job (got ${JSON.stringify(r.status)})`,
    );
    const top = docker("top", c.name).out;
    check(!/soffice/.test(top), `CONV-02 caps: no soffice survives the convert timeout (${top})`);
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
export async function caseUploadContract() {
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

export async function caseIsolation() {
  console.log("isolation");
  const c = start();
  try {
    check(await healthy(c), "isolation: container is healthy");
    const exec = (...a) => docker("exec", c.name, ...a);
    check(exec("id", "-u").out === "10001", "CONV-01 corpus run: runs as uid 10001");
    check(
      exec("sh", "-c", "touch /usr/bloop-write-test").code !== 0,
      "CONV-01 corpus run: the root filesystem is read-only",
    );
    check(exec("sh", "-c", "touch /work/ok /tmp/ok").code === 0, "CONV-01 corpus run: /work and /tmp are writable");
    check(
      exec("cat", "/opt/bloop/lo-registry.xcu").out.includes("MacroSecurityLevel"),
      "CONV-03 macros: the job user can read the lockdown registry (a perms regression would fail every job as internal)",
    );
    check(
      exec("sh", "-c", "ls /sys/class/net").out === "lo",
      `CONV-01 corpus run: only a loopback interface (got ${exec("sh", "-c", "ls /sys/class/net").out})`,
    );
    check(exec("bash", "-c", "exec 3<>/dev/tcp/1.1.1.1/53").code !== 0, "CONV-01 corpus run: no route to the internet");
    const info = JSON.parse(docker("inspect", c.name).out)[0].HostConfig;
    check(
      info.NetworkMode === "none" && info.ReadonlyRootfs === true,
      "CONV-01 corpus run: started with --network none --read-only",
    );
    check(
      exec("sh", "-c", "find / -xdev -perm /6000 -type f 2>/dev/null | head -1").out === "",
      "CONV-01 corpus run: no setuid or setgid binary",
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

/** The text of a PDF, read with the image's own pdftotext. */
function pdfText(pdf) {
  const dir = join(work, `text-${uniq()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "doc.pdf"), pdf);
  return docker("run", "--rm", "-v", `${dir}:/o:ro`, "--entrypoint", "pdftotext", IMAGE, "/o/doc.pdf", "-").out;
}

const LINK_FIXTURES = [
  ["linked.odt", "odt"],
  ["linked.docx", "docx"],
  ["linked.rtf", "rtf"],
];
const LINK_VALUES = [0, 1, 2];

/** The Writer link-update value the production registry sets. */
function productionLinkValue() {
  const xcu = readFileSync(join(here, "..", "lo-registry.xcu"), "utf8");
  const m = xcu.match(/Office\.Writer\/Content\/Update"><prop oor:name="Link"[^>]*><value>(\d)<\/value>/);
  if (!m) throw new Error("lo-registry.xcu sets no Writer Content/Update/Link");
  return Number(m[1]);
}

const linkRegistry = (value) => `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>${value}</value></prop></item>
</oor:items>
`;

/**
 * The positive control: which Writer link-update values make LibreOffice read the linked file on load. The
 * production value must not be one of them, and when no value does the format is reported unverified.
 */
function linkControl() {
  const dir = join(work, `link-control-${uniq()}`);
  mkdirSync(dir, { recursive: true });
  for (const v of LINK_VALUES) writeFileSync(join(dir, `link-${v}.xcu`), linkRegistry(v));
  const flags = "--headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P";
  const script = [
    "set -u",
    `printf %s ${LINK_MARKER} > ${LINK_PATH}`,
    ...LINK_FIXTURES.flatMap(([f]) =>
      LINK_VALUES.map((v) =>
        [
          'P=$(mktemp -d); mkdir -p "$P/user" "$P/out"',
          `cp /ctl/link-${v}.xcu "$P/user/registrymodifications.xcu"`,
          `HOME="$P" soffice ${flags} --convert-to pdf --outdir "$P/out" /fx/${f} >/dev/null 2>&1`,
          `if pdftotext "$P/out/${f.replace(/\.[^.]+$/, "")}.pdf" - | grep -q ${LINK_MARKER}; then echo "${f} ${v} UPDATED"; else echo "${f} ${v} CACHED"; fi`,
        ].join("\n"),
      ),
    ),
  ].join("\n");
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
    "-v",
    `${GEN}:/fx:ro`,
    "-v",
    `${dir}:/ctl:ro`,
    "--entrypoint",
    "bash",
    IMAGE,
    "-c",
    script,
  );
  const updating = {};
  for (const line of r.out.split("\n")) {
    const [f, v, state] = line.split(" ");
    if (state === "UPDATED") updating[f] = [...(updating[f] ?? []), Number(v)];
  }
  return updating;
}

/** Linked content must not be read on load: a marker file the links name must not reach doc.pdf. */
export async function caseLinks() {
  console.log("links");
  const updating = linkControl();
  const prod = productionLinkValue();
  for (const [f, ext] of LINK_FIXTURES) {
    const values = updating[f] ?? [];
    console.log(
      `  ${f}: Writer Link values that update on load: ${values.length ? values.join(",") : "none (control unverified)"}`,
    );
    if (f === "linked.odt")
      check(values.length > 0, `DROP-14 links: ${f} reads its link under some relaxed value (the control)`);
    check(!values.includes(prod), `DROP-14 links: the production Writer value ${prod} does not update ${f}`);
    const c = start();
    try {
      check(await healthy(c), `${f}: container is healthy`);
      docker("exec", c.name, "sh", "-c", `printf %s ${LINK_MARKER} > ${LINK_PATH}`);
      const r = await runJob(c, join(GEN, f), ext);
      check(r.status.state === "done", `${f}: converts (status ${JSON.stringify(r.status)})`);
      const text = r.files["doc.pdf"] ? pdfText(r.files["doc.pdf"]) : "";
      check(text.length > 0 && !text.includes(LINK_MARKER), `DROP-14 links: ${f} did not read the file it links to`);
    } finally {
      stop(c);
    }
  }
}

/** A stage default, read from the server's own table so the corpus cannot drift from it. */
function stageDefault(stage) {
  const go = readFileSync(join(here, "..", "main.go"), "utf8");
  const m = go.match(new RegExp(`"${stage}":\\s+(\\d+) \\* time\\.Second`));
  if (!m) throw new Error(`no default timeout for ${stage} in main.go`);
  return Number(m[1]) * 1000;
}

/**
 * One CPU is the smallest instance a deployment is likely to offer. The stage timeouts are lifted so the
 * stages can be measured, then each must use at most half of its default timeout.
 */
export async function caseOneCpuTiming(fixtureName, pages) {
  const env = { BLOOP_TIMEOUT_CONVERT: "3600", BLOOP_TIMEOUT_RASTERIZE: "3600", BLOOP_MAX_PAGES: "300" };
  const headroom = (_got, r) => {
    const d = stageDurations(r);
    for (const stage of ["convert", "rasterize"])
      check(
        d[stage] <= stageDefault(stage) / 2,
        `CONV-02 caps: ${fixtureName} at 1 CPU spends ${secs(d[stage])} in ${stage}, over half its ${secs(stageDefault(stage))} timeout`,
      );
  };
  await caseDeck(fixtureName, "pptx", pages, headroom, { env, cpus: 1, timing: true });
}
