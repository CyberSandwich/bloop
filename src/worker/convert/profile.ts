// The two conversion profiles (docs/conversion.md) and the deadline a job gets. Pure.
import { FULL_WIDTHS, isDocument, type Kind, SECOND_CONVERT_EXTS, STAGE_TIMEOUT_S } from "./contract.ts";

export type ProfileName = "full" | "demo";

export interface Profile {
  name: ProfileName;
  /** Widths the container renders, widest first. */
  widths: readonly number[];
  maxPages: number;
  /** Unpacked-archive cap handed to the container. */
  maxUnpacked: number;
  /** Everything a job may store. */
  totalBytes: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const PROFILES: Record<ProfileName, Profile> = {
  full: { name: "full", widths: FULL_WIDTHS, maxPages: 300, maxUnpacked: 2 * GIB, totalBytes: 4 * GIB },
  demo: { name: "demo", widths: [1920, 480], maxPages: 40, maxUnpacked: 200_000_000, totalBytes: 200 * MIB },
};

export const profileFor = (name: ProfileName): Profile => PROFILES[name];

/** The container's environment for one job: the caps, with the input cap equal to the stored size. */
export function containerEnv(profile: Profile, bytes: number): Record<string, string> {
  return {
    BLOOP_MAX_INPUT: String(bytes),
    BLOOP_MAX_PAGES: String(profile.maxPages),
    BLOOP_MAX_UNPACKED: String(profile.maxUnpacked),
    BLOOP_WIDTHS: profile.widths.join(","),
  };
}

const BOOT_S = 90;
const INPUT_BASE_S = 30;
const INPUT_BYTES_PER_S = 4 * MIB;
const STORE_BASE_S = 120;
const STORE_PER_PAGE_S = 0.5;
const SLACK_S = 60;

/** Seconds the container's own stages may take for this kind. */
function stageSum(kind: Kind, ext: string): number {
  const t = STAGE_TIMEOUT_S;
  if (kind === "video") return t.inspect + t.video;
  if (kind === "image") return t.inspect + t.heic;
  const fontCheck = 30; // the font pass has no timeout of its own in the contract: a margin
  const second = SECOND_CONVERT_EXTS.includes(ext) ? t.convert : 0;
  return t.inspect + t.convert + fontCheck + t.rasterize + second;
}

/**
 * Boot, chunked input, every stage at its timeout, the store and some slack. The caller compares it with the lease
 * maximum and refuses the job (`too_large`) when it does not fit; this never clamps.
 */
export function deadlineSeconds(kind: Kind, ext: string, bytes: number, profile: Profile): number {
  const input = INPUT_BASE_S + Math.ceil(bytes / INPUT_BYTES_PER_S);
  const store = STORE_BASE_S + (isDocument(kind) ? Math.ceil(STORE_PER_PAGE_S * profile.maxPages) : 0);
  return BOOT_S + input + stageSum(kind, ext) + store + SLACK_S;
}
