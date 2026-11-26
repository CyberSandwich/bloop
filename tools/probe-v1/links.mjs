// Throwaway probe: which registry settings make LibreOffice follow a link, seen two ways: the marker
// text in the PDF, and a connection to a loopback listener inside the container's network namespace.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_MARKER, LINK_PATH, linkedOdt } from "../../container/fixtures/lib.mjs";
import { GEN, IMAGE, docker, sleep, work } from "../../container/test/lib.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const canaryJs = join(here, "..", "..", "container", "test", "canary.mjs");
const PORT = 8099;

writeFileSync(join(GEN, "linked-http.odt"), linkedOdt({ href: `http://127.0.0.1:${PORT}/marker.txt` }));
writeFileSync(join(GEN, "linked-image-http.odt"), linkedOdt({ href: `http://127.0.0.1:${PORT}/i.png`, image: true }));
writeFileSync(join(GEN, "linked-image-file.odt"), linkedOdt({ href: `file://${LINK_PATH}`, image: true }));

const reg = (items) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${items}\n</oor:items>\n`;
const item = (path, name, value) =>
  `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`;
const relaxed = (v) =>
  reg(
    [
      item("/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", "false"),
      item("/org.openoffice.Office.Writer/Content/Update", "Link", v),
      item("/org.openoffice.Office.Calc/Content/Update", "Link", v),
    ].join("\n"),
  );

const ctl = join(work, "links-ctl");
mkdirSync(ctl, { recursive: true });
for (const v of [0, 1, 2]) writeFileSync(join(ctl, `relaxed-${v}.xcu`), relaxed(v));

const FIXTURES = [
  "linked.odt",
  "linked.docx",
  "linked.rtf",
  "linked-http.odt",
  "linked-image-http.odt",
  "linked-image-file.odt",
  "external.docx",
  "external.pptx",
];
const PROFILES = ["production", "relaxed-0", "relaxed-1", "relaxed-2"];

async function trial(fixture, profile) {
  const name = `probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  docker(
    "run", "-d", "--name", name, "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,mode=1777,size=2g",
    "-v", `${GEN}:/fx:ro`, "-v", `${ctl}:/ctl:ro`, "--entrypoint", "sleep", IMAGE, "infinity",
  );
  const pid = docker("inspect", "-f", "{{.State.Pid}}", name).out;
  const log = join(work, `${name}.log`);
  const canary = spawn("sudo", ["-n", "nsenter", "-t", pid, "-n", "--", process.execPath, canaryJs, String(PORT), log], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    await sleep(1500);
    const src = profile === "production" ? "/opt/bloop/lo-registry.xcu" : `/ctl/${profile}.xcu`;
    const script = [
      `printf %s ${LINK_MARKER} > ${LINK_PATH}`,
      'P=$(mktemp -d); mkdir -p "$P/user" "$P/out"',
      `cp ${src} "$P/user/registrymodifications.xcu"`,
      `HOME="$P" timeout 120 soffice --headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P --convert-to pdf --outdir "$P/out" /fx/${fixture} >/dev/null 2>&1`,
      'f=$(ls "$P"/out/*.pdf 2>/dev/null | head -1)',
      'if [ -z "$f" ]; then echo "NOPDF"; else pdftotext "$f" - | tr "\\n" " " | head -c 100; echo; echo "images: $(pdfimages -list "$f" 2>/dev/null | tail -n +3 | wc -l)"; fi',
    ].join("\n");
    const r = docker("exec", name, "bash", "-c", script);
    await sleep(500);
    const hits = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    const text = r.out.replaceAll("\n", " | ");
    console.log(`${fixture.padEnd(24)} ${profile.padEnd(11)} connections=${hits} marker=${text.includes(LINK_MARKER)} :: ${text}`);
  } finally {
    canary.stdin.end("stop\n");
    docker("rm", "-f", name);
  }
}

// Positive control for the listener itself: connect from inside the namespace.
for (const fixture of FIXTURES) for (const profile of PROFILES) await trial(fixture, profile);
