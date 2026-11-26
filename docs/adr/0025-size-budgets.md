# ADR 0025: size budgets by area

Status: accepted. Replaces the `size-limit` list in `package.json` as the place budgets live.

## Context
- One list of budgets in `package.json` means every stream that adds a page or a lazy module edits the same file and the same JSON array, so parallel streams conflict on merge.
- The first-load and lazy tests, and the doc-drift check that keeps budgets out of prose, read that one list.

## Decision
- The request budget (requests that reach the Worker, and late module requests, per task page) is `tools/requests.json`, outside `tools/size/` because it is not a size entry, and `test/e2e/requests.spec.ts` reads it; raising a number is a reviewed diff.
- Budgets live in `tools/size/<area>.json`, one file per area, and `.size-limit.mjs` merges them into the list `size-limit` runs. `tools/size/core.json` holds the existing entries; each stream adds its own area file for its own pages and modules.
- The foundation change moves every existing entry unchanged into `tools/size/core.json`: same names, same paths, same limits.
- **No limit is ever raised.** An over-budget file is made smaller, or split into a lazy module.
- **Each new page and each new lazy module gets its own entry** in its area's file. A lazy entry measures one `import()` target and what loads with it, so growth in one module never hides in a sum.
- `test/unit/docs-drift.test.ts` and the first-load and lazy tests read the merged list, so they cover every area file the same way. Docs name no entry next to a size: the files here own the numbers.

## Rejected
- **One file with a merge-friendly layout:** JSON arrays conflict on neighboring lines whatever the layout.
- **Budgets in each page's source:** a budget a developer can raise in the same diff that grows the file.
- **A bundler's own budget feature:** the repo has no bundler (ADR 0001).

## Consequences
- A new stream creates one small file and touches no shared one.
- Tooling that read `package.json` `size-limit` reads the merged list instead; a stale reader fails the drift test.

## Threats served
SITE-04 (a small first load keeps free-tier and phone-network cost down) and the performance claims the site makes.

## How to remove it
Inline the area files back into one `size-limit` array in `package.json` and delete `.size-limit.mjs` and `tools/size/`.
