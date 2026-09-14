[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'
$health = Invoke-RestMethod -Uri "$BaseUrl/health/ready" -Method Get
if ($health.status -ne 'ok') {
  $health | ConvertTo-Json -Depth 5
  throw 'Mining Gateway is not ready.'
}
$health | ConvertTo-Json -Depth 5
