// What the pill says about progress (docs/ux/upload.md section 2): the share sent, and the time left.
const KIB = 1024;
const MIB = KIB * KIB;

/** @param {number} ms @returns {string} whole minutes rounded up, so it never counts by seconds */
export const etaLabel = (ms) => (ms < 60_000 ? "Under a minute left" : `${Math.ceil(ms / 60_000)} min left`);

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

/** @param {number} loaded @param {number} total @param {number | null} left the time left, when known @returns {string} "34 of 88 MB · 2 min left" */
export const progressLine = (loaded, total, left) =>
  `${formatBytes(loaded, total)}${left === null ? "" : ` · ${etaLabel(left)}`}`;
