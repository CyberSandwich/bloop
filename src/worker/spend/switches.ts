// The kill-switch registry: every switch's allowed values, default and wrangler var. Pure; the D1 `setting` lookup
// (one cached read) and the /admin panel both build on `effectiveSwitch`. docs/spend.md says what each switch stops.

export type SwitchName = keyof typeof SWITCHES;

interface SwitchSpec {
  /** Least restrictive first: a later value stops more. */
  readonly values: readonly string[];
  /** Used when no row exists. */
  readonly default: string;
  /** A deploy-time floor: `wrangler deploy --var SWITCH_X:off` holds even when D1 or /admin is unreachable. */
  readonly var: string;
}

const spec = <const V extends readonly string[]>(values: V, def: V[number], name: string) => ({
  values,
  default: def,
  var: `SWITCH_${name.toUpperCase()}`,
});

export const SWITCHES = {
  guest_files: spec(["on", "stopped"], "on", "guest_files"),
  guest_drop: spec(["open", "pass", "off"], "open", "guest_drop"),
  demo: spec(["on", "off"], "on", "demo"),
  demo_drop: spec(["on", "off"], "on", "demo_drop"),
  uploads: spec(["on", "readonly", "off"], "on", "uploads"),
  convert: spec(["on", "account_only", "off"], "account_only", "convert"),
  convert_video: spec(["on", "off"], "on", "convert_video"),
  email: spec(["on", "admin_only", "off"], "on", "email"),
  signin_code: spec(["on", "off"], "on", "signin_code"),
  invites: spec(["on", "off"], "on", "invites"),
  file_origin: spec(["workers_dev", "main", "off"], "workers_dev", "file_origin"),
  export: spec(["on", "off"], "on", "export"),
  previews: spec(["on", "off"], "on", "previews"),
  breaker: spec(["auto", "alert_only"], "auto", "breaker"),
} as const satisfies Record<string, SwitchSpec>;

export const SWITCH_NAMES = Object.keys(SWITCHES) as SwitchName[];

export const isSwitchName = (name: string): name is SwitchName => Object.hasOwn(SWITCHES, name);

const specOf = (name: SwitchName): SwitchSpec => SWITCHES[name];

/** 0 for the least restrictive value; -1 for a value the switch does not allow. */
export const restrictiveness = (name: SwitchName, value: string | undefined): number =>
  value === undefined ? -1 : specOf(name).values.indexOf(value);

export const mostRestrictiveValue = (name: SwitchName): string => specOf(name).values.at(-1) as string;

const unset = (v: string | undefined) => v === undefined || v === "";

/**
 * The value in force: the more restrictive of the var (a floor) and the row (or the default when there is no row).
 * A value the switch does not allow, in either place, counts as the most restrictive: a typo stops the feature
 * (visible, fixable in /admin or a deploy) instead of opening it. An unset var is no floor.
 */
export function effectiveSwitch(name: SwitchName, varValue: string | undefined, rowValue: string | undefined): string {
  const s = specOf(name);
  const pick = (v: string) => (restrictiveness(name, v) < 0 ? mostRestrictiveValue(name) : v);
  const fromRow = pick(unset(rowValue) ? s.default : (rowValue as string));
  if (unset(varValue)) return fromRow;
  const floor = pick(varValue as string);
  return restrictiveness(name, floor) > restrictiveness(name, fromRow) ? floor : fromRow;
}

/** True when `candidate` is allowed and stops strictly more than `current`. */
export const isStricter = (name: SwitchName, candidate: string, current: string): boolean =>
  restrictiveness(name, candidate) > restrictiveness(name, current);

/** What /admin may write: an allowed value for a known switch. */
export const isAllowedValue = (name: string, value: string): boolean =>
  isSwitchName(name) && restrictiveness(name, value) >= 0;

/**
 * One read of the `setting` table, key to value: the shape F's settings reader hands every consumer (one query, one
 * cache). Switch rows are keyed by switch name and cap overrides by `cap.<cap name>`; a key this module does not
 * know is ignored. Everything below is a pure function of it.
 */
export type SettingsSnapshot = Readonly<Record<string, string>>;

/** Every switch's value in force, from the Worker's vars and a settings snapshot. */
export function effectiveAll(
  vars: Readonly<Record<string, unknown>>,
  settings: SettingsSnapshot,
): Record<SwitchName, string> {
  const out = {} as Record<SwitchName, string>;
  for (const name of SWITCH_NAMES) {
    const v = vars[specOf(name).var];
    out[name] = effectiveSwitch(name, typeof v === "string" ? v : undefined, settings[name]);
  }
  return out;
}
