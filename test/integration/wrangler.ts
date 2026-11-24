import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
  /** A read-only query against the throwaway local D1 (migrated only with `migrate: true`). */
  d1(sql: string): Record<string, unknown>[];
  /** Whether the local R2 bucket holds an object under `key`. */
  r2Has(key: string): boolean;
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
 * `migrate` applies migrations/ to the throwaway D1 first, for tests that touch the database.
 */
export async function startWrangler(
  vars: Record<string, string> = {},
  options: { migrate?: boolean } = {},
): Promise<Wrangler> {
  const [port, inspectorPort] = [await freePort(), await freePort()];
  const url = `http://127.0.0.1:${port}`;
  const state = mkdtempSync(join(tmpdir(), "bloop-wrangler-"));
  const varArgs = Object.entries({ PUBLIC_ORIGIN: url, ...vars }).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  const chunks: string[] = [];
  const env = { ...process.env, XDG_CONFIG_HOME: join(state, "config"), WRANGLER_SEND_METRICS: "false", CI: "1" };

  if (options.migrate) {
    const done = spawnSync(bin, ["d1", "migrations", "apply", "bloop", "--local", "--persist-to", state], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    if (done.status !== 0) throw new Error(`d1 migrations failed:\n${done.stdout}${done.stderr}`);
  }

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
      env,
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

  // Reads the throwaway state the running Worker writes, through wrangler's own local commands.
  const d1 = (sql: string): Record<string, unknown>[] => {
    const done = spawnSync(
      bin,
      ["d1", "execute", "bloop", "--local", "--persist-to", state, "--json", "--command", sql],
      { cwd: root, env, encoding: "utf8" },
    );
    if (done.status !== 0) throw new Error(`d1 execute failed:\n${done.stdout}${done.stderr}`);
    return (JSON.parse(done.stdout) as { results: Record<string, unknown>[] }[])[0]?.results ?? [];
  };
  const r2Has = (key: string): boolean => {
    const out = join(state, "r2-probe");
    const done = spawnSync(
      bin,
      ["r2", "object", "get", `bloop-guest-files/${key}`, "--local", "--persist-to", state, "--file", out],
      { cwd: root, env, encoding: "utf8" },
    );
    return done.status === 0;
  };

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // The tail holds the cause; CI annotations cut a long message after the bindings table.
    if (child.exitCode !== null)
      throw new Error(`wrangler dev exited early (code ${child.exitCode}):\n${chunks.join("").slice(-1500)}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return { url, output: () => chunks.join(""), stop, d1, r2Has };
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  await stop();
  throw new Error(`wrangler dev not ready within 90 s:\n${chunks.join("")}`);
}
