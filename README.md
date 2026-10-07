# ISL — Improvement Software Loop

**An autonomous system that improves other people's code and refuses to break what it touches.**

Point it at a directory of code — any language, any layout — and ISL reads it, decides what is worth
changing, writes the change in an isolated sandbox, puts it through a battery of checks, and lands it
**only if it passes all of them**. Your main branch and your working tree stay untouched until that
moment.

Version **2.0.0** · Node ≥ 22.5 · seven production dependencies (`express`, `ws`, `cors`,
`dotenv`, `diff`, `pdf-parse`, `mammoth`) · native SQLite, no ORM.

---

## The problem it solves

A language model can write a plausible change. It cannot tell whether the change works.

The difference between an assistant that suggests and a system you can leave running comes down to
one thing: what happens when the change is wrong **and looks right**. ISL is built around that
question. Every check described below exists because a specific defect got through, reached users,
and was reconstructed afterwards.

A few examples, all real and documented in the code:

| What got through | Why nothing stopped it |
|---|---|
| A file that does not compile | review is weighted 0.2 → the total stayed around 80 against a threshold of 60 |
| An entirely red test suite | tests are weighted 0.15 → total 83 |
| A search bar made unusable | the reviewer gave it **95 out of 100** |
| A field added to a schema with no migration | it compiles, the tests pass, the service starts |

From that comes the principle holding everything up: **a model's judgement is not a guarantee.**
Wherever a check can be mechanical, it is mechanical.

---

## How one iteration works

Ten phases, in sequence, inside a separate git worktree:

```
catalog → survey → plan → implement → review → security → regression → test → workbench → finalize
```

**`catalog`** catalogues the code as it really is: files, functions, complexity, hot spots.
**`survey`** looks for work worth doing, starting from evidence — real TODOs at real line numbers,
empty `catch` blocks, files with no tests, service-to-service seams with no timeout.
**`plan`** turns that evidence into small, verifiable tasks, each one declaring the files it touches.
**`implement`** runs the tasks (see *Working in parallel*).
**`review` · `security` · `regression` · `test`** judge the result from four different angles.
**`workbench`** is the phase that earns its place: it **actually starts the application** and rejects
the change if it no longer boots — the failure every unit test in the world sails past untouched.
**`finalize`** decides: commit or roll back.

### The gates

At the end the change meets **eleven deterministic vetoes**. None of them asks a model for an opinion:

`parse` (the file does not compile) · `test` (it broke a suite that used to pass) · `regression` (it
removed something public) · `security` · `scope` (an identifier that is used and bound nowhere) ·
`conflict` (unresolved merge markers) · `schema` (a field with no migration) · `intent` (the diff
does not match the task title) · `behaviour` · `dead-code` · `coverage`.

Next to them, the **per-dimension floors**. A weighted average answers *"how good is this overall"*;
committing is a different question: *"is there anything that disqualifies it on its own"*. An average
dilutes by construction — that is why a file that would not compile scored 80. A dimension below its
floor disqualifies the change whatever the total says, and the floors are configurable without
touching code.

---

## The agents

Thirteen specialists. They are not separate processes: they are **the personas the implementer puts
on** depending on the task, each with its own objective, its own file scope and its own leaning
toward strictness.

| Agent | What it looks for |
|---|---|
| 🛡️ **Security Auditor** | Authorization holes, injection, unvalidated input, exposed data |
| 🧪 **Test Engineer** | Coverage on untested branches, above all errors and edge cases |
| ⚡ **Performance Engineer** | N+1 queries, missing indexes, unbounded fetches, needless re-renders |
| 🧹 **Code Quality** | Duplication, dead code, error handling, naming |
| ♿ **Frontend / A11y** | Accessibility: names, keyboard reachability, focus, contrast |
| 🔗 **Services / Integration** | The seams between services: contracts, timeouts, retries, behaviour under failure |
| 🔧 **Workbench** | That the application starts, serves and builds — not that it passes tests |
| 🛟 **Resilience Engineer** | Timeouts, retries, idempotency, graceful degradation |
| 📋 **Compliance Engineer** | Best-practice violations, per language |
| 📚 **Documentation Engineer** | Documentation that has stopped matching the code |
| 🏗️ **Infrastructure Engineer** | IaC, containers and CI kept in line with the code |
| 🧱 **Refactoring Engineer** | Module boundaries, shared logic, coupling |
| 🎨 **UX Engineer** | Usability, consistency, loading and empty states |

Each one gets, in its prompt: the project profile, the rules it must not break, the risks already
recorded for that area, and **the standing rules** — lessons drawn from defects that reached users
after crossing an entirely green pipeline.

### Working in parallel without stepping on each other

Tasks that declare no files in common are grouped into **waves** and run together, each in its own
worktree. But the absence of file collisions is not enough: A can change a function's signature in
`a.js` while B calls it from `b.js` — no collision, each one passes its own checks, the combination
is broken.

Two things close that gap. First, a task can **declare an order**: `dependsOn` names other tasks that
must land before it, so "add the helper" runs before "use the helper" even though the two touch
different files. Cycles, self-dependencies and references to a task that is not in the batch are
broken deterministically and reported — a task silently dropped by a scheduler is worse than an
error. Second, waves are formed by **importance**, so a security fix opens the plan instead of
queueing behind cosmetic work, with a bounded slip so nothing starves and a guard that keeps the
reordered plan only when it is no longer than the plan order.

Then, between one wave and the next:

- the agents receive **what actually changed** — which exports appeared, disappeared or changed
  signature — not just the titles of the other tasks;
- the deterministic gates run on the accumulator and the defect is **attributed to the wave that
  introduced it**: the failure says *"introduced in wave 2 by task 3"*, not *"iteration rolled
  back"*;
- where the analysis cannot look, it **says so** instead of keeping quiet. An empty list next to a
  changed file reads as "nothing changed", which is the opposite of the truth.

---

## The agent managers

Thirteen supervisors that watch the system while it works. They do not write code: each keeps an eye
on one dimension, they alert each other, and what they find reaches the agents.

| Manager | Domain |
|---|---|
| **Quality** | Verification, review and iteration quality |
| **Throughput** | Fleet speed and cost |
| **Risk** | Severity and security exposure |
| **Insights** | Which agents are effective, where the work concentrates |
| **Operations** | Runtime health and control |
| **Services** | Integration between services, and contracts |
| **Workbench** | Local execution and startup health |
| **Implementation** | Iteration pipeline and backlog flow |
| **Director** | Critical tasks and triage |
| **Compliance** | Best-practice conformance, across every language |
| **Context** | Project context and documentation |
| **Deployment** | Release strategy and infrastructure drift |
| **Reliability** | Agent errors, anomalies, self-improvement |

### How they communicate

Three channels, each with a precise reason to exist.

**To the agents.** When a manager finds something, it lands in shared memory, indexed by area, and
from there in the prompts of the planner, the implementer and the graders. A risk on an area reaches
whoever works on that area.

**Between managers.** Each has an inbox: messages from peers arrive with their content, not as a bare
notification. The subscription lives in the base class, not in the individual subclasses — a channel
every manager has to remember to wire up is a channel half of them do not wire up.

**The context that changes the meaning.** When a manager raises an alarm, its brief carries what the
others are reporting. *"The tests are failing"* means something different when Workbench is saying
the application does not start at all: in that case there is nothing in the tests to repair.

---

## Multi-project

A project registry in `platform.db`. **Every project has its own database** under
`.data/projects/<id>/`, with its own detected layout (root, base branch, product directories) and its
own agents. You switch the active project from the dashboard, without restarting.

No product name is hard-coded in the prompts: whatever the system knows about a project, it read from
that project.

---

## The dashboard

React + Vite behind a login. Runs in progress and past runs, the backlog, proposals waiting for
approval, the state of agents and managers, services and containers, the database schema, the fleet's
memory.

From here you start and stop the loop, promote commits, repair a dirty working tree — and **shut ISL
down entirely**: the server exits with a code the supervisor recognizes as an intentional shutdown
and exits in turn, instead of restarting it.

---

## Requirements

- **Node ≥ 22.5** (it uses `node:sqlite`, the native module)
- A local model served by **Ollama**, or a compatible endpoint
- Git

## Startup

```bash
npm install
cp .env.example .env     # set DEFAULT_PROJECT_PATH and AUTH_SECRET
npm --prefix dashboard install && npm --prefix dashboard run build
node supervisor.mjs
```

Then open `http://localhost:7878`.

**Always start `supervisor.mjs`**, never `src/server.js` directly: the supervisor raises the heap and
restarts the server within seconds of a crash or an out-of-memory. The only exit it does not restart
is a shutdown requested by the operator.

Dashboard changes require `npm --prefix dashboard run build`: it is served out of `dist`.

## Configuration

The keys live in `.env.example`, with comments. The two that matter:

- **`DEFAULT_PROJECT_PATH`** — the directory of the code to improve. Without it, ISL starts on itself.
- **`AUTH_SECRET`** — the default value is a placeholder. On any machine other people can reach, it
  has to be changed: it is the only thing protecting a control plane that executes code and writes
  commits.

ISL **must not be exposed on a public network**. See [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test                      # 254 tests, Node's test runner, no dependencies
npm --prefix dashboard test   # 356 tests, Vitest
```

A few deserve a mention, because they do not check functions but **properties that would be lost
without anything failing**:

- `scopeGate.test.js` — the exact shape that made a search bar unusable in production with a review
  score of 95 out of 100
- `composeSafety.test.js` — reads the source and fails if a compose command carries `-v`. That flag
  wipes the database volume and, unlike everything else, has no undo
- `standingRules.test.js` — that the standing rules stay generic: it takes the active project's name
  from the configuration, so it holds for whatever product ISL is governing
- `floorBreaches.test.js` — that an **unmeasured** dimension is not mistaken for a failed one: a
  skipped phase must not roll back a run

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) ·
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

**GNU Affero General Public License v3.0** — full text in [LICENSE](LICENSE).

You are free to use, study, modify and redistribute ISL. If you modify it and make it available to
others — even just by running it as a service reachable over a network, without distributing a copy
— you must offer its users the source of your version. That is the clause separating the AGPL from
the GPL (section 13), and it is deliberate: ISL is a control plane used through a web interface, and
without that clause anyone could offer it as a closed service and give nothing back.

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
