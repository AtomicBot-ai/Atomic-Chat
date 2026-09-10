---
date: 2026-08-21
title: "Never list TurboQuant next to upstream llama.cpp"
---

# 2026-08-21 — Never list TurboQuant next to upstream llama.cpp

- **Context:** Since the side-by-side decision (2026-06-23, 2026-07-28) both
  local llama.cpp providers ship on every desktop OS, and their titles differ
  by one word — `llamacpp-upstream` renders as "llama.cpp", `llamacpp` as
  "llama.cpp turboquant". Every list sorted them adjacently, and TurboQuant
  usually won the top slot: the model select dropdown sorted local providers
  first and then alphabetically (`llamacpp` < `llamacpp-upstream`), the
  Settings sidebar took the raw engine-manager order (extensions load
  alphabetically, so TurboQuant led on Windows/Linux), and the provider
  overview page hard-coded `llamacpp: 1` while leaving `llamacpp-upstream`
  unranked, which buried the default engine among the cloud providers. Two
  near-identical rows at the head of the list read as one duplicated entry,
  and the one users landed on first was not the default engine.
- **Decision:** TurboQuant is never first and never directly below upstream.
  In the model select dropdown its group is moved to the end of the list,
  after the remote providers — done after grouping, so it also holds while
  searching. In both Settings provider lists (sidebar and overview cards) a
  single shared comparator, `sortProvidersForSettings` in
  `web-app/src/lib/providerOrder.ts`, ranks `jan` → `llamacpp-upstream` →
  `mlx` → `llamacpp` → `foundation-models`, then everything else
  alphabetically by title. MLX is already filtered out of those lists off
  macOS, so one ranking covers both platforms: TurboQuant sits under MLX on
  macOS and collapses to the slot under upstream on Windows and Linux.
- **Consequences:** The ordering is deliberately not alphabetical and not
  grouped-by-engine — MLX sits between the two llama.cpp entries on macOS.
  Do not "fix" that back. Ranking upstream at 1 on the overview page also
  moves the default engine out of the cloud-provider block, and
  `foundation-models` now sorts after TurboQuant. New local engines must be
  added to `PROVIDER_PRIORITY`, or they land in the alphabetical tail.
- **Owner:** team.
- **Links:** `web-app/src/lib/providerOrder.ts`,
  `web-app/src/containers/SettingsMenu.tsx`,
  `web-app/src/routes/settings/providers/index.tsx`,
  `web-app/src/containers/DropdownModelProvider.tsx` (`groupedItems`);
  ADRs 2026-06-23, 2026-07-28, 2026-08-19.
