---
date: 2026-09-13
title: "Gate every upstream sync on a Fork features impact report"
---

# 2026-09-13 — Gate every upstream sync on a Fork features impact report

- **Context:** Radium is a fork of Atomic Chat and takes upstream releases.
  The v2.0.35 sync (c81c4ea98) took upstream's `web-app/src/routes/__root.tsx`
  and silently dropped the Windows window controls, while the fork still
  turned Windows' own title bar off. The app could not be closed, minimised
  or resized. Nothing caught it: the only guard,
  `scripts/verify-selective-v2032.mjs`, hash-checks nine media files and
  forbids the Atomic Code paths. Nothing else the fork built was protected,
  and nobody could see what an update would touch before merging it.
- **Decision:** No upstream merge goes ahead blind (tracker D31, option A).
  - `docs/upstream-gateway/fork-features.json` lists every fork feature: the
    files it lives in and a check that fails when it is gone.
  - `make upstream-impact` trial-merges upstream in memory (`git merge-tree`)
    and reports each feature as untouched, edited, deleted or conflicting,
    with the upstream commits and a plain-language consequence.
  - The user decides each flagged row in the tracker: keep ours, take theirs,
    or adapt.
  - `make upstream-gate` refuses while any flagged row is undecided, or while
    the report is for an older upstream.
  - After the merge, `make upstream-post-merge` runs every feature's check.
  - Automatically stripping upstream changes was rejected. It would also drop
    upstream's bug and security fixes, and can leave code that does not build.
- **Consequences:**
  - Every new fork feature must add a register row with a check that fails
    when the feature is removed. `tests/fork-features-register.test.mjs`
    keeps rows pointing at real files and tests.
  - Rows with no check yet are marked `no-check` and listed as gaps, never
    hidden.
  - A removal, such as Atomic Code, is protected by `expectAbsent` paths:
    upstream bringing those files back is flagged.
  - Needs git 2.38 or newer for `merge-tree --write-tree`.
  - Decisions are kept across re-runs only while the upstream commits behind
    them are unchanged.
  - The report is advisory about *where* things change. The feature checks
    prove *whether* they still work.
- **Owner:** team
- **Links:**
  - `scripts/upstream-gateway.mjs`
  - `scripts/upstream-gateway-tracker.py`
  - `tests/upstream-gateway.test.mjs`
  - Tracker Task 25, D31
  - The v2.0.35 loss: Task 23, PR #10
