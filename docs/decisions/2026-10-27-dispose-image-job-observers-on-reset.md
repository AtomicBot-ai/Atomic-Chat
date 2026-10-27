---
date: 2026-10-27
title: "Dispose image job observers on local store reset"
---

# 2026-10-27 — Dispose image job observers on local store reset

- **Problem:** `waitForTerminal` owns a two-second fallback interval in a closure. Clearing its resolver map during reset neither clears the interval nor settles its caller. A subsequent service teardown can make the service lookup throw synchronously outside the promise catch. A pending poll or submission can also finish after reset and mutate a newer local run.
- **Decision:** Reset invalidates the local generation epoch and settles existing observers through their normal cleanup path with a null (locally abandoned) result. Both the submitted run loop and adopted-job continuation ignore that result and any response from an older epoch. Polling service lookup is inside the promise chain; settled observers ignore already-pending poll results.
- **Behavior:** Reset ends local observation; it does not cancel a core-owned job, invent a failed job, emit completion telemetry/notifications or append stale poll outputs. A later bind can still adopt an active core job. Normal two-second polling, job events, external-job gallery events, batching, seeds and explicit Stop remain unchanged. A submission already awaiting the core is not aborted; its late result or error is ignored locally.
- **Validation:** Fake-timer regressions cover interval disposal after service teardown, abandoned batches settling without more submissions, late poll completion while another run is active, late submission success/failure, synchronous poll failure followed by recovery, and adopted-job reset. The image workflow fixture also resets outstanding observers in teardown. The original normal generation, cancellation, polling and adoption tests remain in place.
- **Limits:** This addresses observer reset and its pending async continuations. It does not redesign service binding, backend cancellation, model execution or gallery reconciliation. No real model, user image or personal output folder is needed for the tests.
