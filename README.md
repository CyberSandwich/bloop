# bloop

Open your own file on a shared screen, approved from your phone. The screen shows a code, your phone scans it, you pick one file and tap Approve, and the screen gets one short-lived link that dies when the session ends.

Runs on Cloudflare Workers (static assets, Durable Objects, D1, R2). Everything works locally with no Cloudflare account.

## Quickstart

Prerequisites: Node 24 or newer (`.nvmrc` pins the CI version) and npm.

```sh
npm ci
cp .dev.vars.example .dev.vars   # fake local secrets
npm run dev                      # http://127.0.0.1:8787
npm run check                    # typecheck, lint, unit and integration tests, html-validate, size limits
```

| command | does |
|---|---|
| `npm run dev` | applies `migrations/` to the local D1 (`predev`), then `wrangler dev` on 127.0.0.1:8787, state in `.wrangler/state` |
| `npm run typecheck` | `tsc` for the Worker, for tests and tools, and for the browser JS (JSDoc, `checkJs`) |
| `npm run lint` / `npm run format` | Biome check / check and fix |
| `npm test` | Vitest unit tests |
| `npm run test:int` | integration tests; each file starts its own `wrangler dev` on a free port. Timer tests set `TEST_TIMING=1` for short timings (tests only, refused off localhost; see architecture section 9) |
| `npm run test:e2e` | Playwright with axe (needs a browser; CI runs it, plus Lighthouse CI) |

## Try the demo locally

The demo needs no account and runs on the sample deck. With `npm run dev` running, open `http://127.0.0.1:8787` and click Try the demo, which opens `/s?mode=demo`: a demo screen with a live code. Scan it with a phone on the same network, or click Approve on This Device, check the two digits, tap Approve, and the screen shows the sample deck's slides in the page. `DEMO_ENABLED=false` in `wrangler.jsonc` (or `--var DEMO_ENABLED:false`) turns every demo route off, and the demo screen then says it cannot start.

## Docs

- Design system: [docs/design.md](docs/design.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Seam contracts: [docs/interfaces.md](docs/interfaces.md)
- Threat model: [docs/threat-model.md](docs/threat-model.md)
- Owner setup (Microsoft Entra app, switching to OneDrive): [docs/setup.md](docs/setup.md)
- Decisions: [docs/adr/](docs/adr/), starting with [0001 stack](docs/adr/0001-stack.md)

## License

[MIT](LICENSE)
