# Lockdown

How the owner cuts cost or locks the service from the GitHub phone app or a Mac, without the Cloudflare dashboard. Why a workflow plus a script, what they replace and how to remove them: `docs/adr/0030-lockdown.md`. The rung table is `tools/lockdown-rungs.json`; the script is `tools/lockdown.mjs`; the workflow is `.github/workflows/lockdown.yml`. Switch names, values and what each one stops are owned by the [spend guard doc](spend.md); this page never restates them.

This lands after the settings table and the spend guard (streams F and G). L1 to L3 write rows those streams read, so migration 0005 (the `setting` and `admin_action` tables) must be applied first; L4 and L5 need neither.

Nothing here deletes anything. No rung deletes the Worker, a Durable Object class, a bucket, a database or any data, and none deploys a script (a deploy without the Durable Object classes erases their storage). The script refuses such a request in code (`assertSafeCall`) and a test pins it. A redeploy never uses `--durable-objects-code-update-mode immediate`: it drops live sockets and resets a running conversion, and ADR 0012 keeps the 300 s default.

## First check: is a spend block active?

Every run, dry or applied, opens with one unauthenticated `GET /api/health` on the production host and puts the answer on the first line. A site that does not answer is either a Workers or Durable Objects spend block (what that stops is in [the spend guard doc](spend.md)), an L4 or L5 already in force, or an outage. The run still goes on, because its calls go to the Cloudflare API and not to the Worker. What it cannot do is lift a spend limit: that is the dashboard, Billing, Spend limits.

## Step 0: a leaked deploy token

If the Cloudflare deploy token is the incident, roll it in the dashboard first (the old value dies at once). Then run the ladder with the lockdown token below. If the lockdown token itself is the suspected leak, roll it and use the dashboard instead: this tool cannot help when its own credential is the problem. The same holds if GitHub is the problem.

## Rungs

Each rung is one tap in the workflow or one command on a Mac. Every set first freezes deploys: it disables the deploy workflow and cancels the deploy runs in progress or queued, because a push to main re-applies `wrangler.jsonc` and would drop a dashboard variable and re-enable workers.dev. A rung that changes a switch writes a `setting` row labeled `lockdown:L<n>`, which a later deploy keeps, and one `admin_action` line with the actor `lockdown` that records the value the row held before. All rows go in one `wrangler d1 execute` call: a single transaction, so one bad statement (migration 0005 not applied, say) fails every row, and the run then prints the matching Worker variable floors to set by hand and commit. Wrangler prints one result per statement. Raising a rung over an equal value only relabels the row to the higher level (no new log line), so undoing the lower rung later leaves it alone.

### L1

One switch for one meter, chosen with the meter input or `--meter`. Keeps everything else. The choices are the switches listed under L1 in the rung table.

### L2

Every costly switch at once (the seven the budget stop flips). Keeps the site, the demo deck, live presenting, sign-in with a passkey and downloads of existing files.

### L3

L2, plus the video stage and email off, and every live Workflow instance terminated (queued, running, paused and waiting, every page, checked again afterwards; a step fails if any is still live). Terminating loses conversion progress only; the original files stay. Printed by hand: lower the Workers and Durable Objects spend limits, remove the presign token, check Containers and logs.

### L4

Off the routes, data kept. A block rule on the zone (kept when undone, never deleted), workers.dev off and workers.dev previews off. The admin panel goes dark too, so switches are set with this tool or the D1 console. Crons keep running.

### L5

L4, plus every cron trigger cleared. Revoking tokens is printed as manual steps, last: a token cannot safely revoke itself, and a revoked token ends this tool.

## Run it from the phone

1. GitHub app, the repository, Actions, lockdown, Run workflow.
2. Pick the level (and the meter for L1). Leave apply unticked first: the run prints the exact plan in its job summary and verifies the token without changing anything.
3. Run it again with apply ticked.

The workflow runs only from main and only when the repository owner starts it, set or undo alike, and appears as a workflow_dispatch target only once it is on the default branch. Its own token (`actions: write`) disables the deploy workflow and cancels its runs. A run that could not freeze deploys ends red with "DEPLOYS NOT FROZEN" at the top of its summary.

## Run it from the Mac

```
export LOCKDOWN_CF_TOKEN=...      # from the password manager; never typed into a file
export CLOUDFLARE_ACCOUNT_ID=...
node tools/lockdown.mjs --level L2             # dry run: prints the plan and checks the token
node tools/lockdown.mjs --level L2 --apply
node tools/lockdown.mjs --level L1 --meter uploads --apply
```

Run it from a checkout of main. Without `GITHUB_TOKEN` and `GITHUB_REPOSITORY` the freeze is printed as a step to do by hand (Actions, deploy, the ... menu, Disable workflow) and the exit code is 3. Exit codes: 0 done, 1 a step failed, 2 bad input or missing credentials, 3 done but deploys are not frozen (a set; headline "DEPLOYS NOT FROZEN") or could not be enabled (an undo; headline "DEPLOYS STILL FROZEN"). No credential is ever printed.

## Undo

`--undo` (the undo input) reverses a rung, and a second run changes nothing.

- Rows: an undo at level n touches only rows labeled `lockdown:L1` to `lockdown:L<n>`, and puts back the value each held before any lockdown touched it (the default when none was recorded). A row the owner or the breaker set since has another label and stands. So undoing L2 after L3 changes nothing, because L3 relabeled every row it holds; undo L3 to roll them back. A latched breaker also needs its reset in the admin panel.
- Remove any `SWITCH_` variable you set by hand (dashboard and `wrangler.jsonc`): a row never loosens a floor, and the undo prints the names.
- Deploys are enabled again. An L1 to L3 undo first reads the block rule and workers.dev, and skips the unfreeze, saying why, while L4 or L5 is still in force or when it cannot read them, because an unfrozen deploy turns workers.dev back on. Undo L4 first.
- L4: the block rule is disabled (kept), workers.dev is turned on, and previews go back to what `wrangler.jsonc` says.
- L5: the cron triggers are put back to the ones `wrangler.jsonc` lists.
- Not undoable by this tool: terminated Workflow instances (users re-run), lowered spend limits and revoked tokens (by hand).

## Tokens

The lockdown token is a separate Cloudflare API token, so the deploy token does not have to grow. It lives in the `production` environment as `LOCKDOWN_CF_TOKEN` (and a copy in the password manager), nowhere else. L1 and L2 may fall back to the deploy token, which already holds D1 Edit and Workers Scripts Write; L3 to L5 refuse to run without the lockdown token. The dry run calls the token verify endpoint, one read per permission, and a read-only `SELECT 1` through wrangler (so it proves the install without scripts works too), and prints "L4 WILL FAIL: token lacks X" for a refusal; a read cannot prove a write permission, so a rung can still fail on its write.

Permissions of the lockdown token, with the endpoint each covers (API token groups checked against Cloudflare's API schema):

| permission | dashboard name | endpoints |
|---|---|---|
| Zone Read | Zone, Zone, Read | `GET /zones` |
| Zone WAF Edit | Zone, Zone WAF, Edit (API group Zone WAF Write) | the zone ruleset entrypoint for the custom rules phase: GET and PUT; POST and PATCH on the ruleset's rules |
| D1 Edit | Account, D1, Edit (API group D1 Write) | what `wrangler d1 execute --remote` calls: GET the database list and POST the database query |
| Workers Scripts Write | Account, Workers Scripts, Edit | GET and POST `/workers/scripts/{name}/subdomain`; GET and PUT `/workers/scripts/{name}/schedules`; the Workflows instance list, batch terminate and status endpoints |

Scope the token to the account and the one zone, with no IP filter and a 1-year expiry. Workers Scripts Edit can upload scripts, so this token is as sensitive as the deploy token. Zone WAF Edit for the custom rules is as Cloudflare's guide states (developers.cloudflare.com/waf/custom-rules/custom-rulesets/). Beyond the deploy token, only L4 and L5 need more: Zone Read and Zone WAF Edit on the zone. Revoking tokens at L5 is by hand, with the owner's own sign-in.
