import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Wrangler {
  /** Base URL, `http://127.0.0.1:<port>`; also the Worker's PUBLIC_ORIGIN. */
  url: string;
  /** Everything wrangler and the Worker wrote to stdout and stderr so far. */
  output(): string;
  stop(): Promise<void>;
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const bin = join(root, "node_modules", ".bin", "wrangler");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

/**
 * Starts `wrangler dev` on a free port with a throwaway state directory and resolves once
 * `/api/health` answers. Needs no Cloudflare login. `vars` override wrangler.jsonc vars.
 */
export async function startWrangler(vars: Record<string, string> = {}): Promise<Wrangler> {
  const [port, inspectorPort] = [await freePort(), await freePort()];
  const url = `http://127.0.0.1:${port}`;
  const state = mkdtempSync(join(tmpdir(), "bloop-wrangler-"));
  const varArgs = Object.entries({ PUBLIC_ORIGIN: url, ...vars }).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  const chunks: string[] = [];

  // Own process group, so stop() also takes down workerd. XDG_CONFIG_HOME keeps wrangler's logs and
  // registry out of the home directory, which a sandbox or CI runner may not allow it to write.
  const child = spawn(
    bin,
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      state,
      ...varArgs,
    ],
    {
      cwd: root,
      detached: true,
      env: { ...process.env, XDG_CONFIG_HOME: join(state, "config"), WRANGLER_SEND_METRICS: "false", CI: "1" },
    },
  );
  child.stdout.on("data", (d) => chunks.push(String(d)));
  child.stderr.on("data", (d) => chunks.push(String(d)));

  const stop = async () => {
    if (child.pid !== undefined && child.exitCode === null) {
      process.kill(-child.pid, "SIGTERM");
      await Promise.race([exited(child), sleep(5000)]);
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
    }
    rmSync(state, { recursive: true, force: true });
  };

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${chunks.join("")}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return { url, output: () => chunks.join(""), stop };
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  await stop();
  throw new Error(`wrangler dev not ready within 90 s:\n${chunks.join("")}`);
}
