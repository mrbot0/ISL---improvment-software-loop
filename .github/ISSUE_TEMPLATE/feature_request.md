---
name: Improvement proposal
about: An idea for ISL — a gate, an agent, a manager, a dashboard view
title: ''
labels: enhancement
---

## The problem

<!--
  Start from the concrete failure or the concrete friction, not from the solution. In ISL the best
  things started that way: "the planner picked the same function in four runs in a row, failing
  every time". If you can, point to the run or the situation that made it obvious.
-->

## What you propose

## Where it would land

- [ ] A new or modified **deterministic gate** (`src/iteration/`)
- [ ] A grader or the iteration engine
- [ ] An agent or a manager
- [ ] Planner / backlog / candidate selection
- [ ] Platform: projects, auth, admin, audit
- [ ] Context Manager / doc agents / knowledge index
- [ ] Reliability Manager
- [ ] Container runtime / schema integrity
- [ ] Dashboard (which tab, or a new one)
- [ ] Other: ……

## If it is a gate

<!--
  The convention is described in CONTRIBUTING.md §5. In short, answer these:
-->

- Which change passed that should not have? (the real failure that motivates the gate)
- Is the rule decidable without an LLM, on the same diff, always with the same verdict?
- What is the **legitimate** version of the same operation, the one the gate must not fire on?

## Alternatives considered

<!-- Including: can you get there with the settings that already exist? -->

## Effect on autonomy

<!--
  Does it change what ISL commits or promotes with no human watching? If so, say it explicitly:
  that is the part to settle before writing the code.
-->
