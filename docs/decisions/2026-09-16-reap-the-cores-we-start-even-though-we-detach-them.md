---
date: 2026-09-16
title: "Keep handles to the cores we start, purely to reap them"
---

# 2026-09-16 — Keep handles to the cores we start, purely to reap them

- **Context:** The app starts `atomic-chat-core` detached — its own session on Unix,
  `DETACHED_PROCESS` on Windows — because a model loaded from the CLI has to survive the app
  quitting. The obvious next step is to drop the child handle: we will never signal it, so why hold
  it? That is wrong on Unix. Detaching a session does not change parentage: the core is still our
  child, and a child that exits stays a zombie until its parent waits on it. A zombie keeps its PID
  and `ps` still reports it with its original start time — so a replacement core, reading the stale
  `instance.lock` and checking whether the owner named there is alive, concludes that it is and
  refuses to take the data folder over with `CORE_ALREADY_RUNNING`. The symptom is that a core which
  crashes can never be restarted for as long as the app runs, which is precisely the case the
  restart logic exists for. Found by running the supervisor against a real core binary; every test
  against the fake core passed, because a fake core is not a child process.
- **Decision:** Handles to cores this process started are kept in a process-global list and
  `try_wait`-ed before anything reads the lock (`launch::reap_finished`). They are never signalled
  and never waited on blockingly; the list exists only so the kernel can release a dead core's PID.
  A start that fails now also reports *why*: the core's stderr is redirected to
  `<data>/atomic-core/core-start.log` — a file rather than a pipe, since the pipe would have to
  outlive our interest in it — and its tail goes into the `CORE_START_FAILED` details.
- **Consequences:** Restart after a crash works, and the app and the core agree about which
  processes are alive. Anyone tidying this up should know that dropping the handles reintroduces the
  bug silently: it is invisible to every test that does not spawn a real core, which is why
  `make test-core-live` exists and why it is worth running when this area changes.
- **Owner:** team
- **Links:** `src-tauri/src/core/atomic_core/launch.rs`,
  `src-tauri/src/core/atomic_core/live_tests.rs`, `Makefile` (`test-core-live`)
