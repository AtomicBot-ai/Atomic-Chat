---
date: 2026-10-15
title: "Repair an unreadable settings.json instead of falling back to a relative data folder"
---

# 2026-10-15 — Repair an unreadable settings.json instead of falling back to a relative data folder

- **Context:** On the owner's machine a blue screen three seconds after Radium wrote `%APPDATA%\chat.atomic.app\settings.json` left the file as 102 zero bytes (2026-10-14). `get_app_configurations` answered a parse failure with `AppConfiguration::default()`, whose `data_folder` is the relative `./data`, resolved against whatever directory the process was started from. Started from the Start menu, Radium silently built a second, empty data folder inside its install folder. `decompress` there refused every engine archive ("not under jan_data_folder ./data"), and the window hung on a black panel. Started from a shell in `C:\Windows\system32`, it could not create its log folder, so the Tauri setup failed and the process aborted (`0xC0000409`) before writing a line. Every one of those launches logged the parse failure dozens of times, and none of them fixed it.
- **Decision:** An unparsable `settings.json` is moved aside to `settings.json.corrupt-<unix-seconds>` and replaced with a valid one that points at the default data folder, which is absolute (`default_data_folder_path`). A file that cannot be read at all (locked, wrong permissions) is left alone, and the default data folder is used for that call. Every write of `settings.json` (new install, `update_app_configuration`, the repair) goes through a temporary file that is flushed to disk and then renamed over the old one, so a crash can no longer leave it zeroed. `AppConfiguration::default()` keeps `./data` for the `CI=e2e` path only.
- **Consequences:** A damaged settings file costs one log line and the custom data folder, if the user had one; they choose it again in Settings, and the damaged file is kept beside the new one to recover it from. The data-folder migration (2026-09-13) still rewrites the file with a plain write; the load-time repair covers it if that write is ever torn.
- **Owner:** @walladanger
- **Links:** `src-tauri/src/core/app/commands.rs` (`load_configuration_file`, `write_configuration_file`); tests in the same file; [2026-09-13 data folder rename](2026-09-13-rename-the-product-to-radium-and-move-the-data-folder.md)
