---
date: 2026-10-20
title: "Keep download cancellation distinct from pause and recovery"
---

# 2026-10-20 — Keep download cancellation distinct from pause and recovery

- **Context:** Download recovery incorrectly treated the panel's Cancel button as Pause. A paused row therefore appeared unresponsive to Cancel. Removing only the row would let late progress or the legacy sidecar scan recreate it.
- **Decision:** Cancel stops the transfer and immediately removes the model job from the visible queue. Persist its dismissed id and retain only the existing allowlisted source mapping needed for an explicit re-download to reuse the destination. Pause remains visible and resumable. Ignore late events for dismissed jobs and skip them during startup discovery. An explicit download clears dismissal and waits for an earlier import and its abort notification to finish before starting another import.
- **Consequences:** Cancellation never deletes model payloads or sidecars. Canceled jobs remain hidden across restart, while requesting the model again can reuse preserved partial files. Existing recovery journals without dismissal records still restore normally. Credential filtering and best-effort storage behavior remain in effect. Unknown-source artifacts can be dismissed without touching their files.
- **Owner:** @Young-uk.
- **Links:** [Recovery decision](2026-10-20-recover-and-reuse-model-download-requests.md), [PR #370](https://github.com/AtomicBot-ai/Atomic-Chat/pull/370).
