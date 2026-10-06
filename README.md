# ISL — Improvement Software Loop

An autonomous, **multi-project** software-improvement control plane. ISL points a fleet of
specialist AI agents (security, tests, performance, quality, frontend, services, workbench) and a
layer of supervisory managers at *any* code folder, iterates on it in a sandbox, proves the app
still boots, and lands the change — all from an enterprise dashboard behind a login.

It is the evolution of a single-product agent control plane into a reusable platform: the same agents,
the same managers, the same dashboard — plus everything below.

## What's new over the base control plane

| Capability | What it does |
|---|---|
| **Multi-project** | A project registry (`platform.db`). Each project has its **own** SQLite database under `.data/projects/<id>/`, its own detected layout (repo root, base branch, product dirs) and its own agents. Switch the active project at runtime from the dashboard — no restart. |
| **Auth & access** | Login panel, scrypt-hashed passwords, opaque session cookies. The seeded admin (`ADMIN_EMAIL`) claims its password on first sign-in. Every `/api/*` route and the WebSocket are gated. |
| **Admin panel** | Admin-only: user management (invite / role / enable-disable / reset / delete), a platform audit trail, and an overview. Invited users are `pending` until they claim their password. |
| **Context Manager** | Reads **all** project documents (`.md .pdf .docx .doc .txt .rst .adoc …`) across the folder tree, derives a grounded project profile (what it is, objective, stack, key flows, glossary) and asks **≤10 targeted questions** — auto-answering from the docs where it can, asking you only the genuine gaps. The context is injected into every agent's prompt. |
| **Doc agents** | `doc-verifier` finds coverage gaps, drift and stale docs (broken path references + an LLM pass). `doc-updater` re-checks documentation whenever work is merged to the base branch and flags what needs updating. |
| **Reliability Manager** | Watches the fleet's **own** failures: clusters recurring errors, detects anomalies (repeated failures, no-output runs, verification collapse), scores fleet reliability, and distils concrete improvement signals (deterministically + an on-demand LLM advisor). |
| **Deterministic guardrails & code intelligence** (2026-07) | A no-LLM layer that guards every change and aims the fleet: **security/safety/dead-code/refactor/change-size vetoes**, **blast-radius** reverse-dep analysis, a **human review queue with per-agent trust**, **structural / coverage / health / dependency-CVE / frontend-a11y** scans that seed the backlog, an **interactive refactor dry-run**, **regression bisect & revert**, **flaky-test detection**, a **hybrid (BM25 + `nomic-embed-text` vector) knowledge index / RAG**, **cross-project learning transfer**, **digest reports**, and **scheduled quiet-hours improvement windows**. See ISL.md §28. |
| **Closing the loop** (2026-07, wave 2) | The layer above now *acts*: **rejection-driven learning** (a human "no" becomes a durable pitfall and costs the agent its trust), **auto-bisect on a pre-existing failure** (a change is never blamed for a break it didn't cause), **CVE auto-remediation** (computes the semver-safe upgrades, in isolation, never touching your checkout), a **unified impact ranking** ("fix these first"), **`search_knowledge` as an agent/Alfred tool** + **"find a similar past change"**, **auto-changelog**, **backlog dedup**, **health-gated autonomy** (auto-land suspends while health drops), and **trust-gated auto-promotion** (earned commits fast-forward, contiguous prefix only, off by default). |
| **Intent, review-floor & schema gates** (2026-08, wave 3) | Three vetoes added after four landed changes broke the target application. **Intent**: a task that says it will add or fix `X` and produces a diff where `X` is deleted and never re-added is rolled back. **Review floor**: a review score below `review_floor` (default 70) is disqualifying on its own — the weighted average gave review a weight of 0.2, so a review of 0 still totalled 79 against a threshold of 60. **Schema**: a Prisma model field added with no migration in the same change is a column that will not exist. All four historical breakages are blocked by these; see ISL_IMPROVE §"The four changes that broke the target app". |
| **Planner candidate selection** (2026-08) | Failures now *divide* a candidate's weight instead of merely breaking ties between equal ones, plus a cooldown on targets that failed in the last few runs. Before: the same high-weight function was planned in four consecutive runs, failing each time. |
| **Backlog claim recovery** | A run reserves what it works on and an interrupted run never releases it, while the planner only ever picks `pending` — so every interruption permanently shrank the pool. `GET /api/backlog/claims` reports what is reserved with no run behind it; `POST /api/backlog/reclaim` hands it back without deleting anything. |
| **Schema integrity agent** | Prisma validates a field against the real table only when a query runs, so a mismatched schema passes every gate and fails in production. This agent compares every model against the live database's `information_schema` after each commit and on demand. Strictly read-only: it issues no DDL and edits no `.prisma` file. |
| **Runtime: per-container control + schema tab** | Stop / start / restart / rebuild one service instead of the whole stack, and a read-only view of every Prisma schema with the integrity verdict. Containers started outside ISL are adopted rather than ignored. No compose invocation may carry `-v`: the code refuses it, and a test over the source enforces it. |
| **Durable event history** | The list of event types persisted to the DB had never moved past the agent era — no `iteration.*`, no `impl.*` — so a run's history existed only as a WebSocket broadcast and vanished on reload. The pipeline events are now stored, and the Flow view reads a history instead of watching one go by. |
| **Uptime supervisor** | The server runs under `supervisor.mjs` (`npm run serve`): it auto-restarts within seconds on any exit, a memory watchdog exits cleanly before OOM, and the loop auto-resumes — so ISL stays up for days, not hours. |

## Architecture

```
src/
  config.js            active-project config via live bindings (repo root, dirs, branch)
  db.js                per-project SQLite handle behind a Proxy — openProjectDb() swaps it
  db_iteration.js      iteration/backlog/kpi schema (registered per project)
  platform/
    platformDb.js      projects + users + sessions + audit (the shared platform DB)
    projects.js        project registry CRUD
    users.js           scrypt auth, sessions, claim-on-first-login
    activeProject.js   the runtime switch: config + DB + agent re-seed
    authMiddleware.js  cookie auth + requireAuth / requireAdmin + WS gate
    routes.js          auth / projects / admin API
    featureRoutes.js   context / reliability / guardrails / intelligence API
  core/                decisionNetwork, trust, reviewQueue, crossProject, improvementWindows, scheduler
  context/             ingest, extraction, Context Manager + doc agents, knowledgeIndex (RAG)
  reliability/         error store, Reliability Manager + advisor
  managers/            13 managers (incl. Context + Reliability)
  iteration/           engine + graders + the deterministic scans (blast/coverage/health/structural/
                       refactorPlan/changeBudget/frontendAudit/bisect/flaky/digest/securityGate/safetyGate)
                       intentGate.js   did the diff do what the task said it would?
                       schemaGuard.js  a schema field added without a migration
  runtime/             compose.js (per-service control, refuses volume-destroying flags)
                       schemaAgent.js  model-vs-database integrity, read-only
  agents/, sandbox/, services/, deploy/             the improvement engine (deploy incl. depScan)
supervisor.mjs         auto-restarting process supervisor (npm run serve)
dashboard/             React + Vite + Tailwind enterprise dashboard
  src/merged.js            route aliases: pages folded into tabs keep their old URLs
  src/components/TabbedView.jsx   the tab shell — renders existing views unchanged
  src/undefined-refs.test.js      guard: a JSX component or hook used but never imported
```

The key move is that **nothing about the code being improved is a boot-time constant**. Every
project-specific value is a live binding reassigned by `setActiveProjectConfig()`, and the DB is a
swappable handle — so switching the active project re-points the entire runtime.

## Requirements

- Node ≥ 22.5 (uses the built-in `node:sqlite`)
- [Ollama](https://ollama.com) running locally with the configured model (default `qwen3.6:latest`)

## Run

```bash
npm run setup            # install backend + dashboard deps
npm run dashboard:build  # build the dashboard (served by the backend)
npm run serve            # http://localhost:7878 — via the auto-restarting supervisor (recommended)
# npm start              # run the server directly (no auto-restart)
```

First sign-in: use `ADMIN_EMAIL` (default `admin@example.com`) and any password ≥ 8
chars — that sets the admin password and claims the account. Then open **Context → Build context**
to onboard the active project, and **Projects** to add more code folders.

Dev (hot-reload dashboard on :5273, proxying the API):

```bash
npm run dev            # backend with --watch
npm run dashboard      # vite dev server
```

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `7878` | HTTP + WebSocket port |
| `ADMIN_EMAIL` | `admin@example.com` | Seeded admin account |
| `AUTH_SECRET` | dev secret | Session cookie secret — set in production |
| `SESSION_TTL_HOURS` | `168` | Session lifetime |
| `DEFAULT_PROJECT_PATH` | — | Code folder for the seeded first project — point it at the codebase you want ISL to start from. There is no portable default: set it on a fresh install. |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | `127.0.0.1:11434` / `qwen3.6:latest` | LLM backend |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model for the knowledge index's vector search (empty = lexical-only). `ollama pull nomic-embed-text` to enable. |
| `ISL_MEM_LIMIT_MB` | `1400` | RSS at which the memory watchdog restarts the server cleanly |

Roles: **admin** (everything, incl. the admin panel and project management), **user** (operate the
loop, switch projects, answer context questions), **viewer** (read-oriented).

## Tests

```bash
npm test                       # backend — node:test
cd dashboard && npx vitest run # dashboard — vitest + testing-library
```

Two of these are structural guards rather than ordinary unit tests, and both exist because the
failure they catch had already shipped:

- `dashboard/src/undefined-refs.test.js` — there is no linter configured, and Vite compiles JSX
  without resolving identifiers, so a component or hook used but never imported builds cleanly and
  throws only when a user opens that page. It has happened three times.
- `test/composeSafety.test.js` — reads `src/runtime/compose.js` and fails if any compose command
  carries `-v` or `--volumes`. That flag deletes the database volume, and unlike everything else
  the runtime can do, it has no undo.

## Licenza

ISL è distribuito sotto **GNU Affero General Public License v3.0**. Il testo completo è in
[LICENSE](LICENSE).

In breve, e senza che questo sostituisca la licenza: sei libero di usare, studiare, modificare e
ridistribuire ISL. Se lo modifichi e lo rendi disponibile ad altri — anche soltanto facendolo girare
come servizio accessibile in rete, senza distribuirne una copia — devi offrire a chi lo usa il codice
sorgente della tua versione. È la clausola che distingue l'AGPL dalla GPL (sezione 13), ed è
deliberata: ISL è un piano di controllo che si usa attraverso un'interfaccia web, e senza quella
clausola chiunque potrebbe offrirlo come servizio chiuso senza restituire nulla.

    ISL — Improvement Software Loop
    Copyright (C) 2026  mrbot0

    This program is free software: you can redistribute it and/or modify it under the terms of
    the GNU Affero General Public License as published by the Free Software Foundation, either
    version 3 of the License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
    without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
    See the GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License along with this
    program. If not, see <https://www.gnu.org/licenses/>.
