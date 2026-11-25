// Typed Durable Object stubs. Every namespace is used through the `eu` jurisdiction (architecture
// section 3), except under a local PUBLIC_ORIGIN: workerd does not implement jurisdictions, so
// `wrangler dev` and the integration tests run without one.
import { isLocalOrigin } from "./config.ts";
import type { Directory } from "./do/directory.ts";
import type { Screen } from "./do/screen.ts";
import type { Env } from "./env.ts";

function inJurisdiction<T extends Rpc.DurableObjectBranded | undefined>(
  ns: DurableObjectNamespace<T>,
  origin: string,
): DurableObjectNamespace<T> {
  return isLocalOrigin(origin) ? ns : ns.jurisdiction("eu");
}

export function screenStub(env: Pick<Env, "SCREEN" | "PUBLIC_ORIGIN">, screenRef: string): DurableObjectStub<Screen> {
  const ns = inJurisdiction(env.SCREEN as DurableObjectNamespace<Screen>, env.PUBLIC_ORIGIN);
  return ns.get(ns.idFromName(screenRef));
}

export function directoryStub(env: Pick<Env, "DIRECTORY" | "PUBLIC_ORIGIN">): DurableObjectStub<Directory> {
  const ns = inJurisdiction(env.DIRECTORY as DurableObjectNamespace<Directory>, env.PUBLIC_ORIGIN);
  return ns.get(ns.idFromName("directory"));
}
