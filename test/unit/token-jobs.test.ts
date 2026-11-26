import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { withPrebuilt } from "../../tools/prebuilt.mjs";

const dir = new URL("../../.github/workflows/", import.meta.url);

/**
 * The jobs that hold the Cloudflare token, and the composite action they run, are pinned byte for byte, and what js-yaml
 * parses is cross-checked against the pin and the text reader, so a YAML form the text cannot see still fails. Any
 * change to a token job fails this test until the block below is updated on purpose, and that update is the review
 * point (docs/architecture.md section 12). The pinned text holds literal `${{ }}` expressions, which is why biome.json
 * turns noTemplateCurlyInString off for this file only.
 */
const PINNED: Record<string, string[]> = {
  "lockdown.yml lockdown": [
    "  lockdown:",
    "    # The production secrets run only code that is on main, started by the repository owner (set or undo alike).",
    "    if: github.ref == 'refs/heads/main' && github.triggering_actor == github.repository_owner",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 25",
    "    environment: production",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
    "      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
    "        with:",
    "          node-version-file: .nvmrc",
    "          # No restored npm cache: a cache saved by another job is written by third-party code.",
    "          package-manager-cache: false",
    "      # No install scripts run here: the secrets are not in this step, and wrangler d1 execute needs none.",
    "      - run: npm ci --ignore-scripts",
    "      - name: Plan or apply",
    "        env:",
    "          LOCKDOWN_CF_TOKEN: ${{ secrets.LOCKDOWN_CF_TOKEN }}",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "          LEVEL: ${{ inputs.level }}",
    "          METER: ${{ inputs.meter }}",
    "          UNDO: ${{ inputs.undo }}",
    "          APPLY: ${{ inputs.apply }}",
    "        run: |",
    "          set -o pipefail",
    '          args=(--level "$LEVEL")',
    '          if [ "$METER" != "none" ]; then args+=(--meter "$METER"); fi',
    '          if [ "$UNDO" = "true" ]; then args+=(--undo); fi',
    '          if [ "$APPLY" = "true" ]; then args+=(--apply); fi',
    '          node tools/lockdown.mjs "${args[@]}" 2>&1 | tee "$RUNNER_TEMP/lockdown.txt"',
    "      - name: Summary",
    "        if: always()",
    "        run: |",
    '          if [ -f "$RUNNER_TEMP/lockdown.txt" ]; then',
    "            { echo '### lockdown'; echo '```text'; cat \"$RUNNER_TEMP/lockdown.txt\"; echo '```'; } >> \"$GITHUB_STEP_SUMMARY\"",
    "          fi",
  ],
  "deploy.yml deploy": [
    "  deploy:",
    "    needs: check",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    environment: production",
    "    steps:",
    "      # A secret cannot be tested in an `if`, so this step reads it and reports whether it exists.",
    "      - name: Check for Cloudflare secrets",
    "        id: gate",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "        run: |",
    '          if [ -n "$CLOUDFLARE_API_TOKEN" ]; then echo "has=true" >> "$GITHUB_OUTPUT"; else echo "No CLOUDFLARE_API_TOKEN; skipping deploy."; fi',
    "      - if: steps.gate.outputs.has == 'true'",
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
    "      - if: steps.gate.outputs.has == 'true'",
    "        uses: ./.github/actions/prebuilt-dist",
    "      # One step holds the token, so it is in no other step's environment. The R2 lifecycle rules are a one-off",
    "      # step in docs/setup.md, not part of a deploy. A failing line stops the step.",
    "      - if: steps.gate.outputs.has == 'true'",
    "        run: |",
    "          node tools/prebuilt.mjs account",
    "          node tools/pinned-wrangler.mjs d1 migrations apply DB --remote",
    "          node tools/pinned-wrangler.mjs deploy",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  ],
  "staging.yml staging": [
    "  staging:",
    "    if: github.ref_name == 'staging'",
    "    needs: check",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    environment: staging",
    "    steps:",
    "      # A secret cannot be tested in an `if`, so this step reads it and reports whether it exists.",
    "      - name: Check for Cloudflare secrets",
    "        id: gate",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "        run: |",
    '          if [ -n "$CLOUDFLARE_API_TOKEN" ]; then echo "has=true" >> "$GITHUB_OUTPUT"; else echo "Staging skipped: no CLOUDFLARE_API_TOKEN in the staging environment."; fi',
    "      - if: steps.gate.outputs.has == 'true'",
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
    "      - if: steps.gate.outputs.has == 'true'",
    "        uses: ./.github/actions/prebuilt-dist",
    "      - name: Look for the staging resources",
    "        id: resources",
    "        if: steps.gate.outputs.has == 'true'",
    "        run: node tools/staging.mjs ready",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    "      - name: Deploy",
    "        if: steps.resources.outputs.ready == 'true'",
    "        run: |",
    "          node tools/prebuilt.mjs account",
    "          node tools/staging.mjs deploy",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    "          STAGING_D1_ID: ${{ steps.resources.outputs.d1_id }}",
  ],
  "container.yml publish": [
    "  publish:",
    "    needs: image",
    "    if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    environment: production",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
    "          fetch-depth: 0 # pruning reads digest.txt's history on origin/main",
    "      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
    "        with:",
    "          node-version-file: .nvmrc",
    "          # No restored npm cache: a cache saved by another job is written by third-party code.",
    "          package-manager-cache: false",
    "      - name: Install the repo's wrangler",
    "        run: npm ci --ignore-scripts --no-audit --no-fund",
    "      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2",
    "        with:",
    "          name: converter-image",
    "          path: ${{ runner.temp }}",
    "      - name: Load the tested image",
    '        run: gzip -dc "$RUNNER_TEMP/image.tar.gz" | docker load',
    "",
    "      # The token is set on the steps that need it, never on the job (SITE-05).",
    "      - name: Push to the Cloudflare registry",
    "        id: push",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    "        run: |",
    "          set -euo pipefail",
    '          if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then',
    '            echo "::error::CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is missing from the production environment"',
    "            exit 1",
    "          fi",
    '          tag="sha-${GITHUB_SHA::12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    '          docker tag "$IMAGE" "bloop-converter:${tag}"',
    '          node tools/pinned-wrangler.mjs containers push "bloop-converter:${tag}"',
    '          remote="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/bloop-converter:${tag}"',
    "          digest=\"$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \"$remote\" | grep -o 'sha256:[0-9a-f]\\{64\\}' | head -n1)\"",
    '          test -n "$digest"',
    '          echo "digest=${digest}" >> "$GITHUB_OUTPUT"',
    '          echo "tag=${tag}" >> "$GITHUB_OUTPUT"',
    "          {",
    '            echo "pushed bloop-converter:${tag} as ${digest}"',
    '            echo "pin it: write the digest to container/digest.txt in a commit whose message starts \\"Converter image ${tag}: bump digest to ${digest}\\""',
    '          } | tee -a "$GITHUB_STEP_SUMMARY"',
    "",
    "      # The image just pushed is always kept, whether or not it has been pinned yet.",
    "      - name: Prune old images",
    "        if: always() && steps.push.outputs.digest != ''",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    "          TAG: ${{ steps.push.outputs.tag }}",
    '        run: node container/prune-images.mjs "$GITHUB_WORKSPACE/tools/pinned-wrangler.mjs" "$TAG"',
  ],
  "action.yml": [
    "name: prebuilt dist",
    "description: >-",
    "  Installs from the lockfile without scripts, downloads the check job's dist/ artifact and swaps wrangler.jsonc's build",
    "  command for the manifest assertion. The deploy jobs, the staging job and the CI rehearsal all use it, so the rehearsal",
    "  runs the steps a deploy runs (docs/architecture.md section 12). Run actions/checkout first.",
    "",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
    "      with:",
    "        node-version-file: .nvmrc",
    "        # No restored npm cache: the check job's saved cache is written by third-party code.",
    "        package-manager-cache: false",
    "    - run: npm ci --ignore-scripts",
    "      shell: bash",
    "    - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2",
    "      with:",
    "        name: dist",
    "        path: dist",
    "    - run: node tools/prebuilt.mjs rewrite",
    "      shell: bash",
  ],
};

/** The actions any workflow may use, by pinned commit, and the one local action. */
const ALLOWED_USES = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
  "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
  "./.github/actions/prebuilt-dist",
];

/** What makes a job a token job: an environment, the token, or any use of the secrets context. */
const TOKEN_JOB = /environment["']?\s*:|CLOUDFLARE|\$\{\{[^}]*secrets/i;

/** A job key: the only line shape allowed at two spaces of indent under `jobs:`. */
const JOB_KEY = /^ {2}([\w-]+):$/;

/** Every job of a workflow with its text, from its key line to the next job key (comments in between belong to it), and
 * the lines that are not in a plain block-style layout. Nothing is parsed: a form this does not read is a problem. */
function jobsOf(text: string): { jobs: Record<string, string>; problems: string[] } {
  const lines = text.split("\n");
  const jobs: Record<string, string> = {};
  const problems: string[] = [];
  if (/[\r\t]/.test(text)) problems.push("carriage return or tab");
  const start = lines.indexOf("jobs:");
  if (start < 0) return { jobs, problems: [...problems, "no `jobs:` line"] };
  let name = "";
  for (const line of lines.slice(start + 1)) {
    const key = JOB_KEY.exec(line);
    const indent = line.length - line.trimStart().length;
    if (key) {
      name = key[1] ?? "";
      jobs[name] = line;
      continue;
    }
    if (line.trim() !== "" && !line.trimStart().startsWith("#") && indent <= 2) problems.push(`not a job key: ${line}`);
    if (name) jobs[name] += `\n${line}`;
  }
  for (const [job, body] of Object.entries(jobs)) jobs[job] = body.trimEnd();
  return { jobs, problems };
}

interface ParsedJob {
  uses?: string;
  steps?: { uses?: string }[];
  [key: string]: unknown;
}
interface Parsed {
  jobs?: Record<string, ParsedJob>;
  runs?: { steps?: { uses?: string }[] };
  [key: string]: unknown;
}

/** The mapping positions whose keys are variable names, by path: the workflow's env, a job's env and outputs, a step's
 * env and with (and the action's own steps). A job that is merely named env is not one. */
const VARIABLE_KEYS = /^(env|jobs\/[^/]+\/(env|outputs)|(jobs\/[^/]+\/|runs\/)steps\/\d+\/(env|with))$/;

/** Parsed mapping keys with an uppercase letter, outside the positions above: every key GitHub reads is lower case, so
 * a `Defaults` or `Uses` is refused rather than reasoned about. */
function keyCaseProblems(f: string, node: unknown, path: string[] = []): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => keyCaseProblems(f, item, [...path, String(i)]));
  if (typeof node !== "object" || node === null) return [];
  const variables = VARIABLE_KEYS.test(path.join("/"));
  return Object.entries(node).flatMap(([key, value]) => [
    ...(/[A-Z]/.test(key) && !variables ? [`${f}: parsed key ${key}`] : []),
    ...keyCaseProblems(f, value, [...path, key]),
  ]);
}

/** What js-yaml reads, checked against the pins and the text reader, since the text reader cannot see every YAML form:
 * the job keys must be the ones it found, a job with an environment in any form or any mention of the secrets context
 * must parse to its pinned job, nothing sets defaults, container or services, and every uses is allowlisted. */
function parsedProblems(f: string, text: string, textJobs: string[]): string[] {
  let doc: Parsed;
  try {
    doc = (load(text) ?? {}) as Parsed;
  } catch {
    return [`${f}: not valid YAML`];
  }
  const problems: string[] = keyCaseProblems(f, doc);
  const jobs = doc.jobs ?? {};
  const names = Object.keys(jobs).sort();
  if (!isDeepStrictEqual(names, [...textJobs].sort()))
    problems.push(`${f}: parsed jobs [${names}] differ from the jobs read from the text [${textJobs}]`);
  // Keys are compared lower-cased, so a differently-cased spelling is read as the key it imitates.
  const get = (node: object, key: string): unknown =>
    Object.entries(node).find(([name]) => name.toLowerCase() === key)?.[1];
  for (const key of ["defaults", "container", "services"])
    if (get(doc, key) !== undefined) problems.push(`${f}: parsed ${key}`);
  if (JSON.stringify(doc.env ?? "").includes("CLOUDFLARE"))
    problems.push(`${f}: parsed workflow-level env holds the token`);
  const uses = (steps: unknown) => (Array.isArray(steps) ? steps.map((step) => get(step, "uses")) : []);
  for (const [name, job] of Object.entries(jobs)) {
    for (const key of ["defaults", "container", "services"])
      if (get(job, key) !== undefined) problems.push(`${f} ${name}: parsed ${key}`);
    for (const use of [get(job, "uses"), ...uses(get(job, "steps"))])
      if (use !== undefined && !ALLOWED_USES.includes(String(use))) problems.push(`${f} ${name}: parsed uses ${use}`);
    // Anywhere in the job's JSON, so a merge key or an alias cannot carry an environment in.
    if (!/"environment"\s*:|secrets|CLOUDFLARE/i.test(JSON.stringify(job))) continue;
    const pin = PINNED[`${f} ${name}`];
    const pinned = pin ? (load(`jobs:\n${pin.join("\n")}`) as Parsed).jobs?.[name] : undefined;
    if (!isDeepStrictEqual(job, pinned)) problems.push(`${f} ${name}: parsed job differs from its pin`);
  }
  for (const use of uses(doc.runs?.steps))
    if (use !== undefined && !ALLOWED_USES.includes(String(use))) problems.push(`${f}: parsed uses ${use}`);
  return problems;
}

/** The second layer, by allowed line shape: outside block scalars every line is a comment, a plain `key: value` or
 * `key:` line, or a `- ` list item, with no backslash in a double-quoted string, no anchor, alias, tag or explicit
 * key, and no flow map. js-yaml decodes escapes and aliases that the text reader does not, so these forms fail here. */
function shapeProblems(f: string, text: string): string[] {
  const problems: string[] = [];
  let scalarColumn = -1;
  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (scalarColumn >= 0 && (line.trim() === "" || indent > scalarColumn)) continue;
    scalarColumn = -1;
    const body = line.trim();
    if (body === "" || body.startsWith("#")) continue;
    const rest = body.replace(/^(- )+/, "");
    const key = /^[A-Za-z_][\w.-]*:(?: (.*))?$/.exec(rest);
    const value = key ? (key[1] ?? "") : rest;
    const block = key !== null && /^[|>][-+0-9]*(\s+#.*)?$/.test(value);
    const plain = key !== null || (rest !== body && !/^[&*!?{|>%@`]/.test(rest));
    const odd =
      /(^|[\s[,])[&*!][\w!<-]/.test(value) || (!block && /^[{?|>%@`]/.test(value)) || /"[^"\n]*\\/.test(value);
    if (!plain || odd) problems.push(`${f}: not a plain line: ${body}`);
    if (block) scalarColumn = indent + (body.length - rest.length);
  }
  return problems;
}

/** Why the workflows and the action could run code other than what is pinned beside the token. */
function pinProblems(files: Record<string, string>, action: string): string[] {
  const problems: string[] = [];
  const found = new Set<string>();
  for (const [f, text] of Object.entries(files)) {
    const { jobs, problems: layout } = jobsOf(text);
    problems.push(
      ...layout.map((p) => `${f}: ${p}`),
      ...shapeProblems(f, text),
      ...parsedProblems(f, text, Object.keys(jobs)),
    );
    for (const [name, body] of Object.entries(jobs)) {
      if (!TOKEN_JOB.test(body)) continue;
      found.add(`${f} ${name}`);
      if (body !== PINNED[`${f} ${name}`]?.join("\n")) problems.push(`${f} ${name} differs from its pin`);
    }
  }
  for (const pin of Object.keys(PINNED)) {
    if (pin !== "action.yml" && !found.has(pin)) problems.push(`${pin} is pinned but no longer a token job`);
  }
  for (const key of found) if (!(key in PINNED)) problems.push(`${key} holds the token and is not pinned`);
  if (action.trimEnd() !== PINNED["action.yml"]?.join("\n")) problems.push("action.yml differs from its pin");
  problems.push(...shapeProblems("action.yml", action), ...parsedProblems("action.yml", action, []));
  for (const [f, text] of [...Object.entries(files), ["action.yml", action] as const]) {
    if (/[\r\t]/.test(text)) problems.push(`${f}: carriage return or tab`);
    if (/^\s*["']?(defaults|container|services)["']?\s*:/im.test(text))
      problems.push(`${f} has defaults, container or services`);
    for (const use of text.matchAll(/["']?\buses["']?\s*:\s*["']?([^\s"'}]+)/gi)) {
      if (!ALLOWED_USES.includes(use[1] ?? "")) problems.push(`${f} uses ${use[1]}`);
    }
  }
  return problems;
}

/** The text of job `name` in a workflow. */
const jobBlock = (text: string, name: string): string => jobsOf(text).jobs[name] ?? "";

describe("SITE-05 third-party code never shares a job with the token", () => {
  const files = Object.fromEntries(
    readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, readFileSync(new URL(f, dir), "utf8")]),
  );
  const action = readFileSync(new URL("../actions/prebuilt-dist/action.yml", dir), "utf8");

  it("SITE-05 token jobs: every job that names an environment or the token, and the action they run, is exactly its pinned text", () => {
    expect(pinProblems(files, action)).toEqual([]);
    expect(Object.keys(PINNED)).toHaveLength(5);
  });

  it("SITE-05 token jobs: the guard refuses each way to change a token job, add one, or run another action", () => {
    const deploy = files["deploy.yml"] ?? "";
    const ci = files["ci.yml"] ?? "";
    const edit = (name: string, text: string, replace: [string, string]) => {
      const changed = text.replace(...replace);
      expect(changed, `${name} edit applies`).not.toBe(text);
      return pinProblems({ ...files, [name.split(" ")[0] ?? ""]: changed }, action).join("\n");
    };
    const addJob = (job: string) => pinProblems({ ...files, "new.yml": `jobs:\n${job}` }, action).join("\n");
    const sha = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
    const cases: [string, string, string][] = [
      [
        "a command appended to a run",
        edit("deploy.yml", deploy, ["mjs deploy\n", "mjs deploy && npx evil\n"]),
        "deploy.yml deploy differs",
      ],
      [
        "a step after a two-space comment",
        edit("deploy.yml", deploy, ["mjs deploy\n", "mjs deploy\n  # end\n      - run: npx evil\n"]),
        "deploy.yml deploy differs",
      ],
      [
        "a changed indentation",
        edit("deploy.yml", deploy, ["    environment: production", "     environment: production"]),
        "deploy.yml deploy differs",
      ],
      [
        "a working-directory",
        edit("deploy.yml", deploy, [
          "        uses: ./.github/actions/prebuilt-dist",
          "        uses: ./.github/actions/prebuilt-dist\n        working-directory: dist",
        ]),
        "deploy.yml deploy differs",
      ],
      [
        "a job container",
        edit("deploy.yml", deploy, [
          "    environment: production",
          "    environment: production\n    container: evil:1",
        ]),
        "has defaults, container or services",
      ],
      [
        "workflow defaults",
        edit("deploy.yml", deploy, ["jobs:", "defaults:\n  run:\n    shell: npx foo {0}\njobs:"]),
        "has defaults, container or services",
      ],
      [
        "quoted workflow defaults",
        edit("deploy.yml", deploy, ["jobs:", '"defaults":\n  run:\n    shell: npx foo {0}\njobs:']),
        "has defaults, container or services",
      ],
      [
        "defaults with a space before the colon",
        edit("deploy.yml", deploy, ["jobs:", "defaults :\n  run:\n    shell: npx foo {0}\njobs:"]),
        "has defaults, container or services",
      ],
      [
        "a service",
        edit("ci.yml", ci, ["  rehearsal:", "  rehearsal:\n    services:\n      x:\n        image: evil"]),
        "has defaults, container or services",
      ],
      [
        "a third-party action",
        edit("ci.yml", ci, [sha, "evil/action@3d3c42e5aac5ba805825da76410c181273ba90b1"]),
        "ci.yml uses evil/action@",
      ],
      [
        "a tag instead of a commit",
        edit("ci.yml", ci, [sha, "actions/checkout@v4"]),
        "ci.yml uses actions/checkout@v4",
      ],
      [
        "a quoted uses key",
        edit("ci.yml", ci, ["  rehearsal:\n", '  rehearsal:\n    steps:\n      - "uses": evil/x@1\n']),
        "ci.yml uses evil/x@1",
      ],
      [
        "a flow-style step",
        edit("ci.yml", ci, ["  rehearsal:\n", "  rehearsal:\n    steps:\n      - { uses: evil/y@1 }\n"]),
        "ci.yml uses evil/y@1",
      ],
      [
        "a reusable workflow job",
        addJob("  more:\n    uses: org/repo/.github/workflows/x.yml@main\n"),
        "uses org/repo/.github/workflows/x.yml@main",
      ],
      [
        "a job using the token secret",
        addJob(
          "  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
        ),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "toJSON of all secrets",
        addJob("  go:\n    steps:\n      - run: echo ${{ toJSON(secrets) }}\n"),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "an environment in a new job",
        addJob("  go:\n    environment: production\n    steps:\n      - run: npx evil\n"),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "an environment indented six spaces",
        addJob("  go:\n    steps:\n      - run: npx evil\n      environment: production\n"),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "a quoted environment key",
        addJob('  go:\n    "environment": production\n    steps:\n      - run: npx evil\n'),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "a space before the environment colon",
        addJob("  go:\n    environment : production\n    steps:\n      - run: npx evil\n"),
        "new.yml go holds the token and is not pinned",
      ],
      ["a comment after the job key", addJob("  go: # x\n    environment: production\n"), "not a job key:   go: # x"],
      ["a quoted job key", addJob('  "go":\n    environment: production\n'), 'not a job key:   "go":'],
      ["a flow-style job", addJob("  go: { environment: production, steps: [] }\n"), "not a job key"],
      [
        "a CRLF workflow",
        pinProblems({ ...files, "deploy.yml": deploy.replaceAll("\n", "\r\n") }, action).join("\n"),
        "carriage return or tab",
      ],
      // Valid YAML the text reader does not see: only the js-yaml cross-check names these.
      [
        "jobs indented four spaces",
        pinProblems({ ...files, "new.yml": "jobs:\n    go:\n      environment: production\n" }, action).join("\n"),
        "new.yml: parsed jobs [go] differ from the jobs read from the text []",
      ],
      [
        "a job under an anchor",
        addJob("  go: &g\n    environment: production\n    steps: []\n"),
        "new.yml: parsed jobs [go] differ from the jobs read from the text []",
      ],
      [
        "an environment merged in from an anchor",
        addJob("  base:\n    steps: []\n  go:\n    <<: { environment: production }\n    steps: []\n"),
        "new.yml go: parsed job differs from its pin",
      ],
      [
        "the secrets context over several lines",
        addJob("  go:\n    steps:\n      - run: echo ${{\n          secrets.X }}\n"),
        "new.yml go: parsed job differs from its pin",
      ],
      // YAML escapes and aliases: the parse decodes them, and the shape layer refuses the spelling.
      [
        "an environment key written with a \\u escape",
        addJob('  go:\n    "\\u0065nvironment": production\n    steps: []\n'),
        "new.yml go: parsed job differs from its pin",
      ],
      [
        "an environment key written with a \\x escape, refused by shape",
        addJob('  go:\n    "\\x65nvironment": production\n    steps: []\n'),
        'new.yml: not a plain line: "\\x65nvironment": production',
      ],
      [
        "workflow defaults written with an escape",
        pinProblems(
          { ...files, "new.yml": '"\\u0064efaults": { run: { shell: x } }\njobs:\n  go:\n    steps: []\n' },
          action,
        ).join("\n"),
        "new.yml: parsed defaults",
      ],
      [
        "a uses key written with an escape",
        addJob('  go:\n    steps:\n      - "\\u0075ses": evil/x@sha\n'),
        "new.yml go: parsed uses evil/x@sha",
      ],
      [
        "the secrets context with an escaped dollar",
        addJob('  go:\n    steps:\n      - run: "\\x24{{ toJSON(secrets) }}"\n'),
        "new.yml go: parsed job differs from its pin",
      ],
      [
        "the secrets context after a closing brace",
        addJob("  go:\n    steps:\n      - run: echo ${{ '}' && toJSON(secrets) }}\n"),
        "new.yml go: parsed job differs from its pin",
      ],
      [
        "an alias used as a key",
        pinProblems(
          { ...files, "new.yml": "env:\n  K: &k environment\njobs:\n  go:\n    *k : production\n    steps: []\n" },
          action,
        ).join("\n"),
        "new.yml go: parsed job differs from its pin",
      ],
      [
        "workflow Defaults with a capital",
        pinProblems(
          { ...files, "new.yml": "Defaults:\n  run:\n    shell: x\njobs:\n  go:\n    steps: []\n" },
          action,
        ).join("\n"),
        "new.yml: parsed key Defaults",
      ],
      [
        "a job Container with a capital",
        addJob("  go:\n    Container: evil:1\n    steps: []\n"),
        "new.yml: parsed key Container",
      ],
      [
        "a job named env does not exempt its own keys",
        addJob("  env:\n    Container: evil:1\n    steps: []\n"),
        "new.yml: parsed key Container",
      ],
      [
        "a variable-looking key outside env, with and outputs",
        addJob("  go:\n    steps:\n      - run: x\n        Shell: y\n"),
        "new.yml: parsed key Shell",
      ],
      [
        "a job Services with a capital",
        addJob("  go:\n    Services:\n      x:\n        image: evil\n    steps: []\n"),
        "new.yml: parsed key Services",
      ],
      ["a step Uses with a capital", addJob("  go:\n    steps:\n      - Uses: evil/x@1\n"), "new.yml: parsed key Uses"],
      [
        "a step Uses with a capital, read by the text layer too",
        addJob("  go:\n    steps:\n      - Uses: evil/x@1\n"),
        "new.yml uses evil/x@1",
      ],
      [
        "an anchor, refused by shape",
        addJob("  go:\n    steps: []\n    env:\n      K: &k x\n"),
        "new.yml: not a plain line: K: &k x",
      ],
      [
        "an explicit key, a tag and a second document, refused by shape",
        addJob("  go:\n    ? steps\n    : []\n    t: !!str x\n---\n"),
        "new.yml: not a plain line: ? steps",
      ],
      [
        "a flow-style step with a quoted uses key",
        addJob('  go:\n    steps: [{ "uses": evil/z@1 }]\n'),
        "new.yml go: parsed uses evil/z@1",
      ],
      [
        "a job-level reusable workflow in flow style",
        addJob("  go:\n    { uses: org/r/.github/workflows/x.yml@main }\n"),
        "new.yml go: parsed uses org/r/.github/workflows/x.yml@main",
      ],
      [
        "quoted workflow defaults",
        pinProblems(
          { ...files, "new.yml": '"defaults": { run: { shell: x } }\njobs:\n  go:\n    steps: []\n' },
          action,
        ).join("\n"),
        "new.yml: parsed defaults",
      ],
      [
        "the token in a flow-style workflow env",
        pinProblems(
          { ...files, "new.yml": "env: { CLOUDFLARE_API_TOKEN: x }\njobs:\n  go:\n    steps: []\n" },
          action,
        ).join("\n"),
        "new.yml: parsed workflow-level env holds the token",
      ],
      [
        "a workflow that is not valid YAML",
        pinProblems({ ...files, "new.yml": "jobs:\n  go: [\n" }, action).join("\n"),
        "new.yml: not valid YAML",
      ],
      [
        "an action step with an allowlist miss",
        pinProblems(
          files,
          action.replace("actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333", "evil/x@1"),
        ).join("\n"),
        "action.yml: parsed uses evil/x@1",
      ],
    ];
    for (const [name, problems, expected] of cases) expect(problems, name).toContain(expected);
    expect(pinProblems(files, action.replace("npm ci --ignore-scripts", "npm ci"))).toEqual([
      "action.yml differs from its pin",
    ]);
  });

  it("SITE-05 token jobs: the check job has no environment and no secret and hands dist/ over with its hidden files", () => {
    for (const f of ["deploy.yml", "staging.yml", "ci.yml"]) {
      const check = jobBlock(files[f] ?? "", "check");
      expect(check, f).not.toMatch(/environment:|secrets\.|CLOUDFLARE/);
      expect(check, f).toContain("      - run: node tools/prebuilt.mjs manifest\n");
      expect(check, f).toContain("include-hidden-files: true");
    }
  });

  it("SITE-05 token jobs: the rehearsal runs on every branch with no environment and no token, then dry-runs both configs", () => {
    const ci = files["ci.yml"] ?? "";
    const rehearsal = jobBlock(ci, "rehearsal");
    expect(rehearsal).toContain("needs: check");
    expect(rehearsal).not.toMatch(/environment:|secrets\.|CLOUDFLARE/);
    expect(rehearsal).toContain("uses: ./.github/actions/prebuilt-dist");
    expect(rehearsal).toContain("node tools/prebuilt.mjs assert");
    expect(rehearsal).toContain("node tools/pinned-wrangler.mjs deploy --dry-run --outdir");
    expect(rehearsal).toContain("node tools/pinned-wrangler.mjs deploy --dry-run -e staging --outdir");
    expect(rehearsal).toContain("node tools/pinned-wrangler.mjs d1 execute --help");
    expect(ci).not.toMatch(/^on:\n {2}push:\n {4}branches/m);
  });

  it("SITE-05 token jobs: wrangler.jsonc's build block is the one the deploy jobs know how to swap", () => {
    const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    expect(() => withPrebuilt(config)).not.toThrow();
    expect(withPrebuilt(config)).toContain("node tools/prebuilt.mjs assert");
    expect(() => withPrebuilt("{}")).toThrow(/no build block/);
  });
});
