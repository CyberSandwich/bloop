# ADR 0031: deploy ships the dist/ CI already passed

Status: accepted

## Context
A commit reaches `main` only through `tools/land.mjs`, after its `ci/` branch run is green, and the tool pushes that exact commit. `deploy.yml` then ran `npm run check` again on the same tree, about 10 minutes before a landed commit was live.

## Decision
- **A token-free `reuse` job runs first.** It holds no secret and no environment, installs nothing, and reads only `contents` and `actions`. `tools/ci-reuse.mjs find` asks the API for a run of this repository's `.github/workflows/ci.yml`, on a `push`, for exactly `github.sha`, that completed with success in every job. A sha fixes the whole tree, `ci.yml` included, so that run built this commit with this workflow. A `pull_request` run never counts: it builds the merge commit, not its head.
- **Provenance and integrity are both required.** The run match proves where `dist/` came from; `tools/prebuilt.mjs assert` proves the downloaded `dist/` equals its manifest. Neither alone is enough: a matching run says nothing about bytes altered after download, and a manifest says nothing about which run wrote it. Only after both does the job upload that `dist/` as this run's artifact and set `reused`.
- **Anything else is the full check.** No match, an expired artifact (retention is 1 day), a failed download, assert or upload: `reused` stays unset and `check` runs as before. The `deploy` job is unchanged apart from its `needs` and `if`: same environment, concurrency group, token step and `prebuilt-dist` action, which still fills the image digest and account into `wrangler.jsonc` (those live in the config, not in `dist/`). The run summary names the path taken.
- **Trust is unchanged.** Both check jobs run third-party code with no token; `ci.yml`'s runs `npm ci` with install scripts where `deploy.yml`'s uses `--ignore-scripts`, and neither holds a secret. The Worker code still comes from the token job's own checkout.

## Replaces
The second `npm run check` on a landed commit. A push to `main` that did not pass CI first (none should) still gets it.

## Remove
Delete the `reuse` job, set `check` back to no `needs` and no `if`, `deploy` back to `needs: check`, and drop the check upload's `overwrite`; delete `tools/ci-reuse.mjs`, `test/unit/ci-reuse.test.ts` and this ADR, and restore the token-jobs pin.
