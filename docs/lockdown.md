# Lockdown

How the owner cuts cost or locks the service from the GitHub phone app or a Mac, without the Cloudflare dashboard. Why a workflow plus a script, what they replace and how to remove them: `docs/adr/0030-lockdown.md`. The rung table is `tools/lockdown-rungs.json`; the script is `tools/lockdown.mjs`; the workflow is `.github/workflows/lockdown.yml`. Switch names, values and what each one stops are owned by the [spend guard doc](spend.md); this page never restates them.

This lands after the settings table and the spend guard (streams F and G): L1 to L3 write rows those streams read. L4 and L5 need neither.

Nothing here deletes anything. No rung deletes the Worker, a Durable Object class, a bucket, a database or any data, and none deploys a script (a deploy without the Durable Object classes erases their storage). The script refuses such a request in code (`assertSafeCall`) and a test pins it.

## Rungs

Each rung is one tap in the workflow or one command on a Mac. Every rung first freezes deploys (disables the deploy workflow), because a push to main re-applies `wrangler.jsonc` and would drop a dashboard variable and re-enable workers.dev. A rung that changes a switch writes a `setting` row, which a later deploy keeps, and one `admin_action` line with the actor `lockdown`. When D1 itself fails, the run prints the matching Worker variable floors to set by hand and commit.

### L1

One switch for one meter, chosen with the meter input or `--meter`. Keeps everything else. The choices are the switches listed under L1 in the rung table.

### L2

Every costly switch at once (the seven the budget stop flips). Keeps the site, the demo deck, live presenting, sign-in with a passkey and downloads of existing files.

### L3

L2, plus the video stage and email off, and every running Workflow instance terminated. Terminating loses conversion progress only; the original files stay. Printed by hand: lower the Workers and Durable Objects spend limits, remove the presign token, check Containers and logs.

### L4

Off the routes, data kept. A block rule on the zone (kept when undone, never deleted) and workers.dev off. The admin panel goes dark too, so switches are set with this tool or the D1 console. Crons keep running.

### L5

L4, plus every cron trigger cleared. Revoking tokens is printed as manual steps, last: a token cannot safely revoke itself, and a revoked deploy token ends this tool.

## Run it from the phone

1. GitHub app, the repository, Actions, lockdown, Run workflow.
2. Pick the level (and the meter for L1). Leave apply unticked first: the run prints the exact plan in its job summary and changes nothing.
3. Run it again with apply ticked.

The workflow runs only from main and uses the repository secrets the deploy workflow uses (the Cloudflare token and account), plus the run's own token with `actions: write` to disable the deploy workflow. The workflow must be on the default branch to appear as a workflow_dispatch target.

## Run it from the Mac

```
export CLOUDFLARE_API_TOKEN=...   # from the password manager; never typed into a file
export CLOUDFLARE_ACCOUNT_ID=...
node tools/lockdown.mjs --level L2             # dry run: prints the plan
node tools/lockdown.mjs --level L2 --apply
node tools/lockdown.mjs --level L1 --meter uploads --apply
```

Run it from a checkout of main. Without `GITHUB_TOKEN` and `GITHUB_REPOSITORY` the freeze is printed as a step to do by hand (Actions, deploy, the ... menu, Disable workflow). Neither credential is ever printed.

## Undo

`--undo` (the undo input) reverses a rung, and a second run changes nothing.

- Rows go back to their defaults, and only rows this tool wrote: a row the breaker or the owner set since stands. A latched breaker also needs its reset in the admin panel.
- Deploys are enabled again. Undo L1 to L3 only after any L4 or L5 is undone, because an unfrozen deploy re-enables workers.dev.
- L4: the block rule is disabled (kept) and workers.dev is turned on.
- Not undoable by this tool: terminated Workflow instances (users re-run), cleared crons (enable the deploy workflow and run it: a deploy recreates them), lowered spend limits and revoked tokens (by hand).

## Token permissions

The workflow's Cloudflare token is the deploy token. It already holds Workers Scripts Edit and D1 Edit (the deploy workflow uses both). Beyond that:

| rung | extra permission | why |
|---|---|---|
| L1, L2, L3 | none | D1 rows, and Workflow instances (list needs Workers Scripts Read or Write, terminate needs Workers Scripts Write; checked against the API spec) |
| L4, L5 | Zone Read and Zone WAF Edit on the zone | the block rule |
| all, in the workflow | `actions: write` on the run's own token | freeze deploys |
| L5 by hand | whatever revokes each token | the owner's own sign-in |

A separate token scoped to just these permissions, kept in the password manager, works from any machine and is the better break-glass credential; GitHub itself being the problem is the case this workflow cannot help with.
