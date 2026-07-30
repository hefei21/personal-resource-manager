[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('validate', 'prepare', 'up', 'smoke', 'scenarios', 'report', 'down', 'all')]
  [string]$Command = 'all',

  [switch]$Cleanup,
  [switch]$PublishRedisPort
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $ProjectRoot '.codex\test-runtime'
$ReportsRoot = Join-Path $ProjectRoot '.codex\test-reports'
$FixtureRoot = Join-Path $RuntimeRoot 'fixtures'
$StatePath = Join-Path $RuntimeRoot 'test-state.json'
$EnvPath = Join-Path $RuntimeRoot '.env.test'
$ComposePath = Join-Path $ProjectRoot 'docker-compose.test.yml'
$RedisDebugComposePath = Join-Path $ProjectRoot 'docker-compose.test.redis-debug.yml'
$TestRunner = Join-Path $PSScriptRoot 'test\run-tests.ps1'
$FixtureGenerator = Join-Path $PSScriptRoot 'test\generate-fixtures.ps1'
$StaticValidator = Join-Path $PSScriptRoot 'test\validate-static.ps1'

function Assert-SafeRuntimePath {
  $workspace = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
  $runtime = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\', '/')
  $expected = [System.IO.Path]::GetFullPath((Join-Path $workspace '.codex\test-runtime')).TrimEnd('\', '/')
  if ($runtime -ne $expected -or -not $runtime.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe runtime path: $runtime"
  }
}

function Assert-CommandAvailable([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found."
  }
}

function New-RandomSecret([int]$Bytes = 32) {
  $buffer = [byte[]]::new($Bytes)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToHexString($buffer).ToLowerInvariant()
}

function Test-PortAvailable([int]$Port) {
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Invoke-Compose {
  param([string[]]$Arguments)
  $envArgs = @('--env-file', $EnvPath, '-f', $ComposePath)
  if ($PublishRedisPort) {
    $envArgs += @('-f', $RedisDebugComposePath)
  }
  & docker compose @envArgs @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed: $($Arguments -join ' ')"
  }
}

function Prepare-TestEnvironment {
  Assert-SafeRuntimePath
  Assert-CommandAvailable 'docker'

  & docker compose version | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose v2 is required.'
  }

  if (Test-Path -LiteralPath $EnvPath) {
    try {
      Invoke-Compose @('down', '--remove-orphans')
    } catch {
      Write-Warning "Existing test stack could not be stopped cleanly: $($_.Exception.Message)"
    }
  }

  foreach ($port in @(13000, 15173)) {
    if (-not (Test-PortAvailable $port)) {
      throw "Port $port is already in use. Stop the conflicting service before starting the isolated stack."
    }
  }
  if ($PublishRedisPort -and -not (Test-PortAvailable 16379)) {
    throw 'Port 16379 is already in use.'
  }

  foreach ($generatedPath in @(
    (Join-Path $RuntimeRoot 'data'),
    (Join-Path $RuntimeRoot 'fixtures'),
    (Join-Path $RuntimeRoot 'test-state.json'),
    (Join-Path $RuntimeRoot 'results.ndjson'),
    $EnvPath
  )) {
    if (Test-Path -LiteralPath $generatedPath) {
      Remove-Item -LiteralPath $generatedPath -Recurse -Force
    }
  }

  $directories = @(
    $RuntimeRoot,
    $ReportsRoot,
    (Join-Path $RuntimeRoot 'data\db'),
    (Join-Path $RuntimeRoot 'data\documents'),
    (Join-Path $RuntimeRoot 'data\music'),
    (Join-Path $RuntimeRoot 'data\books'),
    (Join-Path $RuntimeRoot 'data\code'),
    (Join-Path $RuntimeRoot 'data\uploads'),
    (Join-Path $RuntimeRoot 'data\logs'),
    (Join-Path $RuntimeRoot 'data\redis')
  )
  foreach ($directory in $directories) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  if (-not (Test-Path -LiteralPath $EnvPath)) {
    $adminPassword = New-RandomSecret 18
    $privatePassword = New-RandomSecret 18
    $jwtSecret = New-RandomSecret 48
    $content = @(
      'COMPOSE_PROJECT_NAME=pr-test'
      'TEST_ADMIN_USERNAME=baseline_admin'
      "TEST_ADMIN_PASSWORD=$adminPassword"
      "TEST_PRIVATE_PASSWORD=$privatePassword"
      "TEST_JWT_SECRET=$jwtSecret"
    )
    [System.IO.File]::WriteAllLines($EnvPath, $content, [System.Text.UTF8Encoding]::new($false))
  }

  & $FixtureGenerator -OutputRoot $FixtureRoot

  Write-Host "Prepared isolated runtime at $RuntimeRoot"
  Write-Host 'No production data path is mounted by docker-compose.test.yml.'
}

function Wait-ForHealth {
  $deadline = [DateTime]::UtcNow.AddMinutes(4)
  do {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:13000/api/health' -TimeoutSec 5
      if ($health.status -in @('ok', 'degraded')) {
        return
      }
    } catch {
      Start-Sleep -Seconds 3
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  Invoke-Compose @('ps')
  throw 'Backend health check did not become ready within four minutes.'
}

function Start-TestStack {
  if (-not (Test-Path -LiteralPath $EnvPath)) {
    Prepare-TestEnvironment
  }
  $args = @('up', '-d', '--build')
  Invoke-Compose $args
  Wait-ForHealth
  Write-Host 'Test stack is ready:'
  Write-Host '  Frontend: http://127.0.0.1:15173'
  Write-Host '  Backend:  http://127.0.0.1:13000/api/health'
}

function Invoke-TestSuite([ValidateSet('smoke', 'scenarios', 'report')] [string]$Suite) {
  if (-not (Test-Path -LiteralPath $EnvPath)) {
    throw 'Run prepare or up first.'
  }
  & $TestRunner -Suite $Suite -RuntimeRoot $RuntimeRoot -ReportsRoot $ReportsRoot -FixtureRoot $FixtureRoot
}

function Stop-TestStack {
  if (-not (Test-Path -LiteralPath $EnvPath)) {
    Write-Host 'No prepared test environment was found.'
    return
  }
  $args = @('down', '--remove-orphans')
  if ($Cleanup) {
    $args += '--volumes'
  }
  Invoke-Compose $args
  if ($Cleanup) {
    Assert-SafeRuntimePath
    if (Test-Path -LiteralPath $RuntimeRoot) {
      Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
    }
    Write-Host 'Test runtime and generated credentials were removed.'
  }
}

switch ($Command) {
  'validate' {
    & $StaticValidator -ProjectRoot $ProjectRoot
    if ($LASTEXITCODE -ne 0) {
      throw 'Static validation failed.'
    }
  }
  'prepare' { Prepare-TestEnvironment }
  'up' { Start-TestStack }
  'smoke' { Invoke-TestSuite 'smoke' }
  'scenarios' { Invoke-TestSuite 'scenarios' }
  'report' { Invoke-TestSuite 'report' }
  'down' { Stop-TestStack }
  'all' {
    & $StaticValidator -ProjectRoot $ProjectRoot
    if ($LASTEXITCODE -ne 0) {
      throw 'Static validation failed.'
    }
    Prepare-TestEnvironment
    Start-TestStack
    Invoke-TestSuite 'smoke'
    Invoke-TestSuite 'scenarios'
    Invoke-TestSuite 'report'
    if ($Cleanup) {
      Stop-TestStack
    } else {
      Write-Host 'The isolated stack remains running for manual inspection. Run .\tools\test.ps1 down when finished.'
    }
  }
}
