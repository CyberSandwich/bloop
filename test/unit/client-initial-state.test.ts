// A control gated on a field's value must be gated once at load too: a value typed, pasted or autofilled before the
// module ran fired no event its listener heard, so a listener-only gate leaves the control in its markup state.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const JS = resolve(import.meta.dirname, "../../public/js");

/**
 * Heuristic: every `input` or `change` listener (addEventListener or an on-property) is in scope, since a gate is often
 * written through a helper in another module and cannot be told apart reliably. It passes only when its handler is a
 * named function the module also calls at top level (a column-0 `name();`). Anything else needs an ALLOWED line.
 */
const ALLOWED: Record<string, string> = {
  "phone.js":
    "the item inputs are created by this module, so none changes before its listener; the file pick is an action, not a gate",
  "core/upload-pill.js": "the file pick is an action that resumes a paused row, not a gate on a control",
  "core/length.js": "the Until field sits in a closed sheet until openLength, which fills it and runs refresh() first",
  "library.js":
    "the row ticks are created by this module and the file pick is an action, so neither is a gate on a typed value",
};

const LISTENER = /(?:addEventListener\(\s*"(?:input|change)"\s*,\s*([^,)]+)|\.on(?:input|change)\s*=\s*([^;\n]+))/g;

/** The listeners in `src` whose gate does not also run at load, as their handler text. */
function unprimed(src: string): string[] {
  return [...src.matchAll(LISTENER)]
    .map((m) => (m[1] ?? m[2] ?? "").trim())
    .filter((handler) => {
      if (!/^[A-Za-z_$][\w$]*$/.test(handler)) return true;
      return !new RegExp(`^${handler.replace(/\$/g, "\\$")}\\(\\);?\\s*$`, "m").test(src);
    });
}

function modules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "vendor" ? [] : modules(path);
    return e.name.endsWith(".js") ? [relative(JS, path)] : [];
  });
}

describe("client initial state", () => {
  const files = modules(JS);

  it("every input or change gate also runs once at module load", () => {
    const flagged = files
      .filter((f) => !(f in ALLOWED))
      .map((f) => ({ file: f, handlers: unprimed(readFileSync(join(JS, f), "utf8")) }))
      .filter((f) => f.handlers.length > 0);
    expect(flagged).toEqual([]);
  });

  it("every allowlisted module still has an unprimed listener", () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(files, file).toContain(file);
      expect(unprimed(readFileSync(join(JS, file), "utf8")), file).not.toEqual([]);
    }
  });

  it("flags a listener-only gate: the /code check before it ran at load", () => {
    const before = [
      'input.addEventListener("input", () => {',
      "  go.disabled = typedValid(input.value) === null || busy;",
      "});",
    ].join("\n");
    expect(unprimed(before)).toHaveLength(1);
    expect(unprimed("input.oninput = () => { go.disabled = !input.value; };")).toHaveLength(1);
    // A named handler called only inside another function is not a load-time run.
    expect(unprimed('at.addEventListener("input", refresh);\nfunction open() {\n  refresh();\n}')).toEqual(["refresh"]);
  });

  it("passes a gate that also runs at load: the /code check as fixed", () => {
    const after = [
      "function check() {",
      "  go.disabled = typedValid(input.value) === null || busy;",
      "}",
      'input.addEventListener("input", check);',
      "check();",
    ].join("\n");
    expect(unprimed(after)).toEqual([]);
    expect(unprimed(readFileSync(join(JS, "code.js"), "utf8"))).toEqual([]);
  });
});
