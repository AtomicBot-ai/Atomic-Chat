---
date: 2026-10-23
title: "Draw the download panel as the first-run strip"
---

# 2026-10-23 — Draw the download panel as the first-run strip

- **Context:** The bottom-right "Downloading" panel kept its 2.0 look: a grey
  card per transfer with the name, a separate quant line, a blue bar and the
  readout under it. The first-run flow brought a strip from the approved
  prototype (`.ob-download`: download mark, name over one status line, the
  percent and round controls on the right, a hairline of progress), and the
  designer asked for the panel to look the same; the prototype itself never
  restyled the panel.
- **Decision:** Every row of the panel is that strip, inside the handoff
  panel's shell (one card, hairline dividers), in the strip's teal on both
  themes (`containers/downloads/download-panel.css`); the collapsed badge
  follows. The status line comes from `formatDownloadStatusLine`: a state word
  where the readout put the percent, which now sits apart. In the 22 rem
  panel a simply running transfer drops the word "Downloading" so the
  estimate keeps its place; Paused, Starting and the reconnect states keep
  theirs. The quant shows beside the name only when the name lacks it. The
  first-run strip reads its line from the same function, which removes the
  percent it showed twice. A transfer that is reconnecting turns the strip's
  warning colour.
- **Consequences:** Downloads look the same in setup, in the handoff panel and
  in the app. The 2026-09-17 one-line rule holds (the name and the status
  line each one line, cut at the estimate); the speed stays out. The panel
  no longer uses product blue for activity. A layout test measures the strip
  at Extra Large in both themes and languages.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/downloads/DownloadProgressRow.tsx`,
  `DownloadPanel.tsx`, `download-panel.css`, `lib/downloadFormat.ts`.
