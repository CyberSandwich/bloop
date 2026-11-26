// The words of progress: the pill's status word and the sheet's byte counts (docs/ux/upload.md section 2).
const KIB = 1024;
const MIB = KIB * KIB;

/** @param {number} fraction @returns {string} the whole percent, "42%" */
export const percent = (fraction) => `${Math.round(fraction * 100)}%`;

/** @param {{state: string, fraction: number}} f @returns {string | undefined} the status word; none before a byte has moved */
export const statusWord = (f) =>
  /** @type {Record<string, string>} */ ({
    uploading: percent(f.fraction),
    waiting: "Waiting",
    checking: "Checking",
    unsettled: "Still Checking",
    saved: "Saved",
  })[f.state];

/**
 * "34 of 88 MB": both numbers in the total's unit, one decimal under 10, whole above. The sent share rounds down, so
 * it never reads ahead of the bytes.
 * @param {number} loaded
 * @param {number} total
 */
export function formatBytes(loaded, total) {
  const unit = total < MIB ? KIB : total < KIB * MIB ? MIB : KIB * MIB;
  const name = unit === KIB ? "KB" : unit === MIB ? "MB" : "GB";
  const scaled = total / unit;
  if (Math.round(scaled * 10) >= 100 || unit === KIB)
    return `${Math.floor(loaded / unit)} of ${Math.max(1, Math.round(scaled))} ${name}`;
  return `${(Math.floor((loaded / unit) * 10) / 10).toFixed(1)} of ${scaled.toFixed(1)} ${name}`;
}
