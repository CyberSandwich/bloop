// CONV-03 macro cases: each fixture must convert without its macro running, and a control with macro
// security off must fire it, or the silence proves nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { injectVba } from "../fixtures/inject-vba.mjs";
import { check, docker, GEN, healthy, IMAGE, runJob, start, stop, uniq, work } from "./lib.mjs";

const SENTINEL = "/tmp/bloop-macro-ran";

export function macroSideEffect(c) {
  return docker("exec", c.name, "test", "-e", SENTINEL).code === 0;
}

export async function caseMacro(file, ext) {
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
export function macroRun(file, mode, profile) {
  const dir = join(work, `control-${uniq()}`);
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
export function macroProof(file, { mustFire = true } = {}) {
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

export const LEGACY = [
  ["macro.odt", "doc", "MS Word 97"],
  ["macro.ods", "xls", "MS Excel 97"],
  ["macro.odp", "ppt", "MS PowerPoint 97"],
];

/** Converts the ODF macro fixtures to the legacy binary formats; returns the files that carry a VBA storage. */
export function makeLegacyMacros() {
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
