param(
  [Parameter(Mandatory = $true)]
  [string]$WorkerRoot,

  [Parameter(Mandatory = $true)]
  [string]$NasBaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$env:PC_WORKER_NAS_BASE_URL = $NasBaseUrl
Set-Location -LiteralPath $WorkerRoot
& $NodePath (Join-Path $WorkerRoot 'src\index.js')
exit $LASTEXITCODE
