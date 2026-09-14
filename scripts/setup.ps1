[CmdletBinding()]
param(
  [switch]$StartCore,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$secretDirectory = Join-Path $projectRoot 'secrets'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function New-RandomSecret([int]$Length = 32) {
  $bytes = [byte[]]::new($Length)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Ensure-Secret([string]$Name, [int]$Length = 32) {
  $path = Join-Path $secretDirectory $Name
  if (-not (Test-Path -LiteralPath $path)) {
    [System.IO.File]::WriteAllText($path, (New-RandomSecret $Length), $utf8NoBom)
  }
  return (Get-Content -LiteralPath $path -Raw).Trim()
}

function Invoke-Checked([string]$Name, [scriptblock]$Action) {
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) {
  throw 'Node.js 24 LTS or newer is required.'
}

New-Item -ItemType Directory -Force -Path $secretDirectory | Out-Null
$postgresPassword = Ensure-Secret 'postgres-password.txt'
$redisPassword = Ensure-Secret 'redis-password.txt'
Ensure-Secret 'app-encryption.key' 48 | Out-Null
Ensure-Secret 'cookie-secret.txt' 48 | Out-Null
Ensure-Secret 'bitcoin-rpc-password.txt' | Out-Null
Ensure-Secret 'bitcoin-wallet-passphrase.txt' 48 | Out-Null
Ensure-Secret 'monero-rpc-password.txt' | Out-Null
Ensure-Secret 'monero-wallet-passphrase.txt' 48 | Out-Null
Ensure-Secret 'grafana-admin-password.txt' | Out-Null

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $secretDirectory /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null

$appEnvPath = Join-Path $projectRoot '.env'
if (-not (Test-Path -LiteralPath $appEnvPath)) {
  $content = Get-Content -LiteralPath (Join-Path $projectRoot '.env.example') -Raw
  $content = $content.Replace('mining_dev_password', $postgresPassword).Replace('redis_dev_password', $redisPassword)
  [System.IO.File]::WriteAllText($appEnvPath, $content, $utf8NoBom)
}
$infraEnvPath = Join-Path $projectRoot '.env.infrastructure'
if (-not (Test-Path -LiteralPath $infraEnvPath)) {
  Copy-Item -LiteralPath (Join-Path $projectRoot '.env.infrastructure.example') -Destination $infraEnvPath
}

Push-Location $projectRoot
try {
  if (-not $SkipInstall) { Invoke-Checked 'Dependency installation' { pnpm install --frozen-lockfile } }
  Invoke-Checked 'Prisma client generation' { pnpm db:generate }
  if ($StartCore) {
    Invoke-Checked 'Core Docker startup' { docker compose --env-file .env.infrastructure --profile core up -d }
    Invoke-Checked 'Database migration' { pnpm db:deploy }
  }
} finally {
  Pop-Location
}

Write-Host 'Setup complete. Secrets were created once and were not printed.'
if (-not $StartCore) { Write-Host 'Next: docker compose --env-file .env.infrastructure --profile core up -d; pnpm db:deploy' }
