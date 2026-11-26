// The type a library file name declares: every extension a validator knows (formats.ts). A guest's set stays the six
// of names.js (`typeOfName`), which the phone reads on first load; this list is the Worker's alone.
import type { FormatType } from "../seams/guest-drop/formats.ts";
import { FORMATS } from "../seams/guest-drop/formats.ts";

const EXTENSIONS: ReadonlyMap<string, FormatType> = new Map([
  ...(Object.keys(FORMATS) as FormatType[]).map((t): [string, FormatType] => [t, t]),
  ["jpeg", "jpg"],
]);

/** The type the name's extension declares, or null. */
export const libraryTypeOf = (name: string): FormatType | null =>
  EXTENSIONS.get(/\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "") ?? null;
