// One definition of AI attribution in a commit message, for the commit-msg hook (change-tier.mjs) and land.mjs.
// Commits carry none (CLAUDE.md); the hook refuses it at commit time so a land never needs a history rewrite.

/** Trailers and footers that attribute a commit to an AI tool. */
const ATTRIBUTION = [
  /^\s*co-authored-by:/im,
  /^\s*claude-session:/im,
  /^\s*generated-by:/im,
  /noreply@anthropic\.com/i,
  /generated with \[?claude/i,
];

/** @param {string} message @returns {boolean} */
export const attributed = (message) => ATTRIBUTION.some((re) => re.test(message));
