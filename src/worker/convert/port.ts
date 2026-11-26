// The Converter's view of its container, so the alarm machine runs under Node over a fake. `realPort` is the only
// Workers-only code here. The image and the no-internet flag are fixed in one place (CONV-01); the instance is the
// job's (profile.ts `instanceFor`).
import type { InstanceName } from "./profile.ts";

export interface ContainerPort {
  /** Starts a fresh container and returns before it is ready; the caller polls /healthz. */
  start(env: Record<string, string>, instance: InstanceName): void;
  running(): boolean;
  destroy(): Promise<void>;
  setInactivity(ms: number): Promise<void>;
  /** One request to the job server on :8080. */
  fetch(path: string, init: RequestInit): Promise<Response>;
}

export const JOB_PORT = 8080;

/** Raised when the platform offers no container (a local `wrangler dev` without Docker). */
export class NoContainer extends Error {}

/** The slice of the platform's `ctx.container` used here, so Node-side tests and tsc need no Workers types. */
export interface ContainerApi {
  running: boolean;
  images: Record<string, string | undefined>;
  start(o: {
    image: string;
    instance: InstanceName;
    enableInternet: boolean;
    env: Record<string, string>;
    labels: Record<string, string>;
  }): void;
  destroy(): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
  getTcpPort(port: number): { fetch(url: string, init: RequestInit): Promise<Response> };
}

export function realPort(ctx: { container?: ContainerApi }): ContainerPort {
  const c = (): ContainerApi => {
    if (!ctx.container) throw new NoContainer("no container on this Durable Object");
    return ctx.container;
  };
  return {
    start(env, instance) {
      const container = c();
      const image = container.images.converter;
      if (!image) throw new NoContainer("no converter image configured");
      container.start({ image, instance, enableInternet: false, env, labels: { app: "bloop-converter" } });
    },
    running: () => ctx.container?.running ?? false,
    destroy: async () => {
      if (ctx.container?.running) await ctx.container.destroy();
    },
    setInactivity: (ms) => c().setInactivityTimeout(ms),
    fetch: (path, init) => c().getTcpPort(JOB_PORT).fetch(`http://container${path}`, init),
  };
}
