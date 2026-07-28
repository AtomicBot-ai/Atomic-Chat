---
date: 2026-06-12
title: "Make the Hub download in-progress state a button-shaped \"pill\" and surface the title-bar download indicator (auto-open + pulse)"
---

# 2026-06-12 — Make the Hub download in-progress state a button-shaped "pill" and surface the title-bar download indicator (auto-open + pulse)

- **Context:** PM feedback (screenshots) on the Hub: (1) once a variant
 download starts, the row's action cell collapsed from a proper button
 ("Download" / "New chat") to a thin `Progress` bar + "NN%" + a tiny ghost `X`
 icon (`w-24` block), reading as a broken "недокнопка" next to the real
 buttons; (2) the title-bar download indicator
 ([`DownloadManagement`](web-app/src/containers/DownloadManegement.tsx)) — a
 ghost icon with a faint progress ring shown only while `downloadCount > 0` —
 was nearly invisible, so users didn't notice a download was running. The same
 in-progress markup was triplicated across
 [`ModelDownloadAction`](web-app/src/containers/ModelDownloadAction.tsx),
 [`DownloadButton`](web-app/src/containers/DownloadButton.tsx) (Hub index
 cards), and [`MlxModelDownloadAction`](web-app/src/containers/MlxModelDownloadAction.tsx).
 **Correction (same day):** the `$modelId` variant table the PM actually
 screenshotted does **not** use `ModelDownloadAction` — it renders the action
 cell inline in [`$modelId.tsx`](web-app/src/routes/hub/$modelId.tsx), so the
 first pass didn't change that surface. A follow-up applied the same pill there
 too (see the same-day ADR *Fix variant-row height jump …* below).
- **Decision (per the user's chosen options):**
 1. **Pill button** — replace the bar+%+X trio with a single
 `variant="outline" size="sm"` button matching the "Download"/"New chat"
 footprint (`w-24`): a left-anchored `bg-primary/20` width-`%` progress fill
 behind the centered "NN%" label; on hover the percent fades out and a
 centered `IconX` fades in; the whole button is the cancel control
 (`onClick={handleCancelDownload}`, `title`/`aria-label` =
 `common:cancelDownload`). Applied **identically to all three** Hub
 download-action components for visual consistency (the PM only flagged the
 variant rows, but the widget is shared — fixing one and leaving the others
 inconsistent would be a half-fix). Inlined in each (no new shared
 component/file). `Progress` import dropped from all three (sole consumer
 removed).
 2. **Indicator visibility** — in `DownloadManagement`, when `downloadCount`
 rises from `0`, briefly auto-open the popover (4s `setTimeout` auto-close;
 refs `prevDownloadCount` / `autoCloseTimer`, cleared on unmount; the
 controlled `onOpenChange` clears the timer on any manual open/close so we
 never fight the user). **Amendment (same day, per user):** the visual
 highlight that originally rode along — `highlightIndicator` pulse
 (`animate-pulse ring-2 ring-primary/40`) and the `downloadCount > 0`
 `text-primary` icon recolor — was **reverted**; only the auto-open logic was
 kept. The icon stays its original `text-muted-foreground` with just the
 existing progress ring.
- **Consequences:** Downloading rows now look like first-class buttons and the
 cancel affordance is the whole control (larger hit target) rather than a 12px
 `X`. The title-bar indicator announces itself on start and stays
 color-highlighted while active. Display-only — no change to download
 start/cancel/resume logic, the store, IPC, or telemetry. Auto-open is
 best-effort UX: it closes after 4s (acceptable per "briefly open") and yields
 to manual interaction; a second concurrent download starting while one is
 active does not re-open (trigger gated on `prev === 0`). Verified: `tsc -b`
 clean, `eslint` clean on all four touched files.
- **Owner:** team.
- **Links:** files:
 [`web-app/src/containers/ModelDownloadAction.tsx`](web-app/src/containers/ModelDownloadAction.tsx),
 [`web-app/src/containers/DownloadButton.tsx`](web-app/src/containers/DownloadButton.tsx),
 [`web-app/src/containers/MlxModelDownloadAction.tsx`](web-app/src/containers/MlxModelDownloadAction.tsx),
 [`web-app/src/containers/DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx).
