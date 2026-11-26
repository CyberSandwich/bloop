# ADR 0031: deploy ships the dist/ CI already passed

Status: accepted

## Context
A commit reaches `main` only through `tools/land.mjs`, after its `ci/` branch run is green, and the tool pushes that exact commit. `deploy.yml` then ran `npm run check` again on the same tree, about 10 minutes before a landed commit was live.

## Decision
- **A token-free `reuse` job runs first.** It holds no secret and no environment, installs nothing, and reads only `contents` and `actions`. `tools/ci-reuse.mjs find` asks the API for a run of this repository's `.github/workflows/ci.yml`, on a `push`, for exactly `github.sha`, that completed with success in every job. A sha fixes the whole tree, `ci.yml` included, so that run built this commit with this workflow. A `pull_request` run never counts: it builds the merge commit, not its head.
- **Provenance and integrity are both required.** Any job in a run can replace that run's artifacts, so the run match alone does not say which job wrote `dist/`. `ci.yml`'s check job logs the SHA-256 of its manifest file (`tools/prebuilt.mjs manifest`) in the step "Manifest digest for deploy reuse"; the reuse job reads that check job's own log (by job id from the run's jobs list, by name, with that step passed) and needs exactly one digest line there, equal to the downloaded manifest's hash. `tools/prebuilt.mjs assert` then proves the downloaded `dist/` equals that manifest. Neither alone is enough: a matching run and digest say nothing about the files beside the manifest, and a manifest says nothing about which job wrote it. Only after all three does the job upload that `dist/` as this run's artifact and set `reused`.
- **Anything else is the full check.** No match, no log or no single digest line in it, an expired artifact (retention is 1 day), a failed download, assert, digest or upload: `reused` stays unset and `check` runs as before. The `deploy` job is unchanged apart from its `needs` and `if`: same environment, concurrency group, token step and `prebuilt-dist` action, which still fills the image digest and account into `wrangler.jsonc` (those live in the config, not in `dist/`). The run summary names the path taken.
- **The same build as deploy's own check.** `ci.yml`'s check job installs with `npm ci --ignore-scripts`, as `deploy.yml`'s does, and runs the same steps; both run third-party test code with no secret. The browser job in that run (Playwright's install, Lighthouse) never writes `dist/`, and the digest check refuses a `dist/` it replaced. The Worker code still comes from the token job's own checkout.
- **Residual.** Trust rests on GitHub's guarantee that one job's log cannot be written by another job in the run. If that failed, the browser job's third-party code could ship a `dist/` it replaced.

## Replaces
The second `npm run check` on a landed commit. A push to `main` that did not pass CI first (none should) still gets it.

## Remove
Delete the `reuse` job, set `check` back to no `needs` and no `if`, `deploy` back to `needs: check`, and drop the check upload's `overwrite`; delete `ci.yml`'s digest step, `tools/ci-reuse.mjs`, `test/unit/ci-reuse.test.ts` and this ADR, and restore the token-jobs pin. `ci.yml`'s `--ignore-scripts` can stay.
