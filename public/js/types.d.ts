// Type-only shapes of the browser modules, imported by JSDoc `@import ... from "./types.js"`. Never served
// (`public/.assetsignore`): the pages ship unminified, so types kept here cost none of the browser JS budget.
import type {
  Entry,
  ErrorCode,
  LinkSet,
  OpenMode,
  PhoneStateKey,
  PhoneView,
  ScreenView,
} from "../../src/shared/protocol.ts";
import type { Api } from "./core/api.js";
import type { openChannel } from "./core/channel.js";

type Channel = ReturnType<typeof openChannel>;

/** The screen page's own state (screen.js). */
export interface ScreenPage {
  view: ScreenView | null;
  /** Server clock minus this clock. */
  skew: number;
  link: "ok" | "offline" | "down";
  errored: boolean;
  limited: boolean;
  sid: string | null;
  channel: Channel | null;
  /** The code the QR shows. */
  shown: string | null;
  /** The scene the shared enter motion last ran for. */
  scene: string | null;
  timers: Record<string, ReturnType<typeof setTimeout> | undefined>;
}

/** A resumed or created screen, or why there is none. */
export type Booted = { ok: true; sid: string; view: ScreenView } | { ok: false; error: string };

/** The phone page's own state (phone.js): the PhoneCtx it maps to a key, and what only the page needs. */
export interface PhonePage extends PhoneCtx {
  canceling: boolean;
  pid: string | null;
  channel: Channel | null;
  retry: (() => void) | null;
  key: PhoneStateKey | null;
  /** What the list was last built as, and from which array. */
  rows: string;
  source: unknown;
  actionIds: string;
  account: boolean;
  skew: number;
  file: File | null;
  maxBytes: number;
  upload: { abort: () => void } | null;
  /** The share sent, 0 to 1; null while the file is prepared or the total is unknown. */
  progress: number | null;
  /** Back or Done is on its way out: a second tap does nothing. */
  leaving: boolean;
  /** The last failure's code, for the support mail. */
  fault: ErrorCode | null;
}

/** The slice of WebSocket core/channel.js uses, so tests can fake it. */
export interface SocketLike {
  send: (data: string) => void;
  close: () => void;
  // biome-ignore lint/suspicious/noExplicitAny: browser event shapes differ per socket implementation
  onopen: ((e: any) => void) | null;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  onmessage: ((e: any) => void) | null;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  onclose: ((e: any) => void) | null;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  onerror: ((e: any) => void) | null;
}

export interface ChannelOptions {
  /** Full ws(s) URL, carrying only the non-secret ref. */
  url: string;
  /** Polling route. */
  statePath: string;
  /** Sid or pid. */
  credential: string;
  helloKey: "sid" | "pid";
  api: Api;
  connect: (url: string) => SocketLike;
  // biome-ignore lint/suspicious/noExplicitAny: a ScreenView or a PhoneView, by the page
  onView: (view: any) => void;
  /** A pushed error frame, or a fatal poll error. */
  // biome-ignore lint/suspicious/noExplicitAny: as above
  onError: (code: ErrorCode, view?: any) => void;
  /** `open` and any other frame the page handles. */
  // biome-ignore lint/suspicious/noExplicitAny: frames are checked by the page that takes them
  onFrame?: (frame: any) => void;
  onLink: (link: "ok" | "offline" | "down") => void;
}

export type SendResult = { ok: true; view: PhoneView } | { ok: false; error: ErrorCode };

/** The slice of XMLHttpRequest core/drop.js uses, so tests can fake it (the Node config has no DOM types). */
export interface Xhr {
  open: (method: string, url: string) => void;
  setRequestHeader: (name: string, value: string) => void;
  send: (body: unknown) => void;
  abort: () => void;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  status: number;
  responseText: string;
}

/** `spent`: the mint limit, which the page shows by hiding the controls. */
export type Minted = "ok" | "spent" | "failed";

/** Every browser effect of the launch ladder (launcher.js), injected so it runs under test without a browser. */
export interface LauncherDeps {
  api: Api;
  /** The screen credential. */
  sid: () => string | null;
  /** Navigate to a protocol URI. */
  assign: (url: string) => void;
  /** Open the PDF or image (`view`) view of item `item`; null or undefined when a popup blocker refused. */
  openWindow: (url: string, item: number, mode: OpenMode) => unknown;
  startDownload: (url: string) => void;
  /** The page has transient user activation right now. */
  hasGesture: () => boolean;
  /** Tell the server which launch this was; false when it could not be sent. */
  report: (mode: OpenMode) => boolean;
  /** State the page renders from changed. */
  onChange: () => void;
}

export interface ScreenLauncher {
  /** Act on a pushed or fetched link set for item `item` (-1 or none: the first file). */
  launch: (links: LinkSet, item?: number) => void;
  /** The Open control: relaunch, or open a blocked PDF, under a user gesture. */
  click: () => void;
  /** Start the recent download link of that item again, or mint one and start it; no item means the first file. */
  download: (item?: number) => Promise<Minted>;
  /** Mint the PDF link and open it. */
  showPdf: () => Promise<Minted>;
  /** Mint the launch link of another item (an image's view link). */
  relink: (item: number) => Promise<Minted>;
  /** That item's mint budget ran out (`mint_limit`), so no fallback for it can be minted; no item means the first file. */
  spent: (item?: number) => boolean;
  /** Follow the session: recover a lost link, time the launch, reset at the end. */
  onView: (view: ScreenView) => void;
  /** A click is needed to open (no gesture at launch, or a blocked popup). */
  needsClick: () => boolean;
  /** What this PC may still hold: PowerPoint was launched, the name of a download it started. Read before an end resets it. */
  left: () => { ppt: boolean; download: string | null };
  /** The launch has waited long enough that Download may show. */
  downloadReady: () => boolean;
  /** Close the PDF window this page opened. */
  closePdf: () => void;
  /** Drop every link and timer (the residue step). */
  reset: () => void;
}

/**
 * `start_over` is the back arrow, `end` the End pill and the bloop mark (end, then home), `here` the demo's
 * "Approve on This Device" pill.
 */
export type ScreenControl = "start_over" | "end" | "open" | "download" | "pdf" | "here" | "continue" | "waitlist";

export interface ScreenCopy {
  heading: string;
  line: string;
  controls: ScreenControl[];
  /** Announce assertively. */
  alert: boolean;
}

export interface ScreenFacts {
  room: string;
  /** The 2 match digits, from a claim to open. */
  match?: string | null;
  /** The item on the stage, or the first file. */
  file: string | null;
  /** Local time, "11:35". */
  endsAt: string | null;
  guest: boolean;
  /** A demo screen (`/s?mode=demo`). */
  demo?: boolean;
  /** How the screen opened the file; only `protocol` is a PowerPoint launch. */
  openMode?: OpenMode | null;
  /** This browser holds the claim too (the pid in localStorage names this screen). */
  mine?: boolean;
  /** The launch needs a click (no user gesture). */
  click?: boolean;
  /** The line under Session Ended (endLine in copy-screen.js). */
  endLine?: string;
  /** A session is running (approved to open). */
  inSession?: boolean;
}

export interface PhoneAction {
  id: string;
  label: string;
  kind: "primary" | "secondary" | "text" | "rose";
  href?: string | undefined;
  /** The accessible name, when the label alone is not enough (the match digits). */
  aria?: string;
}

export interface PhoneCopy {
  title: string;
  body: string;
  /** The "Registered room" line under a room title. */
  room: boolean;
  /** The list to tick, the approved items read only, or the one file on its way over the loader. */
  files: "none" | "skeleton" | "list" | "items" | "upload";
  /** The "Add a file" row closes the list: the guest path, for a file not in it `[V-10]`. */
  add: boolean;
  /** The "Ends in 59:12" countdown `[V-2]`. */
  ends: boolean;
  /** The scope line under the list. */
  scope: string;
  /** The unregistered-screen card. */
  warn: string;
  actions: PhoneAction[];
  /** The primary action shows its progress label. */
  loading: boolean;
}

export interface PhoneFacts {
  room: string;
  file: string | null;
  /** The phone is signed in to OneDrive, so it can disconnect. */
  account?: boolean;
  /** A demo room, which needs no account line. */
  demo?: boolean;
  /** The largest guest file, in whole megabytes. */
  maxMB?: number;
  /** This tab is also the demo screen (the one-device round trip), so it can go back to it. */
  back?: boolean;
  /** The 2 match digits the screen shows, carried on the button that commits. */
  match?: string | null;
  /** /a opened with no code and no pairing. */
  nocode?: boolean;
  /** An approved session is up: a failure keeps Revoke. */
  live?: boolean;
  /** The failure was Revoke's own, so Revoke alone retries it. */
  revoking?: boolean;
  /** The guest offer came from the list (Add a File), so Cancel goes back to it. */
  list?: boolean;
}

export interface ScreenCtx {
  view: ScreenView | null;
  link: "ok" | "offline" | "down";
  /** An action or a pushed error failed; clears after a pause. */
  errored: boolean;
  /** Creating the screen was refused with `rate_limited` (the demo caps, DEMO-02); the page retries. */
  limited?: boolean;
}

/** What the claim or a resumed view says about the room. */
export interface PhoneInfo {
  roomName: string | null;
  registered: boolean;
  match: string;
  mode: "live" | "demo";
  kind: "owner" | "guest";
}

export interface PhoneCtx {
  /** A failure to show in place of the flow. */
  error: PhoneStateKey | null;
  /** Null while the claim is in flight. */
  info: PhoneInfo | null;
  /** The latest pushed or fetched view. */
  view: PhoneView | null;
  /** The list to choose from, files then links; null while loading. */
  files: Entry[] | null;
  /** The ids selected, in list order. */
  selected: string[];
  /** The approve call is in flight. */
  approving: boolean;
  /** This phone canceled the pairing. */
  canceled: boolean;
  /** Where the guest flow is, which only this phone knows. */
  drop: "confirm" | "sending" | null;
}

/** A child of a 24 px glyph: a bare path's `d`, or a tag with its attributes (core/icons.js). */
export type IconPart = string | [string, Record<string, string>];
