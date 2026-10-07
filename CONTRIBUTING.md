# Contributing to ISL

ISL is not a library: it is an **autonomous control plane** that opens worktrees, runs code, scores
diffs and writes commits. Contributing to it almost always means touching something that decides, on
its own, whether a change gets committed or rolled back. This document describes how work actually
happens here — startup, tests, the dashboard and the gate convention — not how work happens on some
generic project.

Before opening a PR it is worth reading the [README](README.md) for the architecture and `ISL.md`
for the detail of the individual subsystems.

---

## 1. Environment

| Requirement | Why |
|---|---|
| Node **>= 22.5** | ISL uses the built-in `node:sqlite` module. On an earlier version it will not start. |
| [Ollama](https://ollama.com) running locally | Every agent and every LLM grader goes through it. Default model `qwen3.6:latest`. |
| `ollama pull nomic-embed-text` | Optional. Enables vector search in the knowledge index; without it the index stays lexical (BM25). |
| Git | The iteration engine creates real worktrees: without a git checkout there is no sandbox. |

```bash
npm run setup          # backend + dashboard dependencies
cp .env.example .env   # then open .env and fix the values
npm run doctor         # preflight: node, repo, node_modules, Ollama, sandbox
```

`npm run doctor` is the first command to run when something is wrong: it checks the external
dependencies for real — it creates and destroys an actual sandbox instead of simulating one — so you
find out what is missing right away, not halfway through a run.

---

## 2. Startup — `supervisor.mjs`, not `src/server.js`

```bash
npm run serve   # = node supervisor.mjs   -> http://localhost:7878
```

**Use `npm run serve`.** The supervisor is the part that keeps ISL up: it restarts the server within
a few seconds on any exit, it has an anti crash-loop guard with backoff, and it treats the memory
watchdog's clean exit (code 0, emitted before the OOM) as a normal restart. The loop's desired state
is persisted, so the loop resumes on its own in the new process.

`npm start` launches `src/server.js` directly, **without** automatic restart. It is only useful when
you want a crash to stay down instead of being absorbed — that is, when you are debugging the crash
itself. It is not how ISL is meant to run.

For backend work:

```bash
npm run dev     # node --watch src/server.js
```

On first access: email `ADMIN_EMAIL` (default `admin@example.com`) and any password of at least 8
characters — the first sign-in *sets* that password and claims the account.

---

## 3. The dashboard is built separately

The dashboard is a separate application in `dashboard/` (React + Vite + Tailwind). The backend
serves `dashboard/dist`, and **`dashboard/dist/` is in `.gitignore`**: there is no build in the
repository. The bundle you see in the browser is the one you built yourself.

```bash
npm run dashboard:build   # rebuilds dashboard/dist — this is what the backend serves
```

The practical consequence, and the most common cause of "I changed the file and nothing happens":
**every change under `dashboard/src/` requires a rebuild.** Restarting the backend does not rebuild
the dashboard.

In development use the hot-reload dev server instead, which proxies to the API:

```bash
npm run serve       # backend on :7878
npm run dashboard   # vite on :5273  <- open this one
```

---

## 4. Tests

```bash
npm test                        # backend — node:test over test/*.test.js
cd dashboard && npx vitest run  # dashboard — vitest + testing-library
npm run test:all                # both
npm run check:routes            # does every endpoint the dashboard calls exist on the server?
```

`npm run check:routes` reports in two directions. `MISSING`: the dashboard calls a route the server
does not serve — always a defect, and an insidious one, because the client's error path renders an
empty state, so it looks like "there is no data" instead of a bug. `UNUSED`: the server serves
something no call reaches — often legitimate, since there are routes for the agents and for the chat
layer, so it is reported and does not fail the check.

Two tests are not ordinary unit tests but **structural guards**, and both exist because the failure
they catch had already reached production. If you touch them, start here:

- `dashboard/src/undefined-refs.test.js` — no linter is configured and Vite compiles JSX without
  resolving identifiers, so a component or hook that is used but never imported *builds* and only
  throws when a user opens that page. It has happened three times.
- `test/composeSafety.test.js` — reads the source of `src/runtime/compose.js` and fails if a compose
  command carries `-v` or `--volumes`. That flag deletes the database volume and, unlike everything
  else the runtime can do, has no undo.

A test that reads the source instead of running it is a deliberate choice: for a rule of this kind,
the only reliable check is to forbid the string.

---

## 5. The deterministic gate convention

LLM graders assign scores. **Gates** forbid. These are two different things, and the difference is
the heart of the project: the weighted average of the scores has already been beaten by arithmetic.
A review score of 55 on a change that deleted search personalization was overridden because review
weighs 0.2 and the total still came out above the rollback threshold. Hence the rule: **whatever
must stop a change cannot be one term in an average.**

A gate lives in `src/iteration/` (`intentGate.js`, `schemaGuard.js`, `safetyGate.js`,
`securityGate.js`, `scopeGate.js`, `conflictGate.js`, `behaviourGate.js`, …) and is wired into
`src/iteration/engine.js`. If you write a new one, five rules follow.

**1. No LLM.** A gate is deterministic: same diff, same verdict, every time. It takes the task
and/or the diff and returns a `{ veto, summary, findings }` shape (or `violations`). No model calls,
no heuristics that depend on sampling.

**2. A gate comes from a real failure, and the file tells the story.** Every existing gate opens
with a comment naming the concrete run that motivated it and the damage that run did:
`schemaGuard.js` tells the story of run #91, the field added to a model without a migration and the
500s that showed up weeks later; `intentGate.js` tells the story of run #426 and the search bar that
disappeared. This is not decoration: it is what stops someone from softening the rule six months
from now without knowing what they are reopening. If you cannot point to the change that passed and
should not have, you probably do not need a gate.

**3. Two tests, not one.** In `test/`, add the diff that broke things as a fixture and assert the
veto — then assert that the rule does **not** fire on the legitimate version of the same operation.
See `test/intentGate.test.js`: a deletion disguised as a fix is forbidden, a deletion the task asked
for explicitly passes. A gate that produces false positives gets turned off, and that is worse than
a gate that does not exist.

**4. Stay narrow.** The rule covers what it can prove, not what it suspects. `schemaGuard` handles
*added* fields without a migration and deliberately ignores removed ones: that is a different
operation, usually intentional, and Prisma tolerates a table with columns the model does not name.

**5. Modes, and you land in `advisory`.** The modes are `off` / `advisory` / `enforce`, read from
the active project's settings with `getSetting` (for example `scopeGate.mode`, default `advisory`),
not from environment variables — so they can be changed at runtime from the dashboard and per
project. A new gate lands in `advisory`: first you watch it record what it would record on real
runs, then you move it to `enforce`.

---

## 6. Code and PR conventions

- **Pure ESM** (`"type": "module"`), native Node. Dependencies are few and deliberate: before
  adding one, check that the standard library does not already solve it.
- **No target-project value read at boot time.** Everything that concerns the code being improved
  goes through the live bindings in `src/config.js` and the swappable DB handle in `src/db.js`,
  because the active project changes at runtime. A constant captured at import time breaks
  multi-project support silently.
- **Comments**: Italian and English coexist in the codebase. Write in the language of the file you
  are changing, and keep technical terms in English. What matters is that the comment explains
  *why*: the code already says *what* it does.
- **One commit, one reason.** The message says why, not which lines changed.
- **Do not commit**: `.env`, `.data/`, `dashboard/dist/`, the local SQLite databases. They are
  already in `.gitignore`; if you need something excluded to be in the repository, do not remove the
  line from `.gitignore` before checking that it holds no secrets and no data from a real project.
- Before opening the PR: `npm run test:all` and `npm run check:routes` green, and the
  [PR template](.github/pull_request_template.md) filled in.

---

## 7. Before a non-trivial change

Open an issue and describe what you want to change. ISL makes autonomous decisions about other
people's code: a change to a gate, to the iteration engine or to promotion changes *what gets
committed without human supervision*, and that is worth discussing before writing it.

This project is maintained in spare time: there are no guaranteed response times on issues and PRs.
If a proposal sits untouched, that is not a verdict — and a fork is a perfectly legitimate outcome;
the AGPL is there for that too.

## License of contributions

ISL is distributed under **AGPL-3.0-only** (see [LICENSE](LICENSE)). By opening a PR you agree that
your contribution is distributed under the same license.

The [Code of Conduct](CODE_OF_CONDUCT.md) applies to interactions on the repository. For
vulnerabilities, do **not** use the public issues: see [SECURITY.md](SECURITY.md).
