// Typed Durable Object stubs. Every namespace is used through the `eu` jurisdiction (architecture
// section 3), except under a local PUBLIC_ORIGIN: workerd does not implement jurisdictions, so
// `wrangler dev` and the integration tests run without one.
import { isLocalOrigin } from "./config.ts";
import type { Converter } from "./do/converter.ts";
import type { Directory } from "./do/directory.ts";
import type { Screen } from "./do/screen.ts";
import type { UserLibrary } from "./do/user-library.ts";
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

/** One Converter per file version: the id is the pair, so a version has at most one live job. */
export function converterStub(
  env: Pick<Env, "CONVERTER" | "PUBLIC_ORIGIN">,
  fileId: string,
  version: number,
): DurableObjectStub<Converter> {
  const ns = inJurisdiction(env.CONVERTER as DurableObjectNamespace<Converter>, env.PUBLIC_ORIGIN);
  return ns.get(ns.idFromName(`${fileId}:v${version}`));
}

export function userLibraryStub(
  env: Pick<Env, "USER_LIBRARY" | "PUBLIC_ORIGIN">,
  userId: string,
): DurableObjectStub<UserLibrary> {
  const ns = inJurisdiction(env.USER_LIBRARY as DurableObjectNamespace<UserLibrary>, env.PUBLIC_ORIGIN);
  return ns.get(ns.idFromName(userId));
}
