// Throwaway: does soffice in this image connect when it is handed an http URL, and does strace see it?
import { join } from "node:path";
import { docker } from "../../container/test/lib.mjs";

const IMG = "bloop-converter-strace:probe";
const b = docker("build", "-t", IMG, "-f", join(import.meta.dirname, "Dockerfile.strace"), join(import.meta.dirname));
console.log(`build: ${b.code}`);
const script = [
  'P=$(mktemp -d); mkdir -p "$P/user" "$P/out"',
  'cp /opt/bloop/lo-registry.xcu "$P/user/registrymodifications.xcu"',
  'HOME="$P" timeout 60 strace -f -qq -e trace=connect -o /tmp/st soffice --headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://$P --convert-to pdf --outdir "$P/out" http://127.0.0.1:8099/x.odt >/dev/null 2>&1',
  'echo "connects=$(grep -c "8099" /tmp/st)"; grep 8099 /tmp/st | head -3',
].join("\n");
const r = docker(
  "run", "--rm", "--network", "none", "--read-only", "--cap-add", "SYS_PTRACE",
  "--tmpfs", "/tmp:rw,mode=1777,size=1g", "--entrypoint", "bash", IMG, "-c", script,
);
console.log(r.out, r.err.slice(-200));
