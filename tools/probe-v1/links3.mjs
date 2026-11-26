// Throwaway: does this LibreOffice build have an http content provider at all?
import { GEN, IMAGE, docker } from "../../container/test/lib.mjs";

const r = docker(
  "run", "--rm", "--entrypoint", "bash", IMAGE, "-c",
  "soffice --version; ls /usr/lib/libreoffice/program | grep -i 'ucp\\|curl\\|dav\\|neon\\|serf' ; dpkg -l | awk '{print $2}' | grep -i 'libreoffice-\\|curl' | tr '\\n' ' '",
);
console.log(r.out, r.err, GEN);
