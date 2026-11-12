---
date: 2026-11-11
title: "Check the resolved Foundry model's runtime requirement before transfer"
---

# 2026-11-11 — Check the resolved Foundry model's runtime requirement before transfer

- **Context:** Azure returns the minimum Foundry Local runtime in the resolved model revision's
  metadata. A compatible accelerator alone is insufficient to start transferring that revision.
- **Decision:** Send a valid minimum to the core before opening the blob container or transferring
  files. Repeat the check after refreshing a signed link and retain the same revision's known
  minimum when the new response omits it. The Hub uses the core's update offer to decide whether
  the Foundry settings can provide a compatible build.
- **Consequences:** A refusal leaves the existing file paths, partial bytes and resume keys available
  for another attempt. When an older core explicitly rejects the optional field, the app repeats the
  original check and reads the active runtime from the core's engine versions response. If the
  version cannot be verified, the transfer stays blocked and the app explains the core requirement.
- **Owner:** `team`.
- **Links:** `web-app/src/services/foundry-local/{core,install}.ts`,
  `web-app/src/containers/hub/FoundryLocalDownloadOptions.tsx`, and OpenSpec change
  `upgrade-foundry-local-2-4`.
