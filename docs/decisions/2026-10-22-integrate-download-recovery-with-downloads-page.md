# Integrate unfinished-download recovery with the v2.2.23 Downloads page

## Context

The new inventory lists installed files and orphaned partial downloads. It does not persist resumable requests, and its Cancel adapter bypasses the global manager's keep/delete confirmation. Retained retry metadata from a cancelled request also makes the inventory consider its leftovers active forever. PrismML now stores GGUF files in the same `llamacpp/models` root as both llama.cpp providers.

## Decision

Keep the release inventory and its existing leftover removal contract. Restore journalled requests as paused entries in the shared download store; those entries appear once as downloads, while active/paused files remain excluded from orphan removal. Explicitly cancelled entries do not count as active solely because source metadata was retained for an intentional retry.

Downloads exposes Pause/Resume for model requests with trusted resume parameters. Its controls and the Hub's Cancel enter an ephemeral FIFO consumed by the app-wide DownloadManagement component. This reuses its provider-aware pause/resume lifecycle, Prism completion checks, importer-stop exclusion and keep/permanent-delete/back dialog. Consume actions exactly once; wait for an open cancellation dialog before opening the next. Never persist queued controls or automatically resume a restored request.

Both llama.cpp providers and Prism share physical GGUF source identity and disposal root. HF revision, quant/shard identity and destination collision guards remain significant. Include the downloader's `.gguf.parts.new` temporary manifest in safe disposal; do not trust that temporary manifest as recovery metadata. Reject installed models, linked paths, unknown files and inaccessible configured roots as before.

## Validation

Cover restored request reuse, concurrent shard aliases across providers, revision collisions, page/panel control routing, confirmation ordering, cancelled leftover visibility, and native temporary-fixture deletion. Check Downloads actions in running/paused states with a long model name, supported font sizes, 1024/1280 widths and light/dark themes. No user models, settings or installed application are modified during automated validation.

Run the native E2E build with its own app core, profile, WebKit store and loopback HTTPS model mirror. Verify a full restart restores one paused item with an unchanged payload hash; repeated Hub selection adds neither a row nor a GET; Downloads Pause/Resume uses the same operation; keeping files permits ranged completion with an exact final hash; permanent deletion removes only the selected partial and stays removed after restart. Check operator-profile invariants during teardown. Segmented transfers preallocate their payload, so measure received bytes from the persisted range manifest rather than the file length. The live check also caught a missing Show download progress translation, now supplied in English and Korean.
