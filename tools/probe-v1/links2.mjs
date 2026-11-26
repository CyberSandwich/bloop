// Throwaway probe: a detector for link following that does not depend on LibreOffice rendering the
// result: strace of openat and connect in a control-only image, over many fixtures and profiles.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LINK_MARKER, LINK_PATH, linkedOdt } from "../../container/fixtures/lib.mjs";
import { GEN, docker, work } from "../../container/test/lib.mjs";

const IMG = "bloop-converter-strace:probe";
const PORT = 8099;
writeFileSync(join(GEN, "img-file.odt"), linkedOdt({ href: "file:///tmp/probe.png", image: true }));
writeFileSync(join(GEN, "img-http.odt"), linkedOdt({ href: `http://127.0.0.1:${PORT}/i.png`, image: true }));
writeFileSync(join(GEN, "sec-http.odt"), linkedOdt({ href: `http://127.0.0.1:${PORT}/m.txt` }));

const reg = (items) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${items}\n</oor:items>\n`;
const item = (path, name, value) =>
  `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`;
const ctl = join(work, "links2-ctl");
mkdirSync(ctl, { recursive: true });
for (const v of [0, 1, 2]) {
  writeFileSync(
    join(ctl, `relaxed-${v}.xcu`),
    reg(
      [
        item("/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", "false"),
        item("/org.openoffice.Office.Writer/Content/Update", "Link", v),
        item("/org.openoffice.Office.Calc/Content/Update", "Link", v),
      ].join("\n"),
    ),
  );
}

const b = docker("build", "-t", IMG, "-f", join(import.meta.dirname, "Dockerfile.strace"), join(import.meta.dirname));
console.log(`build strace image: ${b.code} ${b.err.slice(-200)}`);

const FIXTURES = [
  "linked.odt", "linked.docx", "linked.rtf", "img-file.odt", "img-http.odt", "sec-http.odt", "external.docx", "external.pptx",
];
for (const fixture of FIXTURES) {
  for (const profile of ["production", "relaxed-0", "relaxed-1", "relaxed-2"]) {
    const src = profile === "production" ? "/opt/bloop/lo-registry.xcu" : `/ctl/${profile}.xcu`;
    const script = [
      `printf %s ${LINK_MARKER} > ${LINK_PATH}`,
      "vips black /tmp/probe.png 20 20 >/dev/null 2>&1",
      'P=$(mktemp -d); mkdir -p "$P/user" "$P/out"',
      `cp ${src} "$P/user/registrymodifications.xcu"`,
      `HOME="$P" timeout 120 strace -f -qq -e trace=openat,connect,stat,newfstatat,access -o /tmp/st soffice --headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P --convert-to pdf --outdir "$P/out" /fx/${fixture} >/dev/null 2>&1`,
      'f=$(ls "$P"/out/*.pdf 2>/dev/null | head -1)',
      'echo "pdf=$([ -n "$f" ] && echo yes || echo no) images=$(pdfimages -list "$f" 2>/dev/null | tail -n +3 | wc -l)"',
      `echo "marker-touches=$(grep -c 'bloop-link-marker\\|probe.png' /tmp/st)"`,
      `echo "connects=$(grep -c 'connect(.*${PORT}' /tmp/st)"`,
      `grep 'bloop-link-marker\\|probe.png\\|${PORT}' /tmp/st | head -4`,
    ].join("\n");
    const r = docker(
      "run", "--rm", "--network", "none", "--read-only", "--cap-add", "SYS_PTRACE",
      "--tmpfs", "/tmp:rw,mode=1777,size=2g", "-v", `${GEN}:/fx:ro`, "-v", `${ctl}:/ctl:ro`,
      "--entrypoint", "bash", IMG, "-c", script,
    );
    console.log(`${fixture} ${profile}: ${r.out.replaceAll("\n", " | ")} ${r.err.slice(-150)}`);
  }
}
