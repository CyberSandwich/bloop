// deploy.yml's reuse job: finds the ci.yml push run that already passed this exact commit, so the deploy ships that
// run's dist/ instead of running the check again (ADR 0031). Imports nothing third-party and holds no secret.
//   node tools/ci-reuse.mjs digest  in ci.yml's check job, after the manifest: logs the manifest's SHA-256
//   node tools/ci-reuse.mjs find    writes run_id and manifest_sha256 to $GITHUB_OUTPUT when a run matches and its
//                                   check job's own log names the digest, and says why not otherwise
//   node tools/ci-reuse.mjs verify  the downloaded manifest hashes to EXPECT
//   node tools/ci-reuse.mjs done    sets reused=true only when that run's dist/ was downloaded, asserted, verified and
//                                   re-uploaded (PUT=success), and writes which path ran to the job summary
// The run match and the check job's log prove where dist/ came from (another job in that run can replace an artifact,
// but not write the check job's log); `prebuilt.mjs assert` proves it intact. Neither alone is enough.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST } from "./prebuilt.mjs";

export const CI_PATH = ".github/workflows/ci.yml";
export const CHECK_JOB = "check";
export const DIGEST_STEP = "Manifest digest for deploy reuse";
/** The step's own output line: nothing before it but the runner's timestamp, so an echoed command never counts. */
const DIGEST_LINE = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?dist manifest sha256: ([0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * @typedef {{ id: number, head_sha: string, event: string, status: string, conclusion: string | null, path: string,
 *   repository?: { full_name?: string }, head_repository?: { full_name?: string } | null }} Run
 * @typedef {{ id: number, name: string, conclusion: string | null, steps?: { name: string, conclusion: string | null }[] }} Job
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

/** The id of the run's one passed `check` job whose digest step passed, or undefined.
 * @param {Job[]} jobs @returns {number | undefined} */
export function checkJobId(jobs) {
  const named = jobs.filter((job) => job.name === CHECK_JOB);
  const job = named.length === 1 ? named[0] : undefined;
  const logged = job?.steps?.some((step) => step.name === DIGEST_STEP && step.conclusion === "success");
  return job?.conclusion === "success" && logged ? job.id : undefined;
}

/** The line the digest step logs. @param {string} hex */
export const digestLine = (hex) => `dist manifest sha256: ${hex}`;

/** The digest in a check job's log: exactly one digest line, or undefined. @param {string} log */
export function digestFrom(log) {
  const hits = log.split(/\r?\n/).flatMap((line) => DIGEST_LINE.exec(line)?.[1] ?? []);
  return hits.length === 1 ? hits[0] : undefined;
}

/** SHA-256 of dir's manifest file, byte for byte. @param {string} dir */
export const manifestDigest = (dir) =>
  createHash("sha256")
    .update(readFileSync(join(dir, MANIFEST)))
    .digest("hex");

/** What the reuse job decided, for the job summary and the `reused` output.
 * @param {string | undefined} runId @param {string | undefined} put @param {string | undefined} server @param {string | undefined} repo */
export function outcome(runId, put, server, repo) {
  if (runId && /^\d+$/.test(runId) && put === "success")
    return {
      reused: true,
      line: `Reused dist/ from ci run ${server}/${repo}/actions/runs/${runId}; the check job is skipped.`,
    };
  const why = runId
    ? `ci run ${runId} matched but its dist/ did not pass the download, assert, digest or upload`
    : "no ci run matched with its check job's digest";
  return { reused: false, line: `Full check: ${why}.` };
}

const command = process.argv[1]?.endsWith("ci-reuse.mjs") ? process.argv[2] : undefined;
const env = process.env;
if (command === "digest") {
  console.log(digestLine(manifestDigest("dist")));
} else if (command === "find") {
  const sha = env.GITHUB_SHA ?? "";
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("GITHUB_SHA or GITHUB_REPOSITORY is malformed");
  /** Authorization is dropped on the log's cross-origin redirect, as fetch does for any. @param {string} path */
  const api = (path) =>
    fetch(`${env.GITHUB_API_URL}/repos/${repo}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
    });
  const query = new URLSearchParams({ head_sha: sha, event: "push", status: "success", per_page: "100" });
  const res = await api(`/actions/workflows/ci.yml/runs?${query}`);
  if (!res.ok) throw new Error(`the ci.yml runs list answered ${res.status}`);
  const run = matchingRun(/** @type {{ workflow_runs?: Run[] }} */ (await res.json()).workflow_runs ?? [], {
    sha,
    repo,
  });
  if (!run) {
    console.log(`no successful ci.yml push run for ${sha}`);
    process.exit(0);
  }
  const jobs = await api(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  if (!jobs.ok) throw new Error(`the jobs list of ci run ${run.id} answered ${jobs.status}`);
  const jobId = checkJobId(/** @type {{ jobs?: Job[] }} */ (await jobs.json()).jobs ?? []);
  if (jobId === undefined) {
    console.log(`ci run ${run.id} has no passed ${CHECK_JOB} job with the step "${DIGEST_STEP}"`);
    process.exit(0);
  }
  const log = await api(`/actions/jobs/${jobId}/logs`);
  if (!log.ok) throw new Error(`the log of check job ${jobId} answered ${log.status}`);
  const digest = digestFrom(await log.text());
  if (!digest) {
    console.log(`the log of check job ${jobId} does not name exactly one manifest digest`);
    process.exit(0);
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run_id=${run.id}\nmanifest_sha256=${digest}\n`);
  console.log(`ci run ${run.id} passed ${sha}; its check job ${jobId} logged manifest ${digest}`);
} else if (command === "verify") {
  const expected = env.EXPECT ?? "";
  const actual = manifestDigest("dist");
  if (!HEX64.test(expected) || actual !== expected)
    throw new Error(`dist/ manifest is ${actual}, not the ${expected || "(none)"} its check job logged`);
} else if (command === "done") {
  const { reused, line } = outcome(env.RUN_ID, env.PUT, env.GITHUB_SERVER_URL, env.GITHUB_REPOSITORY);
  if (reused && env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "reused=true\n");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### deploy path\n\n${line}\n`);
  console.log(line);
} else if (command) {
  throw new Error("usage: node tools/ci-reuse.mjs digest|find|verify|done");
}
