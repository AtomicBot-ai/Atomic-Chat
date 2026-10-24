# Integrate download recovery with the new onboarding flow

## Context

Upstream main `38720374` adds onboarding-owned downloads and moves shared pause
controls into `downloadControls`. Its download panel now uses a compact strip.
The recovery PR must preserve that flow without creating a second MLX importer
or showing a duplicate panel for an onboarding-owned transfer.

## Decision

- Retain upstream handoff filtering, completion notification policy, compact
  strip colours, controls and progress semantics.
- Keep cancellation confirmation mounted even when the handoff hides the panel.
- Apply the existing repeated overflow marquee to the strip name and status;
  retain the independent fixed percentage and round action slots.
- Route onboarding MLX imports through the same models service as Hub imports,
  preserving request origin, token, companion files and manual resume intent.
- Shared Pause eligibility recognizes canonical model requests before applying
  legacy binary-prefix exclusions, so setup and the panel agree.
- Preserve upstream redirect credential-isolation tests beside recovery tests.

## Validation

Use fixture-only control and importer tests, browser geometry/marquee checks,
required repository verification and production web builds. No existing model
payloads, installed application or SD-card paths are modified by this merge.
