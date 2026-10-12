# Keep recent failed chat downloads discoverable

- Status: Accepted
- Date: 2026-10-10
- Scope: ATO-264

## Context
Range-based resume already exists, but failed rows disappear from the download panel and the Hub has no way to find the affected models again.

## Decision
Keep up to 20 failed chat transfers from the last 30 days in local storage, with model id, validated repository name, format and failure time only. No credentials, download URLs, filesystem paths or error payloads are retained. Cancellation and other download families are excluded. MLX action and onboarding catches record rejected imports as well as terminal download events. Managed installs clear recovery metadata after finalization even when all files were already present. Successful completion, including checksum verification, removes the entry; retry failures refresh it. The Hub sort menu offers a recent-failures view, independent of format, memory-fit and uncensored discovery filters, because recovery must not hide a previously chosen download. Search narrows repository names. Repository cards outside the catalog reuse existing card fetching, with explicit retry for transient failures and credential-aware failed-lookup caching; managed checkpoints retain their shared-store format; their normal download actions reuse existing partial-file resume.

## Consequences
Recovery survives app restarts without retaining secrets. Removed/private repositories can still fail to resolve or download and retain the existing error handling. This changes discovery, not backend transport or checksum verification.
