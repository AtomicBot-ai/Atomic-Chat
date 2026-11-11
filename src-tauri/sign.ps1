# Authenticode-signs one file with the code signing certificate in Azure Key
# Vault, then checks the signature.
#
# CI only. build-windows in .github/workflows/release.yml passes it to
# `tauri build` as bundle.windows.signCommand, so the bundler calls it for every
# PE file it ships (the app binary, the sidecars, unsigned .exe/.dll resources,
# the NSIS plugins, the uninstaller, the installers and the MSI); the same job
# signs the atomic-chat-core pair with it before bundling. Local builds pass no
# signCommand and stay unsigned.
#
# The private key never leaves the vault: AzureSignTool hashes the file here and
# Key Vault signs the digest. The access token comes just in time from
# scripts/ci/get-keyvault-token.ps1 (GitHub OIDC, cached until shortly before it
# expires), because the bundler signs near the end of a long build.
#
# Needs AzureSignTool and signtool on PATH, and AZURE_CLIENT_ID,
# AZURE_TENANT_ID, AZURE_KEY_VAULT and AZURE_CODESIGN_CERT in the environment
# (the codesign environment's variables). Any failure exits 1, which fails the
# bundler. Tauri shows a failing command's output only with --verbose, and the
# uninstaller is signed by makensis out of its sight, so every line also goes to
# $RUNNER_TEMP/codesign.log, which release.yml prints after each bundling step.

param(
  [Parameter(Mandatory = $true)]
  [string]$Target
)

$ErrorActionPreference = 'Stop'
$log = if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP 'codesign.log' } else { $null }

function Write-SignLog([string]$Message) {
  $line = '[{0:HH:mm:ss}] {1}' -f (Get-Date), $Message
  Write-Host $line
  if ($log) { Add-Content -LiteralPath $log -Value $line -Encoding utf8 }
}

try {
  foreach ($name in 'AZURE_KEY_VAULT', 'AZURE_CODESIGN_CERT') {
    if (-not [Environment]::GetEnvironmentVariable($name)) {
      throw "$name is not set: pass vars.$name of the codesign environment into the job's env"
    }
  }
  foreach ($tool in 'AzureSignTool', 'signtool') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH" }
  }
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw 'no such file' }

  $token = & (Join-Path $PSScriptRoot '..\scripts\ci\get-keyvault-token.ps1')
  if ($token -isnot [string] -or -not $token) { throw 'get-keyvault-token.ps1 returned no token' }

  Write-SignLog "Signing $Target"
  # Native tools: judge them by exit code, not by what they write to stderr.
  $ErrorActionPreference = 'Continue'
  $output = & AzureSignTool sign `
    --azure-key-vault-url "https://$($env:AZURE_KEY_VAULT).vault.azure.net" `
    --azure-key-vault-certificate $env:AZURE_CODESIGN_CERT `
    --azure-key-vault-accesstoken $token `
    --file-digest sha256 `
    --timestamp-rfc3161 http://timestamp.digicert.com `
    --timestamp-digest sha256 `
    $Target 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  foreach ($line in $output) { Write-SignLog "  $line" }
  if ($exitCode -ne 0) { throw "AzureSignTool exited with code $exitCode" }

  $ErrorActionPreference = 'Continue'
  $output = & signtool verify /pa $Target 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($exitCode -ne 0) {
    foreach ($line in $output) { Write-SignLog "  $line" }
    throw "signtool verify /pa exited with code $exitCode"
  }

  Write-SignLog "Signed $Target"
} catch {
  Write-SignLog "ERROR: could not sign ${Target}: $($_.Exception.Message)"
  exit 1
}

exit 0
