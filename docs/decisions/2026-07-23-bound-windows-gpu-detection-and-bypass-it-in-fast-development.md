---
date: 2026-07-23
title: "Bound Windows GPU detection and bypass it in fast development"
---

# 2026-07-23 — Bound Windows GPU detection and bypass it in fast development

- **Context:** `make dev-windows-fast` could remain indefinitely at
  `Detecting GPU hardware` because `Get-CimInstance Win32_VideoController`
  hung inside WMI before the script reached its existing-backend reuse path.
- **Decision:** Reuse an existing upstream backend before any hardware probe
  when `-SkipBackendDownload` is active. For ordinary Windows development,
  query video controllers once in a background job with a 10-second timeout
  and reuse that bounded result for NVIDIA-driver and fallback VRAM detection.
- **Consequences:** Fast development no longer depends on WMI when its backend
  is already present. Normal development degrades to Vulkan/CPU selection
  instead of hanging when WMI is unhealthy; registry VRAM detection remains
  authoritative when available.
- **Owner:** team.
- **Links:** [`scripts/dev-windows.ps1`](scripts/dev-windows.ps1),
  [`Makefile`](Makefile) (`dev-windows-fast`).
