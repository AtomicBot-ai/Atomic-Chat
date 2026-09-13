; Radium — NSIS installer hooks
; Extends the default Tauri uninstaller to:
;   1. Kill helper processes that hold file locks BEFORE removing files.
;   2. Clean application data directories that live outside the Tauri-managed
;      bundle ID path when the user opts in to "Delete app data".
;
; On Windows the app stores data in these locations:
;   1. %APPDATA%\chat.atomic.app\               — Tauri-internal store +
;                                                 settings.json (new installs).
;                                                 Cleaned by Tauri default.
;   2. %APPDATA%\Radium\                        — User data folder
;                                                 (models, threads, backends,
;                                                 logs, store.json,
;                                                 mcp_config.json).
;                                                 NOT cleaned by Tauri default.
;      %APPDATA%\Atomic Chat\                   — The same folder under the
;                                                 product name used before
;                                                 ADR 2026-09-13; the app moves
;                                                 it on first launch.
;      %APPDATA%\Radium Chat\                   — Usually empty; left by jan-cli
;                                                 builds from before that ADR.
;   3. %APPDATA%\Atomic-Chat\                   — Legacy settings.json
;                                                 (only on older installs;
;                                                 path uses CARGO_PKG_NAME).
;   4. %LOCALAPPDATA%\chat.atomic.app\EBWebView — WebView2 cache + localStorage.
;                                                 Cleaned by Tauri default,
;                                                 but on perUser/passive
;                                                 installs lockfiles can be
;                                                 left behind, so we redo it.
;
; A custom data_folder set by the user via "Change data folder location"
; is NOT covered by these hooks — the user is responsible for cleaning it.

!macro NSIS_HOOK_PREINSTALL
  ; Product rename (ADR 2026-09-13). Every build before it installed as
  ; "Atomic Chat", and Tauri only looks for a previous install under the
  ; current ${PRODUCTNAME}, so without this the new build would install side by
  ; side with the old one. Remove the old program first.
  ;
  ; User data is not touched by either path. Tauri's uninstaller deletes app
  ; data only when its interactive "Delete app data" box is ticked, which a
  ; silent run never does, and the MSI package removes no data at all. The data
  ; folder itself is moved to "Radium" by the app on its first launch
  ; (src-tauri/src/core/app/data_migration.rs).
  Push $R7
  Push $R8
  Push $R9
  Push $0
  !if "${ARCH}" == "x64"
    SetRegView 64
  !endif

  ; 1. An NSIS install of "Atomic Chat", per-user or per-machine.
  StrCpy $R9 "Software\Microsoft\Windows\CurrentVersion\Uninstall\Atomic Chat"
  ReadRegStr $R8 HKCU "$R9" "UninstallString"
  ReadRegStr $R7 HKCU "Software\${MANUFACTURER}\Atomic Chat" ""
  ${If} $R8 == ""
    ReadRegStr $R8 HKLM "$R9" "UninstallString"
    ReadRegStr $R7 HKLM "Software\${MANUFACTURER}\Atomic Chat" ""
  ${EndIf}
  ${If} $R8 != ""
    DetailPrint "Removing the previous Atomic Chat installation"
    ${If} $R7 != ""
      ; _?= runs the uninstaller in place, so ExecWait really waits for it.
      ExecWait '$R8 /S _?=$R7' $0
      Delete "$R7\uninstall.exe"
      RMDir "$R7"
    ${Else}
      ExecWait '$R8 /S' $0
    ${EndIf}
  ${EndIf}

  ; 2. An MSI install of "Atomic Chat". WiX keys are product GUIDs, so the
  ;    entry is matched by DisplayName and Publisher, as Tauri's own reinstall
  ;    page matches a WiX install of the current name.
  StrCpy $R7 0
  radium_legacy_msi_loop:
    EnumRegKey $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R7
    StrCmp $R8 "" radium_legacy_msi_done
    IntOp $R7 $R7 + 1
    ReadRegStr $R9 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R8" "DisplayName"
    StrCmp $R9 "Atomic Chat" 0 radium_legacy_msi_loop
    ReadRegStr $R9 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R8" "Publisher"
    StrCmp $R9 "${MANUFACTURER}" 0 radium_legacy_msi_loop
    ReadRegDWORD $R9 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R8" "WindowsInstaller"
    StrCmp $R9 "1" 0 radium_legacy_msi_loop
    DetailPrint "Removing the previous Atomic Chat MSI installation"
    ; One attempt only: a cancelled uninstall leaves the entry, and retrying
    ; the loop would never end.
    ExecWait 'msiexec /x $R8 /passive /norestart' $0
  radium_legacy_msi_done:

  !if "${ARCH}" == "x64"
    SetRegView lastused
  !endif
  ClearErrors
  Pop $0
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri's CheckIfAppIsRunning macro (called later in the Section Uninstall
  ; from the bundle template) already handles the main binary. Here we kill
  ; helper processes that the app spawns and that frequently keep WebView2
  ; / data files locked when the uninstaller tries to RmDir /r.
  ;
  ; We use taskkill so we don't depend on the nsProcess plugin being bundled.
  ; /T terminates child processes too. Errors are silently ignored — the
  ; process may simply not be running.
  nsExec::Exec 'taskkill /F /T /IM "llama-server.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "bun.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "uv.exe"'
  Pop $0

  ; msedgewebview2.exe is shared with other Edge-based apps on the system —
  ; we must only kill instances that belong to *our* WebView2 user data
  ; directory (%LOCALAPPDATA%\chat.atomic.app). PowerShell filters by the
  ; process MainModule path. -EA SilentlyContinue + try/catch so we never
  ; abort uninstall if PowerShell is missing or a process exits mid-query.
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Where-Object { try { $_.MainModule.FileName -like \"*chat.atomic.app*\" } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0

  ; Give the kernel a moment to release file handles after TerminateProcess.
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    ; Clean the user data folder (models, backends, threads, logs, ...).
    RmDir /r "$APPDATA\Radium"
    ; Its earlier names: Atomic Chat before the product rename, and the
    ; usually empty Radium Chat folder older jan-cli builds could leave.
    RmDir /r "$APPDATA\Atomic Chat"
    RmDir /r "$APPDATA\Radium Chat"
    ; Clean the legacy settings.json folder (older builds).
    RmDir /r "$APPDATA\Atomic-Chat"
    ; Tauri default already removes %LOCALAPPDATA%\chat.atomic.app, but
    ; perUser/passive uninstalls sometimes leave EBWebView lockfiles behind.
    ; Redo it idempotently — no-op if the directory is already gone.
    RmDir /r "$LOCALAPPDATA\chat.atomic.app"
    ; Drop the per-user AUMID registration used by Toast notifications in dev builds.
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\chat.atomic.app"
  ${EndIf}
!macroend
