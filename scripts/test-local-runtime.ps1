[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$credentialPath = Join-Path $projectRoot 'secrets/local-admin-credentials.txt'
if (-not (Test-Path -LiteralPath $credentialPath)) {
  throw 'Local admin credentials are missing. Run bootstrap first.'
}

$credentials = @{}
Get-Content -LiteralPath $credentialPath | ForEach-Object {
  $parts = $_.Split('=', 2)
  if ($parts.Count -eq 2) { $credentials[$parts[0]] = $parts[1] }
}
if (-not $credentials.email -or -not $credentials.password) {
  throw 'Local admin credentials are malformed.'
}

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
