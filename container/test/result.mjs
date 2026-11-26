// What a corpus check may look at, kept apart from how long the job took: a shared CI runner's speed varies by
// 25 percent or more, so a check that sees elapsed time is a flaky check. Timings are recorded to the job summary.

/** Splits a finished job into the result checks receive and the timing that is only recorded.
 * @param {{ ms: number, stageAt: Record<string, number> }} raw */
export function splitTiming({ ms, stageAt, ...result }) {
  return { result, timing: { ms, stageAt } };
}

const timings = new WeakMap();

/** Attaches a job's timing to its result without making it a property of it. */
export function recordTiming(result, timing) {
  timings.set(result, timing);
  return result;
}

/** The timing of a result runJob returned, for the job summary only. */
export const timingOf = (result) => timings.get(result);
