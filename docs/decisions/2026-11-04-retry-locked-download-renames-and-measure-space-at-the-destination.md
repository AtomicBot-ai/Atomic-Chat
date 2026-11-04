---
date: 2026-11-04
title: 'Retry locked download renames and measure free space at the destination'
---

# 2026-11-04 — Retry locked download renames and measure free space at the destination

- **Context:** Model downloads failed with `disk_io` on 3.2% of Windows
  downloads against 0.3% on macOS (PostHog, 14 days to 2026-11-04), and with
  `disk_full` on 1.1% against 0.7%. Defender, the indexer and OneDrive hold a
  just-finished file for a few seconds (os error 5/32/33), but every final
  rename and remove ran once; a failed `.url` sidecar delete failed the whole
  download. Free space came from sysinfo by mount-prefix matching, which misses
  Windows paths with another case, UNC prefixes, junctions or mapped drives, and
  then skipped the check. On FAT32 a file over 4 GiB failed mid-write and was
  reported as `disk_full`.
- **Decision:** Final renames and removes in the download paths retry on
  Windows lock and permission errors with backoff (0.1 s doubling to 2 s, ~9 s
  within a 10 s budget), logging each retry; other platforms do not retry. A
  sidecar that cannot be deleted after a successful rename is a warning. Free
  space is queried on the nearest existing directory of the destination
  (`GetDiskFreeSpaceExW` / `statvfs`), falling back to the old match only when
  that query fails; the requirement is the bytes still to write plus
  max(512 MiB, 2%) headroom, and the refusal names required and free bytes.
  A FAT/FAT32 destination refuses a file of 4 GiB or more before the first byte
  with the new tag `disk_fs_limit`. `get_disk_space_info` exposes the same
  numbers to the web download queue.
- **Consequences:** A locked file can delay finishing a download by up to
  ~10 s instead of failing it. The 512 MiB floor keeps the check no looser than
  before. The FAT rule is Windows-only; macOS FAT drives still surface as
  `disk_full`. Not verified on a Windows machine at the time of writing.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/downloads/disk.rs` (`retry_while_locked`,
  `required_free_bytes`, `ensure_file_fits_file_system`),
  `src-tauri/src/core/downloads/volume.rs`, `src-tauri/src/core/downloads/commands.rs`.
