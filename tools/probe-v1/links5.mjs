// Throwaway: positive controls for the strace connect detector, and soffice handed an http URL with the network on.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GEN, docker, sleep, work } from "../../container/test/lib.mjs";

const IMG = "bloop-converter-strace:probe";
const b = docker("build", "-t", IMG, "-f", join(import.meta.dirname, "Dockerfile.strace"), join(import.meta.dirname));
console.log(`build: ${b.code}`);

const SO = 'HOME="$P" timeout 60 soffice --headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P --convert-to pdf --outdir "$P/out"';
const prep = 'P=$(mktemp -d); mkdir -p "$P/user" "$P/out"; cp /opt/bloop/lo-registry.xcu "$P/user/registrymodifications.xcu"';
const count = 'echo "connects=$(grep -c 8099 /tmp/st)"; grep 8099 /tmp/st | head -2; ls "$P/out"';
const run = (label, script, net) => {
  const r = docker(
    "run", "--rm", "--network", net, "--read-only", "--cap-add", "SYS_PTRACE",
    "--tmpfs", "/tmp:rw,mode=1777,size=1g", "-v", `${www}:/www:ro`, "--entrypoint", "bash", IMG, "-c", script,
  );
  console.log(`${label} [${net}]: ${r.out.replaceAll("\n", " | ")} ${r.err.slice(-120)}`);
};

const www = join(work, "www");
mkdirSync(www, { recursive: true });
copyFileSync(join(GEN, "linked.odt"), join(www, "x.odt"));
copyFileSync(join(GEN, "img-http.odt"), join(www, "img.odt"));

// 1. positive control for strace itself: bash connects to a closed loopback port.
run("bash /dev/tcp under strace", `${prep}\nstrace -f -qq -e trace=connect -o /tmp/st bash -c 'exec 3<>/dev/tcp/127.0.0.1/8099' 2>/dev/null; ${count}`, "none");
// 2. soffice handed an http URL, no listener.
run("soffice http URL, no listener", `${prep}\nstrace -f -qq -e trace=connect -o /tmp/st ${SO} http://127.0.0.1:8099/x.odt >/dev/null 2>&1; ${count}`, "none");

// 3. soffice handed an http URL, a real server on the host, host network.
const server = spawn("python3", ["-m", "http.server", "8099", "--bind", "127.0.0.1", "--directory", www], { stdio: "ignore" });
await sleep(1000);
run("soffice http URL, server up", `${prep}\nstrace -f -qq -e trace=connect -o /tmp/st ${SO} http://127.0.0.1:8099/x.odt >/dev/null 2>&1; ${count}`, "host");
run("soffice http URL to a doc that links an http picture, server up", `${prep}\nstrace -f -qq -e trace=connect -o /tmp/st ${SO} /www/img.odt >/dev/null 2>&1; ${count}`, "host");
server.kill();
