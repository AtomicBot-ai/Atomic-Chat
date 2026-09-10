---
date: 2026-07-28
title: "Grade tests by critical-flow evidence"
---

# 2026-07-28 — Grade tests by critical-flow evidence

- **Context:** Test counts and aggregate coverage can remain high while a suite
  executes replacement fixtures, asserts only that a mock was called, or never
  crosses the boundary where production failures occur.
- **Decision:** Atomic Chat grades critical-flow evidence as Strong, Partial,
  Smoke, or Missing. A Strong test executes the production entrypoint, crosses
  the load-bearing boundary, asserts an observable outcome, and covers a
  failure path; line coverage alone cannot raise the grade.
- **Consequences:** `docs/testing-critical-flows.md` is the living evidence map
  and gap register. Mutation probes validate assertion sensitivity, while WDIO
  remains a small set of desktop journeys rather than a substitute for unit and
  contract tests.
- **Owner:** team
- **Links:** `docs/testing-critical-flows.md`, `Makefile`
