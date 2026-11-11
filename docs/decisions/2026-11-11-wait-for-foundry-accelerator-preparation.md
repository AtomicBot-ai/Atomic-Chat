---
date: 2026-11-11
title: "Wait for Foundry accelerator preparation"
---

# 2026-11-11 — Wait for Foundry accelerator preparation

Cold CUDA preparation downloads NVIDIA runtime archives and the Microsoft
execution provider. The Ubuntu acceptance run took 526 seconds. The desktop
control client's general 600-second deadline can elapse while core is still
preparing the accelerator.

Apply the existing long-running install policy to `POST
/runtimes/foundry-local/accelerators/prepare`. The desktop waits for the core's
preparation result and displays progress from the existing event stream.
Accelerator discovery keeps the general client deadline.
