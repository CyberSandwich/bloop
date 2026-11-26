// deploy.yml's reuse job: finds the ci.yml push run that already passed this exact commit, so the deploy ships that
// run's dist/ instead of running the check again (ADR 0031). Imports nothing third-party and holds no secret.
//   node tools/ci-reuse.mjs find   writes run_id=<id> to $GITHUB_OUTPUT when a run matches, and says why not otherwise
//   node tools/ci-reuse.mjs done   sets reused=true only when that run's dist/ was downloaded, asserted and re-uploaded
//                                  (PUT=success), and writes which path ran to the job summary
// The run match proves where dist/ came from; `prebuilt.mjs assert` proves it intact. Neither alone is enough.
import { appendFileSync } from "node:fs";

export const CI_PATH = ".github/workflows/ci.yml";

/**
 * @typedef {{ id: number, head_sha: string, event: string, status: string, conclusion: string | null, path: string,
 *   repository?: { full_name?: string }, head_repository?: { full_name?: string } | null }} Run
 */

/** The newest run of this repository's ci.yml that built `sha` on a push and passed every job, or undefined. A
 * pull_request run builds the merge commit, not head_sha, so it never counts; a sha fixes the whole tree, ci.yml
 * included, so a matching run built exactly this commit with this workflow.
 * @param {Run[]} runs @param {{ sha: string, repo: string }} want @returns {Run | undefined} */
export function matchingRun(runs, { sha, repo }) {
  return runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.event === "push" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.path === CI_PATH &&
        run.repository?.full_name === repo &&
        run.head_repository?.full_name === repo,
    )
    .sort((a, b) => b.id - a.id)[0];
}

/** What the reuse job decided, for the job summary and the `reused` output.
 * @param {string | undefined} runId @param {string | undefined} put @param {string | undefined} server @param {string | undefined} repo */
export function outcome(runId, put, server, repo) {
  if (runId && /^\d+$/.test(runId) && put === "success")
    return {
      reused: true,
      line: `Reused dist/ from ci run ${server}/${repo}/actions/runs/${runId}; the check job is skipped.`,
    };
  const why = runId
    ? `ci run ${runId} matched but its dist/ did not pass the download, assert or upload`
    : "no ci run matched";
  return { reused: false, line: `Full check: ${why}.` };
}

const command = process.argv[1]?.endsWith("ci-reuse.mjs") ? process.argv[2] : undefined;
const env = process.env;
if (command === "find") {
  const sha = env.GITHUB_SHA ?? "";
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("GITHUB_SHA or GITHUB_REPOSITORY is malformed");
  const query = new URLSearchParams({ head_sha: sha, event: "push", status: "success", per_page: "100" });
  const res = await fetch(`${env.GITHUB_API_URL}/repos/${repo}/actions/workflows/ci.yml/runs?${query}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`the ci.yml runs list answered ${res.status}`);
  const body = /** @type {{ workflow_runs?: Run[] }} */ (await res.json());
  const run = matchingRun(body.workflow_runs ?? [], { sha, repo });
  if (run && env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run_id=${run.id}\n`);
  console.log(run ? `ci run ${run.id} passed ${sha}` : `no successful ci.yml push run for ${sha}`);
} else if (command === "done") {
  const { reused, line } = outcome(env.RUN_ID, env.PUT, env.GITHUB_SERVER_URL, env.GITHUB_REPOSITORY);
  if (reused && env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "reused=true\n");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### deploy path\n\n${line}\n`);
  console.log(line);
} else if (command) {
  throw new Error("usage: node tools/ci-reuse.mjs find|done");
}
