# Returns an Azure Key Vault access token for the code signing app, for
# AzureSignTool's --azure-key-vault-accesstoken. Capture it and never print it:
#
#   $token = & ./scripts/ci/get-keyvault-token.ps1
#
# It signs in as the Entra app AZURE_CLIENT_ID of tenant AZURE_TENANT_ID by
# workload identity federation, the exchange azure/login makes, without the
# Azure CLI: the job's GitHub OIDC ID token (audience api://AzureADTokenExchange)
# is the client assertion of a client-credentials request for the Key Vault
# scope. The app's federated credential trusts the subject
# repo:AtomicBot-ai/Atomic-Chat:environment:codesign, so the job runs in the
# codesign environment, whose variables are the AZURE_* values, and has
# `permissions: id-token: write`, which puts ACTIONS_ID_TOKEN_REQUEST_URL and
# ACTIONS_ID_TOKEN_REQUEST_TOKEN into every step and every process it starts.
#
# Why not azure/login and `az account get-access-token`: Tauri's signCommand
# (src-tauri/sign.ps1) signs near the end of a ~40 minute `tauri build`, an
# access token lives 60-90 minutes, and azure/login's OIDC session cannot renew
# itself. This runs just in time instead. The token is cached in RUNNER_TEMP
# with its expiry and reused until five minutes before it expires; then a fresh
# ID token buys a fresh one.

[CmdletBinding()]
param(
  # Ignore the cached token and fetch a new one.
  [switch]$Refresh
)

$ErrorActionPreference = 'Stop'

foreach ($name in 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID') {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    throw "$name is not set: pass vars.$name of the codesign environment into the job's env"
  }
}
if (-not $env:ACTIONS_ID_TOKEN_REQUEST_URL -or -not $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  throw 'No GitHub OIDC token endpoint in the environment: the job needs `permissions: id-token: write`'
}

$cacheDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$cachePath = Join-Path $cacheDir 'keyvault-token.json'
$minRemainingSeconds = 300

if (-not $Refresh -and (Test-Path -LiteralPath $cachePath)) {
  try {
    $cached = Get-Content -LiteralPath $cachePath -Raw | ConvertFrom-Json
    $remaining = [long]$cached.expires_on - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($cached.client_id -eq $env:AZURE_CLIENT_ID -and $cached.tenant_id -eq $env:AZURE_TENANT_ID -and
        $cached.access_token -and $remaining -gt $minRemainingSeconds) {
      return [string]$cached.access_token
    }
  } catch {
    Write-Host "Ignoring an unreadable Key Vault token cache: $($_.Exception.Message)"
  }
}

function Request-KeyVaultToken {
  # A fresh ID token on every attempt: it lives only minutes, and Entra
  # refuses an expired assertion.
  $audience = [Uri]::EscapeDataString('api://AzureADTokenExchange')
  $idToken = (Invoke-RestMethod -Method Get -Uri "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=$audience" `
      -Headers @{ Authorization = "bearer $($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN)" }).value
  if (-not $idToken) { throw 'GitHub returned no OIDC ID token' }

  Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$($env:AZURE_TENANT_ID)/oauth2/v2.0/token" `
    -ContentType 'application/x-www-form-urlencoded' `
    -Body @{
      client_id             = $env:AZURE_CLIENT_ID
      scope                 = 'https://vault.azure.net/.default'
      grant_type            = 'client_credentials'
      client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
      client_assertion      = $idToken
    }
}

$maxAttempts = 4
for ($attempt = 1; ; $attempt++) {
  $requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  try {
    $response = Request-KeyVaultToken
    break
  } catch {
    $status = 0
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
    }
    # Entra's error body names the cause (AADSTS700213: no federated credential
    # matches the subject, and so on) and carries no secret.
    $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    $transient = $status -eq 0 -or $status -eq 408 -or $status -eq 429 -or $status -ge 500
    if (-not $transient -or $attempt -ge $maxAttempts) {
      throw "Could not get a Key Vault access token (attempt $attempt/$maxAttempts, HTTP $status): $detail"
    }
    Write-Host "Key Vault token request failed (attempt $attempt/$maxAttempts, HTTP $status), retrying: $detail"
    Start-Sleep -Seconds (5 * $attempt)
  }
}

$token = [string]$response.access_token
if (-not $token) { throw 'The Entra token response holds no access_token' }
$expiresOn = $requestedAt + [long]$response.expires_in
Write-Host ("Fetched a Key Vault access token, valid until {0:u}" -f [DateTimeOffset]::FromUnixTimeSeconds($expiresOn))

# Written aside and renamed, so a reader never sees half a file.
try {
  $partial = "$cachePath.$PID.tmp"
  [ordered]@{
    client_id    = $env:AZURE_CLIENT_ID
    tenant_id    = $env:AZURE_TENANT_ID
    expires_on   = $expiresOn
    access_token = $token
  } | ConvertTo-Json | Set-Content -LiteralPath $partial -Encoding utf8
  Move-Item -LiteralPath $partial -Destination $cachePath -Force
} catch {
  Write-Host "Could not cache the Key Vault access token: $($_.Exception.Message)"
}

return $token
