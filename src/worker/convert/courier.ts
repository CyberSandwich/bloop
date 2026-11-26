// Calls to the container's job server: a timeout on every request, one retry for a GET (workerd#7597), and a body
// that is always consumed or handed on. Faults here are the attempt's, not the file's.
import { OUTPUT_CAPS } from "./contract.ts";
import { collect, type Piece, type PieceCtx, pieceGuard } from "./outputs.ts";
import type { ContainerPort } from "./port.ts";

/** The container or its transport failed; `code` is the retry code to fail the attempt with. */
export class ContainerFault extends Error {
  constructor(
    readonly code: "interrupted" | "store_failed" | "output_invalid" | "deadline",
    message: string,
  ) {
    super(message);
  }
}

export const SHORT_CALL_MS = 10_000;
export const FILE_CALL_MS = 60_000;

export interface CallInit {
  body?: RequestInit["body"];
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** A status, manifest or error body is small; a container that sends more is not trusted to stop. */
export const BODY_CAP = 2 * 1024 * 1024;

export class Courier {
  /** The run's deadline (ms): no call, however slow its container, outlives it. Null before the lease is taken. */
  limitAt: number | null = null;

  constructor(
    private readonly port: ContainerPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** True once the run's deadline has passed: a call cut off then ended the run, it did not fail the container. */
  pastDeadline(): boolean {
    return this.limitAt !== null && this.now() >= this.limitAt;
  }

  async call(method: "GET" | "PUT" | "POST", path: string, init: CallInit = {}): Promise<Response> {
    const left = this.limitAt === null ? Number.POSITIVE_INFINITY : this.limitAt - this.now();
    if (left <= 0) throw new ContainerFault("deadline", `${path}: past the deadline`);
    const timeoutMs = init.timeoutMs ?? SHORT_CALL_MS;
    let signal: AbortSignal | undefined;
    const once = () => {
      signal = AbortSignal.timeout(Math.min(timeoutMs, left));
      return this.port.fetch(path, {
        method,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.headers ? { headers: init.headers } : {}),
        signal,
      });
    };
    // The timer can fire a millisecond before `now` reaches limitAt: a timeout the deadline set is the deadline.
    const unreachable = (e: unknown) =>
      new ContainerFault(
        this.pastDeadline() || (left <= timeoutMs && signal?.aborted) ? "deadline" : "interrupted",
        `${path}: ${e instanceof Error ? e.message : "unreachable"}`,
      );
    try {
      return await once();
    } catch (e) {
      if (method !== "GET") throw unreachable(e);
      try {
        return await once();
      } catch (e2) {
        throw unreachable(e2);
      }
    }
  }

  /** Reads a small body (capped, so a pooled connection stays usable); an over-long or broken one reads as empty. */
  async drain(res: Response): Promise<string> {
    if (!res.body) return "";
    try {
      return new TextDecoder().decode(await collect(res.body, BODY_CAP));
    } catch {
      return "";
    }
  }

  async getJson(path: string): Promise<unknown> {
    const res = await this.call("GET", path);
    const text = await this.drain(res);
    if (!res.ok) throw new ContainerFault("interrupted", `${path}: ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new ContainerFault("interrupted", `${path}: not json`);
    }
  }

  /** One output file's body, through the guard that checks its size, hash and shape as it streams. */
  async pieceBody(path: string, piece: Piece, ctx: PieceCtx): Promise<ReadableStream<Uint8Array>> {
    const res = await this.call("GET", `/out/${path}`, { timeoutMs: FILE_CALL_MS });
    if (!res.ok || !res.body) {
      await this.drain(res);
      throw new ContainerFault("store_failed", `${path}: ${res.status}`);
    }
    return res.body.pipeThrough(pieceGuard(path, piece, ctx));
  }

  /** A small file (JSON), read whole. */
  async readPiece(path: string, piece: Piece, ctx: PieceCtx = {}): Promise<Uint8Array> {
    return collect(await this.pieceBody(path, piece, ctx), OUTPUT_CAPS.json);
  }
}
