// Limits read by more than one module. Pure: no imports, so a contract can take a number without its checker's code.

/** Largest image frame, in pixels (DROP-16): a 48 MP phone photo passes; the decoded size of one frame stays near 400 MB at most. */
export const MAX_PIXELS = 100_000_000;
