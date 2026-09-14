[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
docker compose --env-file .env.infrastructure --profile core --profile backup run --rm -e BACKUP_INTERVAL_SECONDS=0 postgres-backup
if ($LASTEXITCODE -ne 0) { throw "Backup failed with exit code $LASTEXITCODE" }
