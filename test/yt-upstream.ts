// A local stand-in for i.ytimg.com: the thumbnail route's upstream in the integration and browser tests (YT_THUMB_ORIGIN),
// so no test reaches the real network. Run by node directly (`node test/yt-upstream.ts <port>`, which Playwright's web
// server does) or started from a test with `startUpstream`. Erasable TypeScript only, since node strips the types.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export type UpstreamMode = "ok" | "redirect" | "status" | "png" | "html" | "big" | "bad-magic" | "no-type" | "hang";

export interface Hit {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The fixed picture every good answer carries. */
export const THUMB_FIXTURE = readFileSync(fileURLToPath(new URL("./fixtures/media/yt-thumb.jpg", import.meta.url)));

export interface Upstream {
  /** The origin to give the Worker as YT_THUMB_ORIGIN. */
  origin: string;
  /** Every request received, oldest first. */
  hits: Hit[];
  /** How the next requests are answered. */
  mode: UpstreamMode;
  stop(): Promise<void>;
}

export function startUpstream(port = 0): Promise<Upstream> {
  const hits: Hit[] = [];
  const state = { mode: "ok" as UpstreamMode };
  const server = createServer((req, res) => {
    hits.push({ url: req.url ?? "", headers: { ...req.headers } });
    const send = (
      status: number,
      type: string | null,
      body: Uint8Array | string,
      extra: Record<string, string> = {},
    ) => {
      res.writeHead(status, { ...(type ? { "Content-Type": type } : {}), ...extra });
      res.end(body);
    };
    switch (state.mode) {
      case "ok":
        return send(200, "image/jpeg", THUMB_FIXTURE);
      case "redirect":
        return send(302, null, "", { Location: "https://evil.example/x.jpg" });
      case "status":
        return send(503, "text/plain", "down");
      case "png":
        return send(200, "image/png", THUMB_FIXTURE);
      case "html":
        return send(200, "text/html", "<html></html>");
      case "no-type":
        return send(200, null, THUMB_FIXTURE);
      case "bad-magic":
        return send(200, "image/jpeg", "this is not a jpeg at all");
      case "big":
        return send(200, "image/jpeg", Buffer.concat([THUMB_FIXTURE, Buffer.alloc(300_000)]));
      case "hang":
        return; // never answers: the Worker's own timeout ends it
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        origin,
        hits,
        get mode() {
          return state.mode;
        },
        set mode(mode: UpstreamMode) {
          state.mode = mode;
        },
        stop: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const up = await startUpstream(Number(process.argv[2] ?? 8788));
  console.log(`yt upstream on ${up.origin}`);
}
