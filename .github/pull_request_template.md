## What changes, and why

<!--
  The why matters more than the what: the diff already says which lines changed. If it closes an
  issue, write "Closes #N".
-->

## Type

- [ ] Bug fix
- [ ] New or modified deterministic gate
- [ ] Agent / manager / iteration engine
- [ ] Platform (projects, auth, admin)
- [ ] Dashboard
- [ ] Documentation
- [ ] Other: ……

## How you verified it

- Active project you tried it on:
- Reference run or iteration, if there is one:
- What you saw broken before and working now:

```
npm run test:all      →
npm run check:routes  →
```

## Checklist

- [ ] `npm test` green (backend, `node:test`)
- [ ] `cd dashboard && npx vitest run` green — or `npm run test:all`
- [ ] `npm run check:routes` with no `MISSING`
- [ ] If I touched `dashboard/src/`: I ran `npm run dashboard:build` and checked it in the browser
      (`dashboard/dist` is not in the repository: the bundle is local only)
- [ ] No target-project value captured at import time: it goes through `src/config.js`
      (live bindings) and the `src/db.js` handle, because the active project changes at runtime
- [ ] No secrets, personal paths, real project data or files under `.data/` in the diff

### If the PR adds or modifies a gate

- [ ] The comment at the top of the file names the **real failure** that motivates it and the damage it caused
- [ ] Deterministic: no LLM call, stable verdict on the same diff
- [ ] Two tests in `test/`: the diff that broke things is rejected, **and** the legitimate version of
      the same operation passes
- [ ] It lands in `advisory` (via `getSetting`), not straight in `enforce`

## Risk

<!--
  If this change is wrong, what happens? Who finds out, and when? ISL commits without supervision
  when autonomy is on: a mistake in a gate or in promotion does not stop at this PR.
-->
