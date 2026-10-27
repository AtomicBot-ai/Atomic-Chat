# Empty placeholders for every bundle resource and externalBin that
# tauri.windows.conf.json names, so the Tauri build script can compile the
# crate for tests without the real downloads. Existing files are left alone.
# Called by `make stub-resources` on Windows and by the release gate job; a
# script file rather than an inline `powershell -Command "..."`, whose `$`
# make's /usr/bin/sh (Git Bash) expanded to nothing.
$ErrorActionPreference = 'Stop'

$files = @(
  'src-tauri/resources/LICENSE',
  'src-tauri/resources/pre-install/test-placeholder',
  'src-tauri/resources/bin/atomic-chat-core.exe',
  'src-tauri/resources/bin/atomic-chat-app-core.exe',
  'src-tauri/resources/bin/bun-x86_64-pc-windows-msvc.exe',
  'src-tauri/resources/bin/uv-x86_64-pc-windows-msvc.exe',
  'src-tauri/resources/bin/cloudflared-x86_64-pc-windows-msvc.exe',
  'src-tauri/resources/bin/bun-aarch64-pc-windows-msvc.exe',
  'src-tauri/resources/bin/uv-aarch64-pc-windows-msvc.exe',
  'src-tauri/resources/bin/cloudflared-aarch64-pc-windows-msvc.exe',
  'src-tauri/resources/bin/mxc/wxc-exec.exe',
  'src-tauri/resources/llamacpp-backend-upstream/test-placeholder'
)

foreach ($file in $files) {
  $parent = Split-Path -Parent $file
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if (-not (Test-Path $file)) { New-Item -ItemType File -Path $file | Out-Null }
}
