param (
  [string]$Target
)

if (-not $env:SM_API_KEY) {
  Write-Host "SM_API_KEY not set, skipping code signing for: $Target"
  exit 0
}

$fingerprint = $env:SM_CODE_SIGNING_CERT_SHA1_HASH
$alias = $env:SM_CERT_ALIAS

if (-not $fingerprint -and -not $alias) {
  Write-Host "SM_CODE_SIGNING_CERT_SHA1_HASH / SM_CERT_ALIAS not set, skipping code signing for: $Target"
  exit 0
}

Write-Host "Signing: $Target"

if ($alias -and $env:SM_CLIENT_CERT_FILE) {
  $storepass = "$env:SM_API_KEY|$env:SM_CLIENT_CERT_FILE|$env:SM_CLIENT_CERT_PASSWORD"
  & smctl sign --keypair-alias $alias --input "$Target"
} elseif ($fingerprint) {
  & smctl sign --fingerprint $fingerprint --input "$Target"
} else {
  & smctl sign --input "$Target"
}

if ($LASTEXITCODE -ne 0) {
  Write-Error "Code signing failed for: $Target (exit code: $LASTEXITCODE)"
  exit 1
}

Write-Host "Successfully signed: $Target"
