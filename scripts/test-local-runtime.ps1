[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$credentialPath = Join-Path $projectRoot 'secrets/local-admin-credentials.txt'
$credentials = @{}
if (Test-Path -LiteralPath $credentialPath) {
  Get-Content -LiteralPath $credentialPath | ForEach-Object {
    $parts = $_.Split('=', 2)
    if ($parts.Count -eq 2) { $credentials[$parts[0]] = $parts[1] }
  }
} else {
  $passwordPath = Join-Path $projectRoot 'secrets/local-admin-password.txt'
  if (-not (Test-Path -LiteralPath $passwordPath)) {
    throw 'Local admin credentials are missing. Run bootstrap first.'
  }
  $credentials.email = 'admin@localhost.local'
  $credentials.password = (Get-Content -Raw -LiteralPath $passwordPath).Trim()
}
if (-not $credentials.email -or -not $credentials.password) {
  throw 'Local admin credentials are malformed.'
}

$ready = $null
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  $readyRaw = curl.exe --noproxy '*' --silent "$BaseUrl/health/ready"
  if ($LASTEXITCODE -eq 0) {
    try { $ready = $readyRaw | ConvertFrom-Json } catch { $ready = $null }
    if ($ready.status -eq 'ok') { break }
  }
  Start-Sleep -Seconds 1
}
if ($ready.status -ne 'ok') { throw 'Readiness did not become healthy within 60 seconds.' }

$spaCode = curl.exe --noproxy '*' --silent --show-error --output NUL `
  --write-out '%{http_code}' "$BaseUrl/"
$plainTraversalCode = curl.exe --noproxy '*' --path-as-is --silent --show-error --output NUL `
  --write-out '%{http_code}' "$BaseUrl/assets/../../.env"
$encodedTraversalCode = curl.exe --noproxy '*' --path-as-is --silent --show-error --output NUL `
  --write-out '%{http_code}' "$BaseUrl/assets/%2e%2e%2f%2e%2e%2f.env"
if ($spaCode -ne '200' -or $plainTraversalCode -ne '404' -or $encodedTraversalCode -ne '404') {
  throw "Static routing check failed (spa=$spaCode plain=$plainTraversalCode encoded=$encodedTraversalCode)."
}
Write-Host '[PASS] Readiness, admin SPA and static traversal rejection.'

$cookieJar = [System.IO.Path]::GetTempFileName()
try {
  $loginPayload = @{ email = $credentials.email; password = $credentials.password } |
    ConvertTo-Json -Compress
  $loginRaw = $loginPayload | curl.exe --noproxy '*' --silent --show-error --fail `
    --cookie-jar $cookieJar `
    --header 'content-type: application/json' `
    --header "origin: $BaseUrl" `
    --data-binary '@-' `
    "$BaseUrl/api/v1/auth/login"
  if ($LASTEXITCODE -ne 0) { throw "Live login failed with exit code $LASTEXITCODE" }
  $login = $loginRaw | ConvertFrom-Json
  if ($login.admin.email -ne $credentials.email -or -not $login.csrfToken) {
    throw 'Live login response is incomplete.'
  }

  $meRaw = curl.exe --noproxy '*' --silent --show-error --fail `
    --cookie $cookieJar "$BaseUrl/api/v1/auth/me"
  if ($LASTEXITCODE -ne 0) { throw "Authenticated /me failed with exit code $LASTEXITCODE" }
  $me = $meRaw | ConvertFrom-Json
  if ($me.admin.email -ne $credentials.email) { throw 'Authenticated identity mismatch.' }

  $withoutCsrf = curl.exe --noproxy '*' --silent --show-error --output NUL `
    --write-out '%{http_code}' `
    --cookie $cookieJar `
    --request POST `
    --header "origin: $BaseUrl" `
    "$BaseUrl/api/v1/auth/logout"
  if ($withoutCsrf -ne '403') { throw "Mutation without CSRF returned $withoutCsrf." }

  $logoutRaw = '{}' | curl.exe --noproxy '*' --silent --show-error --fail `
    --cookie $cookieJar `
    --request POST `
    --header "origin: $BaseUrl" `
    --header "x-csrf-token: $($login.csrfToken)" `
    --header 'content-type: application/json' `
    --data-binary '@-' `
    "$BaseUrl/api/v1/auth/logout"
  if ($LASTEXITCODE -ne 0 -or ($logoutRaw | ConvertFrom-Json).ok -ne $true) {
    throw 'CSRF-authenticated logout failed.'
  }

  Write-Host '[PASS] Login, HttpOnly session, authenticated identity, CSRF rejection and logout.'
} finally {
  if (Test-Path -LiteralPath $cookieJar) { Remove-Item -LiteralPath $cookieJar -Force }
}
