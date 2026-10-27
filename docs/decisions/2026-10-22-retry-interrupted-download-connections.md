# Retry interrupted download connections until stopped

## Context

The installed app exhausted five retries on DNS failures and the recovery UI retained the failed job as Paused. Reconnecting later required a manual Resume. The user requested ongoing connection recovery with a 64-second cap.

## Decision

Keep the same native transfer alive for transport failures in the initial GET, single-stream reconnect, and segmented workers. Wait 1, 2, 4, 8, 16, 32, 64 seconds and then 64 seconds indefinitely. Any positive payload progress resets that connection's delay to one second. Existing cancellation tokens interrupt both requests and waits; manual pause/cancel is never scheduled for resume. No retry timer or intent is persisted: restored jobs remain paused after app restart.

Tag transport failures at their origin (reqwest connection/body/timeouts, watchdog timeout, premature response end), excluding certificate/configuration/decoding errors. HTTP response failures keep the finite five-retry limit, and disk/integrity failures remain terminal. Advisory HEAD stays bounded so an unsupported HEAD can still fall back to GET. Reclassify every reconnect failure so a subsequent HTTP denial cannot inherit unlimited recovery from a previous network error.

The existing status protocol uses maxAttempts=0 for ongoing connection recovery. The UI shows an automatic-retry interval rather than an invalid attempt/5 fraction. Ranges, identity checks, partial-file ownership and integrity verification are unchanged. Tests accelerate waits but assert the production timing policy separately.

## Validation

Loopback tests cover more than five failures, single and segmented body recovery, exact final bytes, byte-progress reset, cancellation during recovery, bounded HTTP refusals, and an unchanged completed neighbouring file. No real model files are used.

## Live-switch follow-up

A completed projector has no transfer sidecar, but a safe persisted request can still identify its source. Startup discovery now retains that journal only when every weight sidecar/map is valid, the weight identity matches, and the sole missing source is the completed projector. Unknown partial sources, corrupt maps and other revisions remain blocked. A one-off legacy repair may restore source metadata only after a full local SHA-256 and size match against the official origin; model payloads are never rewritten for this repair.

## Completed shards during resume

Live switching also exposed upstream accounting that counted only partials and attempted completed files again. Explicit resume now discounts final files whose lengths equal the resolved remote lengths and returns their existing paths without transfer or writes. Existing supplied-hash validation still runs. Unknown lengths, non-regular paths and size mismatches fail closed without overwriting the final file. A stale partial alongside a complete file is neither added to the free-space discount nor used to rewrite it. This does not claim cryptographic validation when the caller supplied no expected hash.
