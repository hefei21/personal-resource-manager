param(
  [Parameter(Mandatory = $true)]
  [string]$NasBaseUrl,

  [string]$TaskName = 'PR Manager PC Worker'
)

$ErrorActionPreference = 'Stop'
$workerRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-worker-hidden.vbs')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$wscript = (Get-Command wscript.exe -ErrorAction Stop).Source
$statePath = Join-Path $env:LOCALAPPDATA 'PRManagerWorker\state.json'

if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
  throw "Worker is not paired. Run one foreground --once enrollment before installing the scheduled task: $statePath"
}

$arguments = @(
  '//B', '//Nologo', ('"{0}"' -f $runner),
  ('"{0}"' -f $workerRoot),
  ('"{0}"' -f $NasBaseUrl),
  ('"{0}"' -f $node)
) -join ' '

$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $workerRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started hidden scheduled task: $TaskName"
Write-Output "Node: $node"
