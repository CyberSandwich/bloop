// The spend guard's variables, generated from its registries so the code and the list cannot disagree (docs/spend.md
// owns what each does). Every one is optional: the default lives in the registry, a var only overrides it. A bad value
// fails the config like any other var: a typo must not silently leave a higher default in force.
import { z } from "zod";
import { CAPS, type NumberSpec, PRICED, TRIPS } from "../spend/caps.ts";
import { SWITCHES } from "../spend/switches.ts";
import { optional } from "./core.ts";

/** `positive` matches the registry's `positiveVar`, which refuses 0 for a line (a zero line trips at once). */
const number = (describe: string, positive: boolean, min = 0) => {
  // A floor above zero says why: the registry's reason names the guarantee a lower value would break.
  const floor = min > 0 ? `must be at least ${min}: ${describe}` : undefined;
  return optional(positive ? z.coerce.number().positive().min(min, floor) : z.coerce.number().min(min, floor)).describe(
    describe,
  );
};

const spec = (s: NumberSpec): [string, z.ZodType] => [s.var, number(s.reason, s.positive === true, s.min)];

const entries: [string, z.ZodType][] = [
  // A switch var is a floor, and the registry treats an unknown value as the most restrictive, so it is not rejected here.
  ...Object.entries(SWITCHES).map(([name, s]): [string, z.ZodType] => [
    s.var,
    optional(z.string()).describe(
      `Deploy-time floor of the ${name} switch (${s.values.join(", ")}); the more restrictive of this and the /admin row applies.`,
    ),
  ]),
  ...[...Object.values(CAPS), ...Object.values(TRIPS)].map(spec),
  ...Object.entries(PRICED).flatMap(([meter, p]): [string, z.ZodType][] => [
    [p.share.var, number(`Percent of the monthly budget the ${meter} line is sized from.`, true)],
    [p.floorVar, number(`Daily floor of the ${meter} line, in ${p.unit}.`, true)],
    [p.ceilingVar, number(`Daily ceiling of the ${meter} line, in ${p.unit}.`, true)],
  ]),
];

export const spendVars: Record<string, z.ZodType> = Object.fromEntries(entries);
