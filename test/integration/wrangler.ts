import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Wrangler {
  /** Base URL, `http://localhost:<port>`; also the Worker's PUBLIC_ORIGIN. */
  url: string;
  /** Everything wrangler and the Worker wrote to stdout and stderr so far. */
  output(): string;
  /** Resolves once `output()` holds `text` (wrangler relays the Worker's log lines late), or after `ms`. */
  logged(text: string, ms?: number): Promise<void>;
  stop(): Promise<void>;
  /** A read-only query against the throwaway local D1 (migrated only with `migrate: true`). */
  d1(sql: string): Record<string, unknown>[];
  /** Writes the launch mode (and the preview lockout) the next request sees. Needs TEST_TIMING=1, which turns the Worker's 30 s cache off. */
  setLaunchMode(mode: "preview" | "open", lockout?: boolean): void;
  /** Whether a local R2 bucket (the guest bucket unless named) holds an object under `key`. */
  r2Has(key: string, bucket?: string): boolean;
  /** Writes an object into a local R2 bucket, for a test that needs bytes the Worker would otherwise get from an upload. */
  r2Put(bucket: string, key: string, content: string): void;
}

/**
 * What every test server runs with unless a test overrides it: mail kept in memory, uploads through the Worker (no R2
 * network endpoint), conversion stubbed (no container), and no file-origin host unless a test names one.
 */
const HARNESS_VARS = { DEV_MAILBOX: "1", UPLOAD_MODE: "proxy", CONVERT_MODE: "stub", FILE_ORIGIN: "" };

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
  try {
    return await startOnce(vars, options);
  } catch (e) {
    // The serving port is picked before wrangler binds it (PUBLIC_ORIGIN must name it), so another socket can take
    // it in between; a fresh port and state once is enough.
    if (!(e instanceof PortTaken)) throw e;
    return startOnce(vars, options);
  }
}

class PortTaken extends Error {}

/** Signals the whole process group; ESRCH (already gone) is fine. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group has exited
  }
}

async function startOnce(vars: Record<string, string>, options: { migrate?: boolean }): Promise<Wrangler> {
  const port = await freePort();
  // localhost, not 127.0.0.1: WebAuthn refuses an IP address as its relying party. wrangler still binds 127.0.0.1.
  const url = `http://localhost:${port}`;
  const state = mkdtempSync(join(tmpdir(), "bloop-wrangler-"));
  const varArgs = Object.entries({ ...HARNESS_VARS, PUBLIC_ORIGIN: url, ...vars }).flatMap(([k, v]) => [
    "--var",
    `${k}:${v}`,
  ]);
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
      // No Docker in the harness: the converter container is replaced by CONVERT_MODE=stub.
      "--enable-containers=false",
      // Without it the Worker sees the custom domain as its host, not the local address.
      "--infer-origin-from-routes=false",
      // Serves /cdn-cgi/handler/scheduled, so a test can run a cron handler.
      "--test-scheduled",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      // 0: the OS assigns it at bind. A port picked here first could be taken by one of wrangler's own sockets
      // before its inspector proxy binds it ("Address already in use (socket direct:1:default)").
      "--inspector-port",
      "0",
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
    // The group, even when wrangler itself has exited: its workerd children may still hold ports.
    if (child.pid !== undefined) {
      killGroup(child.pid, "SIGTERM");
      await Promise.race([exited(child), sleep(5000)]);
      killGroup(child.pid, "SIGKILL");
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
  const r2Has = (key: string, bucket = "bloop-guest-files"): boolean => {
    const out = join(state, "r2-probe");
    const done = spawnSync(
      bin,
      ["r2", "object", "get", `${bucket}/${key}`, "--local", "--persist-to", state, "--file", out],
      { cwd: root, env, encoding: "utf8" },
    );
    return done.status === 0;
  };
  const r2Put = (bucket: string, key: string, content: string): void => {
    const source = join(state, "r2-source");
    writeFileSync(source, content);
    const done = spawnSync(
      bin,
      ["r2", "object", "put", `${bucket}/${key}`, "--local", "--persist-to", state, "--file", source],
      { cwd: root, env, encoding: "utf8" },
    );
    if (done.status !== 0) throw new Error(`r2 put failed:\n${done.stdout}${done.stderr}`);
  };

  const setLaunchMode = (mode: "preview" | "open", lockout = false) => {
    if (vars.TEST_TIMING !== "1")
      throw new Error("setLaunchMode needs TEST_TIMING=1: the Worker caches the mode for 30 s");
    d1(`INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES ('launch_mode', '${mode}', 0)`);
    d1("DELETE FROM setting WHERE key = 'preview_lockout'");
    if (lockout) d1("INSERT INTO setting (key, value, updated_at) VALUES ('preview_lockout', '1', 0)");
  };
  const output = () => chunks.join("");
  const logged = async (text: string, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end && !output().includes(text); ) await sleep(100);
  };

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // The tail holds the cause; CI annotations cut a long message after the bindings table.
    if (child.exitCode !== null) {
      await stop();
      const all = chunks.join("");
      const Failure = all.includes("Address already in use") ? PortTaken : Error;
      throw new Failure(`wrangler dev exited early (code ${child.exitCode}):\n${all.slice(-1500)}`);
    }
    try {
      if ((await fetch(`${url}/api/health`)).ok) return { url, output, logged, stop, d1, setLaunchMode, r2Has, r2Put };
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  await stop();
  throw new Error(`wrangler dev not ready within 90 s:\n${chunks.join("")}`);
}
