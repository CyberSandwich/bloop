// The Check This Room page's strings, loaded by that page only (the rules: copy.js).
/** `/s?check`. Numbers are arguments, filled from config and the measurement, never constants here. */
export const CHECK = {
  link: "Check This Room",
  title: "Check This Room",
  running: "Checking…",
  button: "Check Again",
  ready: "This room is ready.",
  limits: "This room works, with the limits below.",
  blocked: "bloop can't run in this room. Ask your IT team to allow bloop.here, then check again.",
  api: { pass: "bloop answers on this network.", fail: "This network blocks bloop." },
  live: {
    pass: "Live updates work here.",
    fail: (/** @type {number} */ seconds) =>
      `Live updates are blocked here, so bloop checks every ${seconds} s instead.`,
  },
  files: { pass: "Files load from their own address.", fail: "Files come from bloop.here instead." },
  speed: (/** @type {number} */ mbPerSecond) => `Downloads run at about ${mbPerSecond} MB a second.`,
  awake: { pass: "This browser can keep the screen awake.", fail: "This browser may let the screen sleep." },
  clock: {
    pass: "This PC's clock is right.",
    fail: (/** @type {number} */ minutes) => `This PC's clock is ${minutes} minutes off.`,
  },
};
