// Helpers for the open-path tests: an approved demo session, and /f/ requests that never follow a redirect.
import { DEMO_ITEMS } from "../../src/shared/demo-catalog.ts";
import { type Api, claim, openScreen, type Screen, type Socket } from "./pairing-client.ts";

export interface Links {
  protocol: string | null;
  download: string | null;
  pdf: string | null;
  view: string | null;
}

export interface Approved {
  screen: Screen;
  socket: Socket;
  pid: string;
  /** The https link inside the `ms-powerpoint:ofv|u|` URI the screen received. */
  url: string;
  links: Links;
}

export const PROTOCOL_PREFIX = "ms-powerpoint:ofv|u|";

/** Pairs a demo screen and phone, approves `ids`, and waits for the first `open` frame. */
export async function approveDemo(api: Api, ids: string[] = [DEMO_ITEMS.deck.id]): Promise<Approved> {
  const { screen, socket, code } = await openScreen(api, "demo");
  const claimed = await claim(api, code);
  const pid = claimed.body.pid;
  await api.get("/api/files", pid);
  const approved = await api.post("/api/approve", { ids }, { auth: pid });
  if (approved.status !== 200) throw new Error(`approve failed: ${approved.status}`);
  const frame = await socket.waitFor((f) => f.t === "open");
  const links = frame.links as Links;
  const url = (links.protocol ?? links.pdf ?? "").replace(PROTOCOL_PREFIX, "");
  return { screen, socket, pid, url, links };
}

/** A fetch that reports a redirect instead of following it. */
export const fetchLink = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", ...init });

export const problemOf = async (res: Response) => (await res.json()) as { status: number; code: string };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until at least `needMs` remain in the current rate-limit window. Local bindings count in windows aligned to
 * the wall clock, so a burst that straddles a boundary gets two budgets and passes a limit it should hit.
 */
export async function inOneWindow(periodSeconds = 60, needMs = 10_000): Promise<void> {
  const left = periodSeconds * 1000 - (Date.now() % (periodSeconds * 1000));
  if (left < needMs) await sleep(left + 50);
}
