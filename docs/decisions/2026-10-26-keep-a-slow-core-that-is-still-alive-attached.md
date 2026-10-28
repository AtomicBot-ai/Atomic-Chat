---
date: 2026-10-26
title: "Keep a slow core that is still alive attached"
---

# 2026-10-26 — Keep a slow core that is still alive attached

- **Context:** QA of app 2.2.25 / core 0.19.0 on an 8 GB MacBook Air (2026-10-23, NEW-06 /
  MEDIA-01 / REC-02): Z-Image Turbo Q3_K_M (~6.5 GB) made the machine swap. One heartbeat timed
  out after 15 s (14:41:00); the relay treated that like a dead core — invalidated the attachment,
  stopped heartbeating that registration and spent 51 s on `/health` probes that also timed out.
  The core's 45 s client lease ran out and the core retired itself mid-image (14:41:51, core ADR
  2026-10-26-an-app-core-does-not-retire-while-it-works); the app's new registration landed on the
  stopping core, its event stream was reset, and the supervisor started a new core. The page then
  polled the new core, which did not know the job: "The job disappeared — the renderer no longer
  knows this job". Nothing distinguished "not answering in time" from "gone", although the lock
  (instance id + PID with its start time) says which it is.
- **Decision:** A transport failure carries whether it was a deadline (`CoreError::is_timeout`, a
  field the webview never sees). A timeout while the lock still names the attached instance and its
  process is alive (`Supervisor::is_only_slow`) is a slow core: the relay keeps the stream and keeps
  heartbeating the same registration (logging once when it starts and when it ends), and
  `Supervisor::call` returns the timeout without dropping the attachment or retrying. A refused or
  reset connection, a missing lock or a lock naming another instance still invalidates as before,
  so a dead core, a replaced core and a zombie (reaped on the next attach) are handled unchanged,
  as are the version-mismatch replacement and the restart rate limit. In the webview each local
  image or video job remembers the core instance it was submitted to (`CoreInstanceTracker`, from
  the relay snapshot's `instance_id` and `atomic_core_snapshot`): a re-attach to the same instance
  leaves the job running and re-reads it; a new instance, or a supervisor that gave up starting one
  (`CORE_START_FAILED`), ends it as `ENGINE_STOPPED` — "The media engine stopped … most likely the
  computer ran out of memory", with Try again and a smaller quant — instead of `JOB_NOT_FOUND`.
- **Consequences:** A core that hangs for good while its process lives is never replaced
  automatically; the user quits or stops the job. Heartbeats to a slow core continue every interval
  (a missed tick is delayed, not burst). `ENGINE_STOPPED` is an app-only code in
  `NativeDiffusionErrorCode`; the core never sends it. A provider's (cloud) job is not tied to an
  instance, since the next core polls it again. Needs no new core release: the core side only
  makes the incident rarer.
- **Owner:** `team`.
- **Links:** `src-tauri/src/core/atomic_core/{client,supervisor,relay,test_support}.rs`,
  `web-app/src/lib/diffusion/lost-job.ts`, `web-app/src/stores/{image,video}-generation-store.ts`,
  `web-app/src/services/diffusion/{tauri,types}.ts`, core ADR
  2026-10-26-an-app-core-does-not-retire-while-it-works.
