[CmdletBinding()]
param([switch]$Build)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
$env:NODE_ENV = 'production'
$env:SERVE_ADMIN_STATIC = 'true'
if ($Build) {
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
}
pnpm db:deploy
if ($LASTEXITCODE -ne 0) { throw "Database migration failed with exit code $LASTEXITCODE" }
pnpm start:prod
if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE" }
