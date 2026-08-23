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
$nasHost = ([Uri]$NasBaseUrl).Host
$noProxyEntries = @($env:NO_PROXY, $env:no_proxy) -join ',' -split ',' |
  ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($noProxyEntries -notcontains $nasHost) { $noProxyEntries += $nasHost }
$noProxyValue = ($noProxyEntries | Select-Object -Unique) -join ','
$env:NO_PROXY = $noProxyValue
$env:no_proxy = $noProxyValue
Set-Location -LiteralPath $WorkerRoot
& $NodePath (Join-Path $WorkerRoot 'src\index.js')
exit $LASTEXITCODE
