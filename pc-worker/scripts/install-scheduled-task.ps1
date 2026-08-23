param(
  [Parameter(Mandatory = $true)]
  [string]$NasBaseUrl,

  [string]$TaskName = 'PR Manager PC Worker'
)

$ErrorActionPreference = 'Stop'
$workerRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-worker.ps1')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$statePath = Join-Path $env:LOCALAPPDATA 'PRManagerWorker\state.json'

if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
  throw "Worker is not paired. Run one foreground --once enrollment before installing the scheduled task: $statePath"
}

$arguments = @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
  '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $runner),
  '-WorkerRoot', ('"{0}"' -f $workerRoot),
  '-NasBaseUrl', ('"{0}"' -f $NasBaseUrl),
  '-NodePath', ('"{0}"' -f $node)
) -join ' '

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $workerRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started hidden scheduled task: $TaskName"
Write-Output "Node: $node"
