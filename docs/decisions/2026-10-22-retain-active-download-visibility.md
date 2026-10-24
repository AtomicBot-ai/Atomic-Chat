---
date: 2026-10-22
title: "Retain download visibility until its importer settles"
---

# Retain download visibility until its importer settles

## Context

The physical request registry prevents a second import, but its UI progress and activity entries can be removed independently. A terminal notification that arrives before the importer has settled can therefore hide the panel; selecting the same model finds the existing import without restoring its row. Restart recovery does not cover this same-process state loss.

## Decision

Each active common-service import subscribes to its own store state and retains the latest progress and resume parameters in memory. Repair missing progress, source and activity entries while the import is alive, without starting or retrying transport. Explicit dismissal and a guarded file operation override repair; paused jobs remain paused. Release the subscription before final cleanup when the importer settles, so repaired completed/refused jobs do not leave phantom rows. Imports whose state was never repaired keep their existing completion contract. Failed resumable jobs keep the existing paused recovery behavior.

This is a UI lifecycle correction: source identity, request ordering, Range validation, transfer bytes and disk deletion rules do not change. It does not establish why an unpatched user's panel originally disappeared or solve cross-process duplicate imports.

Defer the manager's completion notification and cleanup while that importer is alive. Replay only its latest completion callback after successful import, and discard it on pause, cancellation or failure. This prevents a premature completion toast beside a still-running transfer. Transfers outside the common model service keep their existing event contract.

## Consequences

Visibility remains attached to one in-flight importer and its last observed counters. Each importer owns a temporary subscription, removed when its promise settles. Explicit cancellation remains authoritative and completed downloads do not gain a permanent UI entry.

Owner: @Young-uk. Related: [PR #370](https://github.com/AtomicBot-ai/Atomic-Chat/pull/370).

## Validation

Hold a physical importer pending, clear progress/activity/source state, and assert exact counter/source restoration with one importer across repeated and aliased requests. Verify pause and explicit dismissal win and completion releases the row. In the native isolated app, inject a terminal notification during a live loopback GGUF transfer and check the rendered panel after animation frames, then continue restart/recovery, keep/ranged completion and scoped deletion checks. Never target operator model files or settings.
