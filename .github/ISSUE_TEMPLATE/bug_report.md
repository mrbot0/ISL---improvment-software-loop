---
name: Bug report
about: Something in ISL does not behave the way it should
title: ''
labels: bug
---

<!--
  For a VULNERABILITY, do not use this template and do not open a public issue:
  see SECURITY.md (GitHub Security Advisories, private channel).
-->

## What went wrong

<!-- What you expected, and what happened instead. One or two sentences are enough. -->

## Active project

- Name of the project that was active when it happened:
- Stack of the target project (languages, frameworks, Prisma yes/no, Docker yes/no):
- Is it the `isl-self` project (ISL improving itself)? yes / no

<!--
  Almost everything in ISL depends on the active project: config, database, agents, detected layout.
  The same bug often exists on one project and not on another.
-->

## Run or iteration

- Run / iteration number (**Runs** or **Iterations** tab):
- Verdict: committed / rolled back / aborted / never started
- Scores, if you can see them (review, tests, security, regression, total):
- Did a gate veto? which one, and in which mode (`off` / `advisory` / `enforce`):

## Where

<!-- Check whatever applies. -->

- [ ] Dashboard (which tab: ……)
- [ ] API / WebSocket (which route: ……)
- [ ] Authentication, sessions, admin panel
- [ ] An agent or a manager (which one: ……)
- [ ] Iteration engine, sandbox, worktree
- [ ] A deterministic gate (which one: ……)
- [ ] Container runtime / schema integrity
- [ ] Context Manager, doc agents, knowledge index
- [ ] Supervisor / startup / memory
- [ ] Other: ……

## What the logs say

<!--
  Where to look:
  - the dashboard's Logs tab, or GET /api/logs?level=error — that is ISL's persisted log
  - the Flow tab: the event history of the run (now persisted, it survives a reload)
  - the stdout of `npm run serve`: it also carries supervisor restarts and the memory watchdog
  - the browser console, if the problem is in the dashboard
  - `npm run doctor`: external dependencies (node, repo, node_modules, Ollama, sandbox)
  Paste the relevant lines, not the whole file, and strip any paths or names you do not want published.
-->

```
(log lines)
```

## Reproduction

1.
2.
3.

Reproducible: always / sometimes / only once

## Environment

- ISL commit or version:
- `node --version`:
- Operating system:
- Ollama model (`OLLAMA_MODEL`) and, if relevant, `OLLAMA_CHAT_MODEL`:
- Dashboard rebuilt after your last change (`npm run dashboard:build`)? yes / no
