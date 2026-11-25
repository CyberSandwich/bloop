// Pairing, the screen and phone views, items, WebSocket frames and the file list (docs/interfaces.md section 1).
import type { Actor, EndReason, ErrorCode, FileType, Kind, Mode, OpenMode } from "./core.ts";

/** Session states owned by the Screen object (section 2). */
export type SessionState =
  | "waiting"
  | "claimed"
  | "choosing"
  | "uploading"
  | "offered"
  | "approved"
  | "opening"
  | "open"
  | "ended"
  | "closed";

export interface RoomView {
  name: string | null; // null: an unregistered live room, which has no name
  registered: boolean;
}
export interface CodeView {
  code: string;
  expiresAt: number;
  qrUrl: string;
}

/** One approved file: what a page may show of it. No source id or URL (SRC-01). */
export interface FileItem {
  kind: "file";
  /** Server-assigned and opaque, unique in the session, fixed at approval; never derived from the source or an index. */
  id: string;
  name: string; // display name
  type: FileType; // an original PDF shown as a PDF is not a fallback
  size: number | null; // bytes, when the source gave a size
}
/** One approved web link: https on an allowed host only (LINK-01). The screen shows a card, never a frame. */
export interface LinkItem {
  kind: "link";
  id: string; // as on FileItem
  url: string;
  title: string;
}
export type Item = FileItem | LinkItem;

/** What the screen shows: `shown` in both views, and the body of the remote's two routes (`ShownCommand`). */
export interface Shown {
  item: string; // a file item's id; a link's only when the screen reports it
  page: number; // 1-based, within the item's pages
  present: boolean;
  // A video's play state; any other item ignores it. Absent (a sender from before them, or stored data): it plays, with
  // sound on. "blocked": the screen's browser refused sound until someone taps the screen; the screen reports it, and a
  // phone's command built on that view carries it on.
  play?: boolean | undefined;
  sound?: Sound | undefined;
}
export type Sound = "on" | "off" | "blocked";

/**
 * The body of `POST /api/control` (phone, pid) and `POST /api/screen/shown` (screen, sid). Absolute, so a replay
 * changes nothing. `seq` grows with each command from one sender (its clock in ms, at least one above its last), and a
 * command whose `seq` is not above the last one applied from that sender changes nothing. Every view carries that last
 * one as its own `seq`, so a sender whose clock fell behind (a reload) starts above it (PAIR-13).
 */
export interface ShownCommand extends Shown {
  seq: number;
}

export interface ScreenView {
  state: SessionState;
  mode: Mode;
  kind: Kind | null;
  room: RoomView;
  code: CodeView | null; // only in "waiting" and "ended"
  match: string | null; // 2 digits, from "claimed" to "open"
  /** From "offered" (guest) or "approved"; files by name, then links by title. A link or mint names an item by its index here. */
  items: Item[];
  /** Null until the remote or the screen's own tap sets it; null outside an approved session. */
  shown: Shown | null;
  openMode: OpenMode | null;
  endsAt: number | null;
  endReason: EndReason | null;
  /** The last `control` seq applied from this screen (0 before any). */
  seq: number;
  /** Applied changes so far: of two views, the one with the larger `v` is the newer; equal ones are one state. */
  v: number;
  now: number;
}

export interface PhoneView {
  state: SessionState;
  mode: Mode;
  kind: Kind;
  room: RoomView;
  match: string;
  items: Item[]; // as in ScreenView
  shown: Shown | null; // as in ScreenView
  openMode: OpenMode | null;
  /** Epoch ms the session ends by itself; with `now`, the phone's countdown. */
  endsAt: number | null;
  endReason: EndReason | null;
  /** The largest guest file this screen takes (GUEST_MAX_BYTES, or the demo cap). */
  dropMaxBytes: number;
  /** The mode's cap (SESSION_MAX_MINUTES or DEMO_MAX_MINUTES): the longest length the phone offers. */
  maxMinutes: number;
  /** The last `control` seq applied from this phone (0 before any). */
  seq: number;
  v: number; // as in ScreenView
  now: number;
}
/** `POST /api/session/length`: the session ends `minutes` from now, never past approval plus the mode's cap. */
export interface LengthRequest {
  minutes: number;
}

/** One mint fills one field: the link for the purpose asked, the others stay null. */
export interface LinkSet {
  protocol: string | null; // ms-powerpoint:ofv|u|<url>, pptx only
  download: string | null;
  pdf: string | null; // a PDF file's own view, or a deck's PDF rendition
  view: string | null; // an image, inline
}

// WebSocket frames, all {v: 1, t: ...}, at most 4 KB. The upgrade URL carries the non-secret screenRef
// (`/api/screen/ws?ref=<screenRef>`, `/api/pair/ws?ref=<screenRef>`): the first frame is the credential.
// The exact text {"v":1,"t":"ping"} is answered with {"v":1,"t":"pong"} by the runtime without waking the object.
export type ScreenMsgIn =
  | { v: 1; t: "hello"; sid: string }
  | { v: 1; t: "code.next" }
  | { v: 1; t: "open.click" } // the Open button on a guest offer
  | { v: 1; t: "launched"; mode: OpenMode }
  | { v: 1; t: "ping" };
export type ScreenMsgOut =
  | { v: 1; t: "state"; view: ScreenView }
  | { v: 1; t: "open"; item: number; links: LinkSet; now: number } // item: index into ScreenView.items
  | { v: 1; t: "error"; code: ErrorCode; now: number }
  | { v: 1; t: "pong" };
export type PhoneMsgIn = { v: 1; t: "hello"; pid: string } | { v: 1; t: "ping" };
export type PhoneMsgOut =
  | { v: 1; t: "state"; view: PhoneView }
  | { v: 1; t: "error"; code: ErrorCode; now: number }
  | { v: 1; t: "pong" };

export interface ClaimRequest {
  code: string;
  kind?: Kind; // defaults to "owner"; "guest" asks for the drop path
}
export interface ClaimResponse {
  pid: string;
  room: RoomView;
  match: string;
  mode: Mode;
  kind: Kind;
  needsAuth: boolean;
  dropMaxBytes: number;
}
/** A row of the phone's list (`GET /api/files` answers `{items: Entry[]}`); approve names entries by id. */
export interface FileEntry extends Omit<FileItem, "id"> {
  id: string; // the source's id (an entry id, not an item id); opaque to the phone; never a Graph URL
  modifiedAt: number;
}
export interface LinkEntry extends Omit<LinkItem, "id"> {
  id: string;
}
export type Entry = FileEntry | LinkEntry;
/** `POST /api/approve`: one to MAX_ITEMS distinct entry ids. */
export interface ApproveRequest {
  ids: string[];
}
/** `POST /api/screen/link`: item defaults to the one the approval launched (the first file). */
export interface LinkRequest {
  purpose: OpenMode;
  item?: number;
}
export interface LinkResponse {
  item: number;
  links: LinkSet;
}
