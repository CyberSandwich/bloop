// A complete set of container outputs, tiny and structurally valid, for CONVERT_MODE=stub and for tests: the bytes
// satisfy the Worker's checks (types, sizes, hashes, widths) without a decodable image. Pure: no Workers types.
import { isDocument, KIND_BY_EXT, type Manifest } from "./contract.ts";
import { sha256Hex } from "./outputs.ts";
import type { Profile } from "./profile.ts";

export interface StubOptions {
  /** Pages the "document" has; the stub renders min(pages, profile.maxPages). */
  pages: number;
  /** Page numbers that get a note. */
  notes?: readonly number[];
  motion?: boolean;
  fontsMissing?: readonly string[];
  /** Slide shape, widest rendition. */
  size?: { w: number; h: number };
}

export interface StubOutputs {
  files: Map<string, Uint8Array>;
  manifest: Manifest;
}

const enc = new TextEncoder();

/** A lossless WebP container whose header says w by h; `salt` makes pieces differ. */
export function stubWebp(w: number, h: number, salt = 0): Uint8Array {
  const out = new Uint8Array(40);
  const dv = new DataView(out.buffer);
  out.set(enc.encode("RIFF"), 0);
  dv.setUint32(4, out.length - 8, true);
  out.set(enc.encode("WEBPVP8L"), 8);
  dv.setUint32(16, 20, true);
  out[20] = 0x2f;
  dv.setUint32(21, (w - 1) | ((h - 1) << 14), true);
  dv.setUint32(25, salt, true);
  return out;
}

export function stubJpeg(w: number, h: number): Uint8Array {
  const out = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
  ]);
  return out;
}

export const stubPdf = (pages: number): Uint8Array => enc.encode(`%PDF-1.7\n% stub, ${pages} pages\n%%EOF\n`);

export function stubMp4(): Uint8Array {
  return new Uint8Array([
    ...[
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73,
      0x6f, 0x32,
    ],
    ...[0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74],
  ]);
}

const json = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));

const TYPES: Record<string, string> = {
  webp: "image/webp",
  pdf: "application/pdf",
  json: "application/json",
  mp4: "video/mp4",
  jpg: "image/jpeg",
};

export async function buildStubOutputs(
  jobId: string,
  ext: string,
  profile: Profile,
  originalSha: string,
  opts: StubOptions,
): Promise<StubOutputs> {
  const kind = KIND_BY_EXT[ext as keyof typeof KIND_BY_EXT];
  const files = new Map<string, Uint8Array>();
  const { w: W, h: H } = opts.size ?? {
    w: profile.widths[0] ?? 1920,
    h: Math.round(((profile.widths[0] ?? 1920) * 9) / 16),
  };
  const rendered = isDocument(kind) ? Math.min(opts.pages, profile.maxPages) : 0;
  let groups: Manifest["groups"];
  if (kind === "video") {
    files.set("m/0.mp4", stubMp4());
    files.set("t.webp", stubWebp(480, 270));
    files.set("meta.json", json({ v: 1, sha256: originalSha, kind, video: { w: 1280, h: 720, durationMs: 1500 } }));
    groups = { media: { ok: true } };
  } else if (kind === "image") {
    files.set("i/1920.jpg", stubJpeg(1920, 1080));
    files.set("t.webp", stubWebp(480, 270));
    files.set("meta.json", json({ v: 1, sha256: originalSha, kind, image: { w: 4032, h: 3024 } }));
    groups = { image: { ok: true } };
  } else {
    files.set("doc.pdf", stubPdf(rendered));
    files.set("t.webp", stubWebp(480, Math.round((480 * H) / W)));
    for (let n = 1; n <= rendered; n++) {
      for (const w of profile.widths) files.set(`s/${n}/${w}.webp`, stubWebp(w, Math.round((w * H) / W), n));
    }
    files.set(
      "slides.json",
      json({
        v: 1,
        widths: [...profile.widths],
        pages: Array.from({ length: rendered }, (_, i) => ({ n: i + 1, w: W, h: H })),
        motion: opts.motion ?? false,
        media: false,
      }),
    );
    files.set(
      "notes.json",
      json({ v: 1, notes: (opts.notes ?? []).filter((n) => n <= rendered).map((n) => ({ n, text: `Note ${n}` })) }),
    );
    files.set("meta.json", json({ v: 1, sha256: originalSha, kind, fontsMissing: [...(opts.fontsMissing ?? [])] }));
    groups = { slides: { ok: true }, pdf: { ok: true }, notes: { ok: true } };
  }
  const list = await Promise.all(
    [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(async ([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: await sha256Hex(bytes),
        type: TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream",
      })),
  );
  const manifest: Manifest = {
    v: 1,
    jobId,
    kind,
    pages: isDocument(kind) ? { total: opts.pages, rendered } : null,
    groups,
    files: list,
  };
  return { files, manifest };
}
