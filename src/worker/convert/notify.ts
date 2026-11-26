// Progress to whoever is watching: the user's library page or the guest's screen. Best effort and never fatal: the D1
// row is the truth on reconnect. Each event is an upsert keyed by (fileId, version); an older version is ignored by the
// receiver and a terminal state is never overwritten (docs/conversion.md).

import type { Target } from "../do/converter-schema.ts";

export type EndState = "done" | "failed" | "cancelled" | "skipped";

export interface Notifier {
  progress(
    t: Target,
    fileId: string,
    version: number,
    stage: string,
    done: number | null,
    total: number | null,
  ): Promise<void>;
  /** Page 1 is stored: the library can show the first slide while the rest packs. */
  pageReady(t: Target, fileId: string, version: number): Promise<void>;
  terminal(t: Target, fileId: string, version: number, state: EndState, code: string | null): Promise<void>;
}

type Rpc = Record<string, (...args: unknown[]) => Promise<unknown>>;

let missingLogged = false;

/** Calls `method` on the receiver; a missing method or an unreachable object is logged once and swallowed. */
async function send(stub: unknown, method: string, args: unknown[], log: (line: string) => void): Promise<void> {
  try {
    await (stub as Rpc)[method]?.(...args);
  } catch (e) {
    if (missingLogged) return;
    missingLogged = true;
    log(JSON.stringify({ evt: "convert_notify_missing", method, error: e instanceof Error ? e.message : "unknown" }));
  }
}

/**
 * Tells a library's UserLibrary: `progress(id, version, stage, done, total)`, `pageReady(id)`, then `derivedReady(id,
 * version)` or `derivedFailed(id, version, code)`. A cancelled run says nothing (the trash or purge that cancelled it
 * already told the page). A guest's screen reads the row; it has no push method to call.
 * `library` resolves a user's stub; the Workers wiring is do/converter.ts.
 */
export function notifierFor(
  library: (userId: string) => unknown,
  log: (line: string) => void = console.error,
): Notifier {
  return {
    progress: (t, fileId, version, stage, done, total) =>
      t.kind === "library"
        ? send(library(t.userId), "progress", [fileId, version, stage, done ?? 0, total ?? 0], log)
        : Promise.resolve(),
    pageReady: (t, fileId) =>
      t.kind === "library" ? send(library(t.userId), "pageReady", [fileId], log) : Promise.resolve(),
    terminal: (t, fileId, version, state, code) => {
      if (t.kind !== "library" || state === "cancelled") return Promise.resolve();
      return state === "done"
        ? send(library(t.userId), "derivedReady", [fileId, version], log)
        : send(library(t.userId), "derivedFailed", [fileId, version, code ?? state], log);
    },
  };
}

/** A notifier that does nothing, for callers with no one to tell. */
export const silentNotifier: Notifier = {
  progress: async () => undefined,
  pageReady: async () => undefined,
  terminal: async () => undefined,
};
