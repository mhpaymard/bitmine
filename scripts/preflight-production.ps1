[CmdletBinding()]
param(
  [string]$BaseUrl = 'https://gateway.local:8443',
  [string]$StratumHost = 'gateway.local',
  [int]$StratumPort = 443,
  [switch]$SkipQuality,
  [switch]$SkipLive
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Check([string]$Name, [scriptblock]$Action) {
  try {
    & $Action
    Write-Host "[PASS] $Name" -ForegroundColor Green
  } catch {
    $failures.Add("${Name}: $($_.Exception.Message)")
    Write-Host "[FAIL] $Name - $($_.Exception.Message)" -ForegroundColor Red
  }
}

function Invoke-Checked([string]$Name, [scriptblock]$Action) {
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$Name exited with code $LASTEXITCODE" }
}

Check 'Node.js 24+' {
  $major = [int]((node --version).TrimStart('v').Split('.')[0])
  if ($major -lt 24) { throw "Node.js 24+ required; found $major" }
}

Check 'TLS validation environment' {
  if ($env:NODE_TLS_REJECT_UNAUTHORIZED -eq '0') {
    throw 'NODE_TLS_REJECT_UNAUTHORIZED=0 must be removed from the service environment'
  }
}

Check 'Configuration and secrets' {
  $required = @(
    '.env', '.env.infrastructure',
    'secrets/app-encryption.key', 'secrets/cookie-secret.txt',
    'secrets/postgres-password.txt', 'secrets/redis-password.txt',
    'secrets/bitcoin-rpc-password.txt', 'secrets/bitcoin-wallet-passphrase.txt',
    'secrets/monero-rpc-password.txt', 'secrets/monero-wallet-passphrase.txt',
    'secrets/grafana-admin-password.txt',
    'secrets/stratum-tls-cert.pem', 'secrets/stratum-tls-key.pem'
  )
  $missing = $required | Where-Object { -not (Test-Path -LiteralPath $_) }
  if ($missing) { throw "Missing: $($missing -join ', ')" }

  $backupLine = Get-Content -LiteralPath '.env.infrastructure' |
    Where-Object { $_ -match '^BACKUP_AGE_RECIPIENT=age1[0-9a-z]+$' } |
    Select-Object -Last 1
  if (-not $backupLine) { throw 'BACKUP_AGE_RECIPIENT must contain a valid age public recipient' }
  if (Test-Path -LiteralPath 'secrets/backup-age-identity.txt') {
    throw 'The private age identity must not be stored on the production server'
  }
  if (
    (Test-Path -LiteralPath 'INITIAL_WALLET_SEED.txt') -or
    (Test-Path -LiteralPath 'secrets/INITIAL_WALLET_SEED.txt')
  ) { throw 'A plaintext Monero seed remains on the production server' }
}

Check 'Production configuration policy' {
  Invoke-Checked 'Production configuration validator' { pnpm --filter @mitm/server config:validate:production }
  $adminLine = Get-Content -LiteralPath '.env' | Where-Object { $_ -match '^ADMIN_ORIGIN=' } | Select-Object -Last 1
  if (-not $adminLine) { throw 'ADMIN_ORIGIN is missing from .env' }
  $configuredOrigins = $adminLine.Substring('ADMIN_ORIGIN='.Length).Split(',') | ForEach-Object { $_.Trim().TrimEnd('/') }
  $expectedOrigin = ([Uri]$BaseUrl).GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
  if ($configuredOrigins -notcontains $expectedOrigin) {
    throw "ADMIN_ORIGIN must contain $expectedOrigin"
  }
}

Check 'Stratum certificate validity' {
  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile(
    (Resolve-Path 'secrets/stratum-tls-cert.pem'),
    (Resolve-Path 'secrets/stratum-tls-key.pem')
  )
  $now = [DateTime]::UtcNow
  if ($certificate.NotBefore.ToUniversalTime() -gt $now) { throw 'Certificate is not valid yet' }
  if ($certificate.NotAfter.ToUniversalTime() -lt $now.AddDays(14)) {
    throw "Certificate expires too soon: $($certificate.NotAfter.ToUniversalTime())"
  }
}

Check 'Docker engine' { Invoke-Checked 'docker info' { docker info --format '{{.ServerVersion}}' | Out-Null } }
Check 'Compose configuration' {
  Invoke-Checked 'docker compose config' { docker compose -f compose.yaml -f compose.production.yaml --env-file .env.infrastructure --profile core --profile bitcoin --profile monero --profile observability --profile backup config --quiet }
}

if (-not $SkipQuality) {
  Check 'Frozen dependency install' { Invoke-Checked 'pnpm install' { pnpm install --frozen-lockfile } }
  Check 'Dependency audit' { Invoke-Checked 'pnpm audit' { pnpm audit --prod --audit-level high } }
  Check 'Formatting' { Invoke-Checked 'Prettier' { pnpm format:check } }
  Check 'Lint' { Invoke-Checked 'ESLint' { pnpm lint } }
  Check 'TypeScript' { Invoke-Checked 'TypeScript' { pnpm typecheck } }
  Check 'Tests and coverage' {
    Invoke-Checked 'Server tests' { pnpm --filter @mitm/server test:coverage }
    Invoke-Checked 'Admin tests' { pnpm --filter @mitm/admin test }
    Invoke-Checked 'Shared tests' { pnpm --filter @mitm/shared test }
  }
  Check 'Production build' { Invoke-Checked 'Production build' { pnpm build } }
}

if (-not $SkipLive) {
  Check 'Wallets and upstream protocol' {
    Invoke-Checked 'Operational self-test' { pnpm --filter @mitm/server self-test:operational }
  }
  Check 'API readiness' {
    $health = Invoke-RestMethod -Uri "$BaseUrl/health/ready" -Method Get
    if ($health.status -ne 'ok') { throw ($health | ConvertTo-Json -Compress) }
  }
  Check 'Trusted Stratum TLS handshake' {
    $client = [System.Net.Sockets.TcpClient]::new($StratumHost, $StratumPort)
    try {
      $stream = [System.Net.Security.SslStream]::new($client.GetStream(), $false)
      try { $stream.AuthenticateAsClient($StratumHost) } finally { $stream.Dispose() }
    } finally {
      $client.Dispose()
    }
  }
}

if ($failures.Count -gt 0) {
  Write-Host "`nProduction preflight failed ($($failures.Count) checks):" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}
Write-Host "`nProduction preflight passed." -ForegroundColor Green
