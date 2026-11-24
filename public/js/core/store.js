// sessionStorage that never throws: storage can be blocked, and a page then runs on memory alone.
export const SID_KEY = "bloop.sid";
export const PID_KEY = "bloop.pid";

/** A sid and a pid are both `<screenRef>.<secret>`; the ref routes a socket and is no secret. */
export const refOf = (/** @type {string} */ credential) => credential.split(".")[0] ?? "";

/** The sid this tab holds and the pid it just took name the same screen: the claim came from this tab's own screen. */
export const sameScreen = (/** @type {string | null} */ sid, /** @type {string | null} */ pid) =>
  sid !== null && pid !== null && refOf(sid) === refOf(pid);

/**
 * @param {Pick<Storage, "getItem" | "setItem" | "removeItem"> | null} [area]
 */
export function createStore(area = null) {
  /** @type {Map<string, string>} */
  const memory = new Map();
  return {
    /** @param {string} key @returns {string | null} */
    get(key) {
      try {
        return area?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    /** @param {string} key @param {string} value */
    set(key, value) {
      memory.set(key, value);
      try {
        area?.setItem(key, value);
      } catch {
        // memory copy above is the fallback
      }
    },
    /** @param {string} key */
    remove(key) {
      memory.delete(key);
      try {
        area?.removeItem(key);
      } catch {
        // nothing stored to remove
      }
    },
  };
}

/** Drops the pid only when it is `expected`, so another tab's newer pairing stays. */
export function dropPid(/** @type {ReturnType<typeof createStore>} */ store, /** @type {string | null} */ expected) {
  if (expected !== null && store.get(PID_KEY) === expected) store.remove(PID_KEY);
}

/** The page's store, over sessionStorage when the browser allows touching it. */
export function sessionStore() {
  try {
    return createStore(globalThis.sessionStorage);
  } catch {
    return createStore(null);
  }
}

/**
 * The phone's pairing store, over localStorage: a closed tab can come back to Revoke. The pid is a bearer secret for
 * one pairing; a tab drops it (dropPid) on every end it sees, cancel and every refusal; it dies with the session.
 */
export function pidStore() {
  try {
    return createStore(globalThis.localStorage);
  } catch {
    return createStore(null);
  }
}
