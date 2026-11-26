// Corpus cases: one container per case, one job per container.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_IMAGE_PATH, LINK_MARKER, LINK_PATH } from "../fixtures/lib.mjs";
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
import { timingOf } from "./result.mjs";

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

/** A job's total and per-stage seconds for the job summary, from when status first showed each stage. */
function stageTimes(r) {
  const { ms, stageAt: s } = timingOf(r);
  const convert = (s.rasterize ?? ms) - (s.convert ?? 0);
  const rasterize = ms - (s.rasterize ?? ms);
  return `${secs(ms)} (convert ${secs(convert)}, rasterize ${secs(rasterize)})`;
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

const LINK_FIXTURES = [
  ["linked.odt", "odt"],
  ["linked.docx", "docx"],
  ["linked.rtf", "rtf"],
];

const STRACE_IMAGE = "bloop-converter-strace:corpus";

/** The text and the number of images in a PDF, read with the image's own poppler tools. */
function pdfFacts(pdf) {
  const dir = join(work, `facts-${uniq()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "doc.pdf"), pdf);
  const script = 'pdftotext /o/doc.pdf -; echo "@@images $(pdfimages -list /o/doc.pdf | tail -n +3 | wc -l)"';
  const out = docker("run", "--rm", "-v", `${dir}:/o:ro`, "--entrypoint", "bash", IMAGE, "-c", script).out;
  const [text, images] = out.split("@@images ");
  return { text, images: Number(images) };
}

const registryWith = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${items}
</oor:items>
`;

/** The one setting production and the control differ in: whether a document may pull in a file it links to. */
const LINKS_ALLOWED = registryWith(
  `<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>false</value></prop></item>`,
);

/**
 * Converts linked-image.odt under a registry, with strace on openat in a control-only image (the converter
 * image plus strace; the image under test is unchanged). Returns how often the linked file was opened and how
 * many images the PDF holds.
 */
function followTrial(registry) {
  const script = [
    "set -u",
    `vips black ${LINK_IMAGE_PATH} 20 20`,
    'P=$(mktemp -d); mkdir -p "$P/user" "$P/out"',
    `cp ${registry} "$P/user/registrymodifications.xcu"`,
    `HOME="$P" timeout 120 strace -f -qq -e trace=openat -o /tmp/st soffice --headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P --convert-to pdf --outdir "$P/out" /fx/linked-image.odt >/dev/null 2>&1`,
    `echo "opens=$(grep -c '${LINK_IMAGE_PATH}' /tmp/st) images=$(pdfimages -list "$P/out/linked-image.pdf" | tail -n +3 | wc -l)"`,
  ].join("\n");
  const dir = join(work, `trial-${uniq()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "links-allowed.xcu"), LINKS_ALLOWED);
  const out = docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-add",
    "SYS_PTRACE",
    "--tmpfs",
    "/tmp:rw,mode=1777,size=2g",
    "-v",
    `${GEN}:/fx:ro`,
    "-v",
    `${dir}:/ctl:ro`,
    "--entrypoint",
    "bash",
    STRACE_IMAGE,
    "-c",
    script,
  ).out;
  const m = out.match(/opens=(\d+) images=(\d+)/);
  if (!m) throw new Error(`link trial gave no result: ${out}`);
  return { opens: Number(m[1]), images: Number(m[2]) };
}

/**
 * DROP-14, the file half. LibreOffice follows a linked image's file:// target when the registry allows it and
 * not under the production registry; the same fixture then goes through a real job. Section and INCLUDETEXT
 * links are not followed under any registry setting tried, so for those the marker test below shows nothing
 * beyond the converter finishing; they are reported unverified.
 */
export async function caseLinks() {
  console.log("links");
  const built = docker(
    "build",
    "--build-arg",
    `BASE=${IMAGE}`,
    "-t",
    STRACE_IMAGE,
    "-f",
    join(here, "Dockerfile.strace"),
    here,
  );
  check(built.code === 0, `links: the strace control image builds (${built.err.slice(-200)})`);
  const allowed = followTrial("/ctl/links-allowed.xcu");
  const production = followTrial("/opt/bloop/lo-registry.xcu");
  console.log(`  linked image: allowed ${JSON.stringify(allowed)}, production ${JSON.stringify(production)}`);
  check(
    allowed.opens > 0 && allowed.images > 0,
    `DROP-14 links: the control fires, LibreOffice opens the linked image when links are allowed (${JSON.stringify(allowed)})`,
  );
  check(
    production.opens === 0 && production.images === 0,
    `DROP-14 links: the production registry never opens the linked image (${JSON.stringify(production)})`,
  );

  const c = start();
  try {
    check(await healthy(c), "linked-image.odt: container is healthy");
    docker("exec", c.name, "vips", "black", LINK_IMAGE_PATH, "20", "20");
    const r = await runJob(c, join(GEN, "linked-image.odt"), "odt");
    check(r.status.state === "done", `linked-image.odt: converts (status ${JSON.stringify(r.status)})`);
    const facts = pdfFacts(r.files["doc.pdf"] ?? Buffer.alloc(0));
    check(facts.images === 0, `DROP-14 links: the job's doc.pdf holds no linked image (${facts.images})`);
  } finally {
    stop(c);
  }

  for (const [f, ext] of LINK_FIXTURES) {
    const c2 = start();
    try {
      check(await healthy(c2), `${f}: container is healthy`);
      docker("exec", c2.name, "sh", "-c", `printf %s ${LINK_MARKER} > ${LINK_PATH}`);
      const r = await runJob(c2, join(GEN, f), ext);
      check(r.status.state === "done", `${f}: converts (status ${JSON.stringify(r.status)})`);
      const { text } = pdfFacts(r.files["doc.pdf"] ?? Buffer.alloc(0));
      check(text.length > 0 && !text.includes(LINK_MARKER), `DROP-14 links: ${f} did not read the file it links to`);
      console.log(`  ${f}: no registry setting makes this link update, so the control is unverified`);
    } finally {
      stop(c2);
    }
  }
}

/**
 * One CPU is the smallest instance a deployment is likely to offer. The job runs under the default stage
 * timeouts and must finish and validate; the stage times go to the job summary as recorded numbers, never as
 * a pass or fail (a shared runner's speed varies by 25 percent or more).
 */
export async function caseOneCpuTiming(fixtureName, pages) {
  await caseDeck(fixtureName, "pptx", pages, null, { cpus: 1, timing: true });
}

const RATE_SECONDS = 60;

/**
 * The encode rate behind BLOOP_MAX_VIDEO_SECONDS: a 1080p30 clip with grain (hard to encode, so the rate is
 * low) is made by the image's own ffmpeg and run as a job at one CPU. The job must finish and validate; the
 * seconds of video per second of wall time go to the job summary as a recorded number, never as a pass or fail.
 */
export async function caseVideoRate() {
  console.log(`video rate (${RATE_SECONDS} s of 1080p at 1 CPU)`);
  const gen = `bloop-gen-${process.pid}-${uniq()}`;
  const file = join(work, `rate-${uniq()}.mp4`);
  const made = docker(
    "run",
    "--name",
    gen,
    "--network",
    "none",
    "--entrypoint",
    "ffmpeg",
    IMAGE,
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1920x1080:rate=30,noise=alls=12:allf=t`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-t",
    String(RATE_SECONDS),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "/tmp/rate.mp4",
  );
  const copied = made.code === 0 ? docker("cp", `${gen}:/tmp/rate.mp4`, file) : made;
  docker("rm", "-f", gen);
  if (!check(copied.code === 0, `video rate: clip made (${copied.err})`)) return;
  const c = start({ cpus: 1 });
  try {
    check(await healthy(c), "video rate: container is healthy");
    const r = await runJob(c, file, "mp4");
    check(r.status.state === "done", `video rate: done (status ${JSON.stringify(r.status)})`);
    const { ms } = timingOf(r);
    timings.push(
      `video rate at 1 CPU: ${RATE_SECONDS} s of 1080p30 with grain in ${(ms / 1000).toFixed(1)} s, ` +
        `${(RATE_SECONDS / (ms / 1000)).toFixed(2)} s of video per second`,
    );
  } finally {
    stop(c);
  }
}
