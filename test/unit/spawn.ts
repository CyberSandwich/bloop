/**
 * The budget of a unit test that starts a process (node, git, tsc). Each start costs hundreds of ms and seconds under
 * load, so vitest's 5 s default fails them on a busy machine. `spawn-rules.test.ts` makes every such file use it.
 */
export const SPAWN_TIMEOUT = 30_000;
