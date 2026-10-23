#Requires -Version 5.1
# scripts/verify-windows-installer.ps1
# Atomic Chat - end-to-end check of a Windows NSIS installer against the
# Microsoft Store requirements for EXE apps (policy 10.2.9).
#
# The Store installs an EXE app silently as a standard user, expects every PE
# file it ships to carry a valid Authenticode signature, reads the Add/Remove
# Programs entry, and uninstalls silently again. This script walks the same
# path and records one result row (PASS / FAIL / INFO / SKIP) per check:
#    1. Preflight: refuses to run where Atomic Chat is already installed.
#    2. The installer is signed (Valid, by AtomicMail Systems OU).
#    3. Silent install with /S exits 0.
#    4. The Add/Remove Programs entry carries its metadata.
#    5. A Start Menu shortcut exists.
#    6. Every PE file in the install dir has a Valid signature.
#    7. The WebView2 runtime is registered.
#    8. The app starts and stays up (skipped with -SkipLaunch).
#    9. Silent uninstall with /S (skipped with -KeepInstalled).
#   10. The install dir, uninstall key and shortcuts are gone; the user data a
#       silent uninstall keeps by design is listed for information.
#
# A manual check, not part of CI, and not read-only: it installs Atomic Chat
# for the current user, may start it, and uninstalls it again. Run it in a
# clean profile; a fresh local standard user account is closest to the
# Store's own test.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows-installer.ps1 `
#     -Installer 'C:\Builds\Atomic Chat_2.2.23_x64-setup.exe'
#   Over SSH, where there is no interactive desktop, skip the launch check:
#     scp scripts/verify-windows-installer.ps1 setup.exe <user>@<host>:
#     ssh <user>@<host> powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File verify-windows-installer.ps1 -Installer setup.exe -SkipLaunch
#
# Exit codes: 0 every check passed, 1 at least one check failed, 2 the check
# could not run (not Windows, installer missing, Atomic Chat already
# installed).
#
# Requirements: Windows PowerShell 5.1 or PowerShell 7. No admin rights: the
# installer is per-user (NSIS installMode currentUser) and never asks for UAC.

[CmdletBinding()]
param(
    # Path to the NSIS setup .exe to check.
    [Parameter(Mandatory = $true)]
    [string]$Installer,

    # Do not start the app (over SSH there is no desktop to start it on).
    [switch]$SkipLaunch,

    # How long the silent install may take before it counts as hung.
    [ValidateRange(30, 3600)]
    [int]$InstallTimeoutSeconds = 600,

    # How long the app has to stay up after it starts.
    [ValidateRange(1, 3600)]
    [int]$LaunchSeconds = 20,

    # How long to wait for the uninstaller to remove its key and the install dir.
    [ValidateRange(10, 3600)]
    [int]$UninstallTimeoutSeconds = 120,

    # Leave the app installed: skip the uninstall and leftover checks.
    [switch]$KeepInstalled
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

if ($env:OS -ne 'Windows_NT') {
    Write-Host '[FATAL] This check runs on Windows only.' -ForegroundColor Red
    exit 2
}
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    Write-Host "[FATAL] Installer not found: $Installer" -ForegroundColor Red
    exit 2
}
$installerPath = (Resolve-Path -LiteralPath $Installer).ProviderPath

# What the Tauri NSIS bundle installs (src-tauri/tauri.conf.json, Cargo.toml).
$ProductName       = 'Atomic Chat'
$MainExeName       = 'Atomic-Chat.exe'
$MainProcessName   = 'Atomic-Chat'
$CoreProcessName   = 'atomic-chat-app-core'
$ExpectedSigner    = 'CN=AtomicMail Systems OU'
$defaultInstallDir = Join-Path $env:LOCALAPPDATA $ProductName

$uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)

# The WebView2 runtime's EdgeUpdate client; its `pv` value is the installed
# version (system-wide in either registry view, or per-user).
$webView2Keys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)

# User data a silent uninstall keeps by design: only the "Delete app data"
# checkbox of the interactive uninstaller removes it (src-tauri/windows/hooks.nsh).
$userDataDirs = @(
    (Join-Path $env:APPDATA 'Atomic Chat'),
    (Join-Path $env:APPDATA 'Atomic-Chat'),
    (Join-Path $env:APPDATA 'chat.atomic.app'),
    (Join-Path $env:LOCALAPPDATA 'chat.atomic.app'),
    (Join-Path $env:APPDATA 'atomic-managed-runtimes'),
    (Join-Path $env:LOCALAPPDATA 'AtomicChat')
)

$results = New-Object System.Collections.Generic.List[object]

function Write-Section($title) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host (" $title") -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}

function Add-Result {
    param([string]$Step, [string]$Status, [string]$Detail)
    $script:results.Add([pscustomobject]@{ Step = $Step; Status = $Status; Detail = $Detail })
    $color = 'Gray'
    if ($Status -eq 'PASS') { $color = 'Green' }
    if ($Status -eq 'FAIL') { $color = 'Red' }
    if ($Status -eq 'SKIP') { $color = 'Yellow' }
    Write-Host ('  [{0}] {1}: {2}' -f $Status, $Step, $Detail) -ForegroundColor $color
}

function Add-Unexpected {
    # A step threw: record it as a failure and let the later steps run.
    param([string]$Step, $ErrorRecord)
    Add-Result $Step 'FAIL' ('unexpected error: ' + $ErrorRecord.Exception.Message)
}

function Find-UninstallEntry {
    # Every Uninstall key, in both hives and both registry views, whose
    # DisplayName is the product name. Tauri names the key after the product;
    # matching on DisplayName also catches an MSI install (GUID-named key).
    $found = @()
    foreach ($root in $script:uninstallRoots) {
        foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            $displayName = $null
            try { $displayName = $key.GetValue('DisplayName') } catch { }
            if ($displayName -eq $script:ProductName) {
                $found += [pscustomobject]@{ Name = $key.Name; PSPath = $key.PSPath; Key = $key }
            }
        }
    }
    return $found
}

function Test-PortableExecutable {
    # True for a PE image (an MZ header pointing at a PE signature), whatever
    # its extension: the Store wants every PE file signed, not only .exe/.dll.
    param([string]$Path)
    $stream = $null
    try {
        $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        if ($stream.Length -lt 64) { return $false }
        $reader = New-Object System.IO.BinaryReader($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) { return $false }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -le 0 -or ($peOffset + 4) -gt $stream.Length) { return $false }
        $stream.Position = $peOffset
        return ($reader.ReadUInt32() -eq 0x4550)
    } catch {
        return $false
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Get-SignerName {
    # The signer certificate's CN, or '' when the file carries no signature.
    param($Signature)
    if ($null -eq $Signature -or $null -eq $Signature.SignerCertificate) { return '' }
    $simpleName = [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName
    return $Signature.SignerCertificate.GetNameInfo($simpleName, $false)
}

function Get-RelativePath {
    param([string]$Root, [string]$Path)
    $prefix = $Root.TrimEnd('\') + '\'
    if ($Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring($prefix.Length)
    }
    return $Path
}

function Split-CommandLine {
    # UninstallString is a command line: a quoted (or bare) exe path plus
    # optional arguments. Tauri writes "<install dir>\uninstall.exe", quoted.
    param([string]$CommandLine)
    $line = $CommandLine.Trim()
    if ($line -match '^"([^"]+)"\s*(.*)$') {
        return [pscustomobject]@{ Path = $Matches[1]; Arguments = $Matches[2] }
    }
    if ($line -match '^(.+?\.exe)(\s+(.*))?$') {
        return [pscustomobject]@{ Path = $Matches[1]; Arguments = $Matches[3] }
    }
    return [pscustomobject]@{ Path = $line; Arguments = '' }
}

function Test-UninstallerCopyRunning {
    # The NSIS uninstaller copies itself to %TEMP%\~nsu*.tmp and re-runs from
    # there (Au_.exe or Un_A.exe, by NSIS version), so the uninstall.exe we
    # start exits at once. Spot the copy by its name or its folder.
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
        if ($p.ProcessName -eq 'Au_' -or $p.ProcessName -like 'Un_?') { return $true }
        $exePath = $null
        try { $exePath = $p.Path } catch { }
        if ($exePath -and $exePath -like '*\~nsu*.tmp\*') { return $true }
    }
    return $false
}

function Stop-AtomicChat {
    # As in src-tauri/windows/hooks.nsh: the app core runs detached, so it
    # needs a taskkill of its own; /T takes the app's WebView2 children and the
    # core's llama-server / sd-server / cloudflared with it. cmd.exe keeps
    # taskkill's output (and its "not found" error) out of the report.
    foreach ($image in @($script:MainExeName, ($script:CoreProcessName + '.exe'))) {
        $null = & cmd.exe /c "taskkill /F /T /IM $image >nul 2>&1"
    }
    Start-Sleep -Seconds 2
}

$bar = '+' + ('-' * 74) + '+'
Write-Host ''
Write-Host $bar -ForegroundColor Green
Write-Host ('|   {0,-71}|' -f 'Atomic Chat - Windows installer check (Microsoft Store 10.2.9)') -ForegroundColor Green
Write-Host ('|   {0,-71}|' -f 'Installs, checks and uninstalls the app for the current user.') -ForegroundColor Green
Write-Host $bar -ForegroundColor Green
Write-Host ''
Write-Host "Installer: $installerPath"

# State the later steps build on.
$installOk        = $false
$installerSigner  = ''
$entry            = $null
$installDir       = $null
$uninstallExe     = $null
$shortcuts        = @()
$desktopShortcuts = @()
$uninstallRan     = $false

# -----------------------------------------------------------------------------
# 1. Preflight
# -----------------------------------------------------------------------------
Write-Section '1/10  Preflight'

try {
    $existing = @(Find-UninstallEntry)
} catch {
    Write-Host "[FATAL] Could not read the Uninstall registry keys: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}
if ($existing.Count -gt 0) {
    Write-Host ''
    Write-Host "[FATAL] $ProductName is already installed:" -ForegroundColor Red
    foreach ($e in $existing) {
        Write-Host "  $($e.Name)" -ForegroundColor Red
        Write-Host "    UninstallString: $($e.Key.GetValue('UninstallString'))"
    }
    Write-Host ''
    Write-Host 'This check needs a profile where the app is not installed, so that it sees'
    Write-Host 'exactly what the installer writes and what the uninstaller removes.'
    Write-Host 'Uninstall it first or, better, run the check from a fresh local standard'
    Write-Host 'user account: the Microsoft Store test also runs as a standard user.'
    exit 2
}
Add-Result 'Preflight' 'PASS' "no '$ProductName' Uninstall key under HKCU or HKLM"

try {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $elevated  = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    # A filtered (non-elevated) admin token still lists the Administrators
    # group (S-1-5-32-544) as deny-only; IsInRole alone would miss that.
    $inAdmins  = @(& whoami.exe /groups | Select-String -SimpleMatch 'S-1-5-32-544').Count -gt 0
    $detail = '{0}; member of Administrators: {1}; elevated: {2}' -f $identity.Name, $inAdmins, $elevated
    if ($inAdmins) {
        $detail += '. The Store test runs as a standard user; a fresh local standard account is closer to it'
    }
    Add-Result 'Current user' 'INFO' $detail
} catch {
    Add-Result 'Current user' 'INFO' ('could not determine: ' + $_.Exception.Message)
}

try {
    $cv = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    Add-Result 'Environment' 'INFO' ('{0} {1} (build {2}.{3}); {4}; PowerShell {5}' -f $cv.ProductName, $cv.DisplayVersion, $cv.CurrentBuild, $cv.UBR, $env:PROCESSOR_ARCHITECTURE, $PSVersionTable.PSVersion)
} catch {
    Add-Result 'Environment' 'INFO' ('could not read the Windows version: ' + $_.Exception.Message)
}

if (Test-Path -LiteralPath $defaultInstallDir) {
    Add-Result 'Install dir before install' 'INFO' "$defaultInstallDir already exists (left over from an earlier install?); the leftover check may report its files"
}

if (Get-Item -LiteralPath $installerPath -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue) {
    Add-Result 'Mark of the Web' 'INFO' 'the installer carries a Zone.Identifier stream (downloaded file); if the silent install stalls on a security prompt, run Unblock-File on it first'
}

if (-not $SkipLaunch -and ($env:SSH_CONNECTION -or $env:SSH_CLIENT)) {
    Add-Result 'SSH session' 'INFO' 'running over SSH without -SkipLaunch: there is no interactive desktop here, so the launch check proves little'
}

# -----------------------------------------------------------------------------
# 2. Installer signature
# -----------------------------------------------------------------------------
Write-Section '2/10  Installer signature'

try {
    $sig = Get-AuthenticodeSignature -LiteralPath $installerPath
    $installerSigner = Get-SignerName $sig
    $subject = ''
    if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }
    $stamped = 'no'
    if ($sig.TimeStamperCertificate) { $stamped = 'yes' }
    Write-Host "  Status:      $($sig.Status)"
    Write-Host "  Subject:     $subject"
    Write-Host "  Timestamped: $stamped"
    if ($sig.Status -ne 'Valid') {
        Add-Result 'Installer signature' 'FAIL' ('status {0}: {1}' -f $sig.Status, $sig.StatusMessage)
    } elseif ($subject -notlike "*$ExpectedSigner*") {
        Add-Result 'Installer signature' 'FAIL' ("Valid, but signed by '{0}'; expected {1}" -f $subject, $ExpectedSigner)
    } else {
        Add-Result 'Installer signature' 'PASS' ('Valid; signer {0}; timestamped: {1}' -f $installerSigner, $stamped)
    }
} catch {
    Add-Unexpected 'Installer signature' $_
}

try {
    $item = Get-Item -LiteralPath $installerPath
    Add-Result 'Installer size' 'INFO' ('{0:N1} MB ({1:N0} bytes); product version {2}' -f ($item.Length / 1MB), $item.Length, $item.VersionInfo.ProductVersion)
} catch {
    Add-Unexpected 'Installer size' $_
}

# -----------------------------------------------------------------------------
# 3. Silent install
# -----------------------------------------------------------------------------
Write-Section '3/10  Silent install (/S)'

try {
    Write-Host "  Running: `"$installerPath`" /S"
    # Wait for the installer process itself, not -Wait: Windows PowerShell's
    # -Wait also waits for every process the installer leaves running, and a
    # hang here would block an SSH run forever.
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $installerPath -ArgumentList '/S' -PassThru
    # Holding the handle keeps ExitCode readable once the process is gone.
    $null = $proc.Handle
    $finished = $proc.WaitForExit($InstallTimeoutSeconds * 1000)
    $sw.Stop()
    $took = '{0:N1} s' -f $sw.Elapsed.TotalSeconds
    $code = $null
    if ($finished) { $code = $proc.ExitCode }
    if (-not $finished) {
        Add-Result 'Silent install' 'FAIL' "the installer was still running after $took"
    } elseif ($code -eq 0) {
        $installOk = $true
        Add-Result 'Silent install' 'PASS' "exit code 0 in $took"
    } else {
        # NSIS exit codes: 1 cancelled by the user, 2 aborted (an error).
        $meaning = 'unexpected exit code'
        if ($code -eq 1) { $meaning = 'cancelled' }
        if ($code -eq 2) { $meaning = 'aborted with an error' }
        Add-Result 'Silent install' 'FAIL' ('exit code {0} ({1}) after {2}' -f $code, $meaning, $took)
    }
} catch {
    Add-Unexpected 'Silent install' $_
}

# -----------------------------------------------------------------------------
# 4. Add/Remove Programs entry
# -----------------------------------------------------------------------------
Write-Section '4/10  Add/Remove Programs entry'

try {
    $entries = @(Find-UninstallEntry)
    if ($entries.Count -eq 0) {
        Add-Result 'Add/Remove Programs' 'FAIL' "no Uninstall key with DisplayName '$ProductName' under HKCU or HKLM"
    } else {
        # A per-user install writes to HKCU; prefer that key if there are several.
        $entry = $entries | Sort-Object { if ($_.Name -like 'HKEY_CURRENT_USER\*') { 0 } else { 1 } } | Select-Object -First 1
        if ($entries.Count -gt 1) {
            Add-Result 'Add/Remove Programs keys' 'INFO' ('{0} keys found, checking the first: {1}' -f $entries.Count, (($entries | ForEach-Object { $_.Name }) -join '; '))
        }
        Write-Host "  Key: $($entry.Name)"
        $values = @{}
        foreach ($valueName in $entry.Key.GetValueNames()) {
            $values[$valueName] = $entry.Key.GetValue($valueName)
            $label = $valueName
            if (-not $label) { $label = '(default)' }
            Write-Host ('    {0,-22} {1}' -f $label, $values[$valueName])
        }

        $missing = @()
        foreach ($required in @('DisplayName', 'Publisher', 'DisplayVersion', 'UninstallString')) {
            if (-not $values.ContainsKey($required) -or [string]::IsNullOrWhiteSpace([string]$values[$required])) {
                $missing += $required
            }
        }
        if ($missing.Count -gt 0) {
            Add-Result 'Add/Remove Programs' 'FAIL' ('{0}: missing or empty {1}' -f $entry.Name, ($missing -join ', '))
        } else {
            Add-Result 'Add/Remove Programs' 'PASS' ("{0}: DisplayName '{1}', Publisher '{2}', DisplayVersion {3}" -f $entry.Name, $values['DisplayName'], $values['Publisher'], $values['DisplayVersion'])
        }
        if ($entry.Name -notlike 'HKEY_CURRENT_USER\*') {
            Add-Result 'Add/Remove Programs hive' 'INFO' 'the entry is per-machine (HKLM); the NSIS installer is expected to install per user (HKCU)'
        }
        if ($installerSigner -and $values['Publisher'] -and ([string]$values['Publisher'] -ne $installerSigner)) {
            Add-Result 'Publisher vs signer' 'INFO' ("Publisher '{0}' differs from the installer's signer '{1}'" -f $values['Publisher'], $installerSigner)
        }

        if (-not [string]::IsNullOrWhiteSpace([string]$values['UninstallString'])) {
            $uninstallExe = (Split-CommandLine ([string]$values['UninstallString'])).Path
        }
        # Tauri writes InstallLocation quoted, like UninstallString.
        $location = ''
        if ($values['InstallLocation']) { $location = ([string]$values['InstallLocation']).Trim().Trim('"').TrimEnd('\') }
        if ($location) {
            $installDir = $location
            $status = 'PASS'
            $detail = $installDir
        } elseif ($uninstallExe) {
            $installDir = Split-Path -Parent $uninstallExe
            $status = 'INFO'
            $detail = "missing; using the folder of UninstallString: $installDir"
        } else {
            $status = 'FAIL'
            $detail = 'missing, and there is no UninstallString to derive it from'
        }
        if ($installDir -and -not (Test-Path -LiteralPath $installDir -PathType Container)) {
            $status = 'FAIL'
            $detail = "$installDir does not exist"
        } elseif ($installDir -and ($installDir -ne $defaultInstallDir)) {
            $detail += " (the default per-user location is $defaultInstallDir)"
        }
        Add-Result 'InstallLocation' $status $detail
    }
} catch {
    Add-Unexpected 'Add/Remove Programs' $_
}

# Without a usable entry, fall back to the default location so the file checks
# below still have something to look at.
if (-not $installDir -and (Test-Path -LiteralPath $defaultInstallDir -PathType Container)) {
    $installDir = $defaultInstallDir
    Add-Result 'Install dir' 'INFO' "no usable Add/Remove Programs entry; checking the default location $installDir"
}
if (-not $uninstallExe -and $installDir) {
    $candidate = Join-Path $installDir 'uninstall.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $uninstallExe = $candidate }
}

# -----------------------------------------------------------------------------
# 5. Start Menu shortcut
# -----------------------------------------------------------------------------
Write-Section '5/10  Start Menu shortcut'

try {
    $programsDir = [Environment]::GetFolderPath('Programs')
    $shortcuts = @(Get-ChildItem -LiteralPath $programsDir -Recurse -File -Filter "$ProductName*.lnk" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    if ($shortcuts.Count -eq 0) {
        Add-Result 'Start Menu shortcut' 'FAIL' "no '$ProductName*.lnk' under $programsDir"
    } else {
        $shell = $null
        try { $shell = New-Object -ComObject WScript.Shell } catch { }
        $described = @()
        $broken = @()
        foreach ($lnk in $shortcuts) {
            $target = $null
            if ($shell) {
                try { $target = $shell.CreateShortcut($lnk).TargetPath } catch { }
            }
            if ($target -and -not (Test-Path -LiteralPath $target)) { $broken += $lnk }
            if (-not $target) { $target = '(target unknown)' }
            $described += ('{0} -> {1}' -f (Get-RelativePath $programsDir $lnk), $target)
        }
        if ($broken.Count -gt 0) {
            Add-Result 'Start Menu shortcut' 'FAIL' ('target missing: ' + ($described -join '; '))
        } else {
            Add-Result 'Start Menu shortcut' 'PASS' ($described -join '; ')
        }
    }
} catch {
    Add-Unexpected 'Start Menu shortcut' $_
}

try {
    $desktopDir = [Environment]::GetFolderPath('Desktop')
    $desktopShortcuts = @(Get-ChildItem -LiteralPath $desktopDir -File -Filter "$ProductName*.lnk" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    if ($desktopShortcuts.Count -gt 0) {
        Add-Result 'Desktop shortcut' 'INFO' ($desktopShortcuts -join '; ')
    } else {
        Add-Result 'Desktop shortcut' 'INFO' 'none'
    }
} catch {
    Add-Unexpected 'Desktop shortcut' $_
}

# -----------------------------------------------------------------------------
# 6. Authenticode signatures of every PE file in the install dir
# -----------------------------------------------------------------------------
Write-Section '6/10  Signatures of PE files in the install dir'

try {
    if (-not $installDir -or -not (Test-Path -LiteralPath $installDir -PathType Container)) {
        Add-Result 'PE signatures' 'FAIL' 'install dir not found, nothing to check'
    } else {
        $files = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Force -ErrorAction SilentlyContinue)
        $peFiles = @($files | Where-Object { @('.exe', '.dll') -contains $_.Extension -or (Test-PortableExecutable $_.FullName) })
        Write-Host ('  {0} files in {1}, {2} of them PE files; checking signatures...' -f $files.Count, $installDir, $peFiles.Count)

        # Vendor-signed files (Cloudflare cloudflared, Microsoft wxc-exec,
        # NVIDIA DLLs) are fine: inside the install dir only Valid is required.
        $sigRows = @(foreach ($f in $peFiles) {
            $rowStatus = ''
            $rowSigner = ''
            $rowMessage = ''
            try {
                $fileSig = Get-AuthenticodeSignature -LiteralPath $f.FullName
                $rowStatus = [string]$fileSig.Status
                $rowSigner = Get-SignerName $fileSig
                $rowMessage = $fileSig.StatusMessage
            } catch {
                $rowStatus = 'Error'
                $rowMessage = $_.Exception.Message
            }
            [pscustomobject]@{
                Path    = Get-RelativePath $installDir $f.FullName
                Status  = $rowStatus
                Signer  = $rowSigner
                Message = $rowMessage
            }
        })
        $sigRows | Sort-Object Path | Format-Table Path, Status, Signer -AutoSize | Out-String -Width 4096 | Write-Host

        $bad = @($sigRows | Where-Object { $_.Status -ne 'Valid' })
        if ($sigRows.Count -eq 0) {
            Add-Result 'PE signatures' 'FAIL' "no PE files found in $installDir"
        } elseif ($bad.Count -eq 0) {
            $bySigner = @($sigRows | Group-Object Signer | Sort-Object Count -Descending | ForEach-Object { '{0} x{1}' -f $_.Name, $_.Count })
            Add-Result 'PE signatures' 'PASS' ('all {0} PE files Valid; signers: {1}' -f $sigRows.Count, ($bySigner -join ', '))
        } else {
            Write-Host '  Not Valid:' -ForegroundColor Red
            foreach ($b in ($bad | Sort-Object Path)) {
                Write-Host ('    {0}  [{1}]  {2}' -f $b.Path, $b.Status, $b.Message) -ForegroundColor Red
            }
            $listed = @($bad | Sort-Object Path | Select-Object -First 20 | ForEach-Object { '{0} ({1})' -f $_.Path, $_.Status })
            $detail = '{0} of {1} PE files not Valid: {2}' -f $bad.Count, $sigRows.Count, ($listed -join '; ')
            if ($bad.Count -gt 20) { $detail += ('; and {0} more (full list above)' -f ($bad.Count - 20)) }
            Add-Result 'PE signatures' 'FAIL' $detail
        }

        # Our own two binaries must be among the files checked.
        foreach ($required in @($MainExeName, 'uninstall.exe')) {
            $row = $sigRows | Where-Object { $_.Path -eq $required } | Select-Object -First 1
            if (-not $row) {
                Add-Result "Signature: $required" 'FAIL' 'not found at the top of the install dir'
            } elseif ($row.Status -eq 'Valid') {
                Add-Result "Signature: $required" 'PASS' "Valid; signer $($row.Signer)"
            } else {
                Add-Result "Signature: $required" 'FAIL' ('status {0}; signer {1}' -f $row.Status, $row.Signer)
            }
        }
    }
} catch {
    Add-Unexpected 'PE signatures' $_
}

# -----------------------------------------------------------------------------
# 7. WebView2 runtime
# -----------------------------------------------------------------------------
Write-Section '7/10  WebView2 runtime'

try {
    $webView2 = $null
    foreach ($keyPath in $webView2Keys) {
        $pv = $null
        try { $pv = (Get-ItemProperty -LiteralPath $keyPath -Name 'pv' -ErrorAction Stop).pv } catch { }
        if ($pv -and $pv -ne '0.0.0.0') {
            $webView2 = "version $pv ($keyPath)"
            break
        }
    }
    if ($webView2) {
        Add-Result 'WebView2' 'PASS' $webView2
    } else {
        Add-Result 'WebView2' 'FAIL' 'no pv under EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5} (HKLM, HKLM WOW6432Node, HKCU)'
    }
} catch {
    Add-Unexpected 'WebView2' $_
}

# -----------------------------------------------------------------------------
# 8. Launch
# -----------------------------------------------------------------------------
Write-Section '8/10  Launch'

if ($SkipLaunch) {
    Add-Result 'Launch' 'SKIP' '-SkipLaunch'
} elseif (-not $installOk) {
    Add-Result 'Launch' 'SKIP' 'the silent install failed'
} else {
    try {
        $mainExe = $null
        if ($installDir) { $mainExe = Join-Path $installDir $MainExeName }
        if (-not $mainExe -or -not (Test-Path -LiteralPath $mainExe -PathType Leaf)) {
            Add-Result 'Launch' 'FAIL' "$MainExeName not found in the install dir"
        } else {
            Write-Host "  Starting $mainExe, waiting $LaunchSeconds s"
            $app = Start-Process -FilePath $mainExe -WorkingDirectory $installDir -PassThru
            # Holding the handle keeps ExitCode readable once the process is gone.
            $null = $app.Handle
            Start-Sleep -Seconds $LaunchSeconds
            $app.Refresh()
            if ($app.HasExited) {
                Add-Result 'Launch' 'FAIL' ('{0} exited with code {1} within {2} s' -f $MainExeName, $app.ExitCode, $LaunchSeconds)
            } else {
                Add-Result 'Launch' 'PASS' ('{0} still running after {1} s (PID {2})' -f $MainExeName, $LaunchSeconds, $app.Id)
            }
            $core = @(Get-Process -Name $CoreProcessName -ErrorAction SilentlyContinue)
            if ($core.Count -gt 0) {
                Add-Result 'App core' 'INFO' ('{0} running (PID {1})' -f $CoreProcessName, (($core | ForEach-Object { $_.Id }) -join ', '))
            } else {
                Add-Result 'App core' 'INFO' "$CoreProcessName not running"
            }
        }
    } catch {
        Add-Unexpected 'Launch' $_
    } finally {
        try {
            Stop-AtomicChat
            $still = @(Get-Process -Name $MainProcessName, $CoreProcessName -ErrorAction SilentlyContinue)
            if ($still.Count -gt 0) {
                Add-Result 'Stop app' 'INFO' ('still running after taskkill: ' + (($still | ForEach-Object { '{0} ({1})' -f $_.ProcessName, $_.Id }) -join ', '))
            }
        } catch {
            Add-Unexpected 'Stop app' $_
        }
    }
}

# -----------------------------------------------------------------------------
# 9. Silent uninstall
# -----------------------------------------------------------------------------
Write-Section '9/10  Silent uninstall (/S)'

if ($KeepInstalled) {
    Add-Result 'Silent uninstall' 'SKIP' '-KeepInstalled'
    if ($uninstallExe) { Write-Host "  Uninstall later with: & '$uninstallExe' /S" }
} elseif (-not $installOk) {
    Add-Result 'Silent uninstall' 'SKIP' 'the silent install failed; the machine is left as it is for inspection'
    if ($uninstallExe) { Write-Host "  Clean up with: & '$uninstallExe' /S" }
} elseif (-not $uninstallExe -or -not (Test-Path -LiteralPath $uninstallExe -PathType Leaf)) {
    Add-Result 'Silent uninstall' 'FAIL' 'no uninstaller found (neither UninstallString nor uninstall.exe in the install dir)'
} else {
    try {
        $uninstallRan = $true
        Write-Host "  Running: `"$uninstallExe`" /S"
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $launcher = Start-Process -FilePath $uninstallExe -ArgumentList '/S' -PassThru
        $null = $launcher.Handle
        # The uninstall.exe we started hands over to its %TEMP% copy and exits,
        # so wait for what the uninstall leaves behind instead: the key and the
        # install dir both gone. Once the copy has been seen and is gone for 5 s,
        # nothing will change any more and the wait can end early.
        $deadline = (Get-Date).AddSeconds($UninstallTimeoutSeconds)
        $keyGone = $false
        $dirGone = $false
        $sawCopy = $false
        $idlePolls = 0
        while ($true) {
            $keyGone = ($null -eq $entry) -or -not (Test-Path -LiteralPath $entry.PSPath)
            $dirGone = (-not $installDir) -or -not (Test-Path -LiteralPath $installDir)
            if ($keyGone -and $dirGone) { break }
            if ((Get-Date) -ge $deadline) { break }
            $copyRunning = Test-UninstallerCopyRunning
            if ($copyRunning) { $sawCopy = $true }
            if ($sawCopy -and -not $copyRunning -and $launcher.HasExited) { $idlePolls++ } else { $idlePolls = 0 }
            if ($idlePolls -ge 5) { break }
            Start-Sleep -Seconds 1
        }
        $sw.Stop()
        if ($launcher.HasExited) { Write-Host "  uninstall.exe exited with code $($launcher.ExitCode)" }
        if ($keyGone -and $dirGone) {
            Add-Result 'Silent uninstall' 'PASS' ('uninstall key and install dir gone after {0:N1} s' -f $sw.Elapsed.TotalSeconds)
        } else {
            $left = @()
            if (-not $keyGone) { $left += 'uninstall key' }
            if (-not $dirGone) { $left += 'install dir' }
            $why = "timed out after $UninstallTimeoutSeconds s"
            if ($idlePolls -ge 5) { $why = ('the uninstaller finished after {0:N1} s' -f $sw.Elapsed.TotalSeconds) }
            Add-Result 'Silent uninstall' 'FAIL' ('{0}, but still present: {1}' -f $why, ($left -join ', '))
        }
    } catch {
        Add-Unexpected 'Silent uninstall' $_
    }
}

# -----------------------------------------------------------------------------
# 10. Leftovers
# -----------------------------------------------------------------------------
Write-Section '10/10  Leftovers'

if (-not $uninstallRan) {
    $why = 'no uninstall was run'
    if ($KeepInstalled) { $why = '-KeepInstalled' }
    Add-Result 'Leftovers' 'SKIP' $why
} else {
    try {
        if ($installDir -and (Test-Path -LiteralPath $installDir)) {
            $remaining = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Force -ErrorAction SilentlyContinue)
            foreach ($r in ($remaining | Select-Object -First 15)) {
                Write-Host ('    {0}' -f (Get-RelativePath $installDir $r.FullName)) -ForegroundColor Red
            }
            Add-Result 'Leftover: install dir' 'FAIL' ('{0} still exists with {1} files (up to 15 listed above)' -f $installDir, $remaining.Count)
        } else {
            Add-Result 'Leftover: install dir' 'PASS' "removed: $installDir"
        }
    } catch {
        Add-Unexpected 'Leftover: install dir' $_
    }

    try {
        $keysLeft = @(Find-UninstallEntry)
        if ($keysLeft.Count -gt 0) {
            Add-Result 'Leftover: uninstall key' 'FAIL' (($keysLeft | ForEach-Object { $_.Name }) -join '; ')
        } else {
            Add-Result 'Leftover: uninstall key' 'PASS' "no '$ProductName' Uninstall key under HKCU or HKLM"
        }
    } catch {
        Add-Unexpected 'Leftover: uninstall key' $_
    }

    try {
        $foundLnk = @(Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Programs')) -Recurse -File -Filter "$ProductName*.lnk" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
        $foundLnk += @(Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Desktop')) -File -Filter "$ProductName*.lnk" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
        $lnkLeft = @(($shortcuts + $desktopShortcuts + $foundLnk) | Sort-Object -Unique | Where-Object { Test-Path -LiteralPath $_ })
        if ($lnkLeft.Count -gt 0) {
            Add-Result 'Leftover: shortcuts' 'FAIL' ($lnkLeft -join '; ')
        } else {
            Add-Result 'Leftover: shortcuts' 'PASS' "no '$ProductName*.lnk' left in the Start Menu or on the Desktop"
        }
    } catch {
        Add-Unexpected 'Leftover: shortcuts' $_
    }

    try {
        $kept = @($userDataDirs | Where-Object { Test-Path -LiteralPath $_ })
        if ($kept.Count -gt 0) {
            Add-Result 'User data kept' 'INFO' (($kept -join '; ') + ' (a silent uninstall keeps user data by design)')
        } else {
            Add-Result 'User data kept' 'INFO' 'none'
        }
    } catch {
        Add-Unexpected 'User data kept' $_
    }
}

# -----------------------------------------------------------------------------
# Results
# -----------------------------------------------------------------------------
Write-Section 'Results'

# A wide Out-String so an SSH session does not truncate the Detail column.
$results | Format-Table Step, Status, Detail -AutoSize | Out-String -Width 4096 | Write-Host

$failed  = @($results | Where-Object { $_.Status -eq 'FAIL' }).Count
$passed  = @($results | Where-Object { $_.Status -eq 'PASS' }).Count
$info    = @($results | Where-Object { $_.Status -eq 'INFO' }).Count
$skipped = @($results | Where-Object { $_.Status -eq 'SKIP' }).Count
Write-Host ('{0} passed, {1} failed, {2} info, {3} skipped' -f $passed, $failed, $info, $skipped)

if ($failed -gt 0) {
    Write-Host ('RESULT: FAIL ({0} check(s) failed)' -f $failed) -ForegroundColor Red
    exit 1
}
Write-Host 'RESULT: PASS' -ForegroundColor Green
exit 0
