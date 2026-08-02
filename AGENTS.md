# AGENTS.md

## Cursor Cloud specific instructions

QuickOrder (Mobile-Order-System) is a **build-less static web app**: plain HTML + CSS + ES
modules, with the Firebase JS SDK loaded from a CDN (`js/firebase.js`) and a few Cloudflare
Pages Functions under `functions/api/`. There is **no bundler, no build step, and no
`package.json` / `node_modules`** (the Node helper scripts under `scripts/` use only Node
built-ins such as `fetch`). Product/architecture details live in `docs/specification.md` and
`docs/autonomy.md`.

### Running locally

- Full stack (recommended): `npx --yes wrangler@4 pages dev . --port 5000 --ip 0.0.0.0 --compatibility-date=2026-07-30`
  This serves the static pages **and** the `functions/api/*` endpoints (`/api/cardinal`,
  `/api/maintenance`, `/api/notify`), and applies `_redirects`. First run downloads wrangler.
- Static only: `python3 -m http.server 5000` (this is what `.replit` uses). The `/api/*`
  endpoints will 404 in this mode — use `wrangler pages dev` if you need the functions.

### Guest ordering / testing without touching production

- The public Firebase config in `js/firebase.js` points at the **live** Firestore project
  `mobile-order-system-c7c70`. To exercise the guest flow without writing real data, append
  `?demo=1` (e.g. `http://127.0.0.1:5000/?demo=1`). In demo mode orders are kept in
  `sessionStorage` (IDs prefixed `DEMO-`) and never hit Firestore.
- The `/api/*` functions answer public `GET` (and `POST {action:"status"}`) without secrets.
  Privileged POST actions require an `X-Ops-Secret` header plus Cloudflare secrets
  (Discord/Cursor webhooks) that are not present locally, so those paths are expected to be
  unauthorized/no-op in a local dev VM.

### Lint / test / build

- There is **no lint, unit-test, or build tooling** in this repo. CI
  (`.github/workflows/deploy-cloudflare-pages.yml`) only deploys to Cloudflare Pages and then
  runs a canary probe; there is no lint/test job.
- JS syntax sanity check (lint-equivalent): `node --check <file>` (works on every `.js`/`.mjs`).
- Smoke/"integration" check against a running server: `scripts/canary-probe.mjs`. Point it at
  the local dev server with `BASE_URL=http://127.0.0.1:5000 node scripts/canary-probe.mjs`; it
  verifies the guest/ops/store/status pages, key CSS/JS assets, and the three `/api/*`
  endpoints, printing `CANARY_OK` on success.
