[CmdletBinding()]
param(
  [string]$ComposeFile = '',
  [string]$EnvFile = 'D:\PRManagerAI\config\reranker\.env',
  [string]$RuntimeDir = 'D:\PRManagerAI\runtime\tei',
  [string]$LogDir = 'D:\PRManagerAI\logs\bge-reranker'
)

$ErrorActionPreference = 'Stop'
$allowedRoot = 'D:\PRManagerAI'

function Assert-UnderAllowedRoot {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label cannot be empty." }
  $root = [IO.Path]::GetFullPath($allowedRoot).TrimEnd('\')
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ieq $root -or -not $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay below ${root}: $full"
  }
  return $full
}

function Assert-NoReparsePathChain {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $current = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label path chain contains a reparse point/symlink: $($current.FullName)"
    }
    $parent = $current.Parent
    if ($null -eq $parent -or $parent.FullName -eq $current.FullName) { break }
    $current = $parent
  }
}

$expectedComposeFile = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\docker-compose.pc-reranker.yml'))
$candidateComposeFile = if ([string]::IsNullOrWhiteSpace($ComposeFile)) { $expectedComposeFile } else { [IO.Path]::GetFullPath($ComposeFile) }
if (-not $candidateComposeFile.Equals($expectedComposeFile, [StringComparison]::OrdinalIgnoreCase)) {
  throw "ComposeFile must be the repository's fixed docker-compose.pc-reranker.yml: $expectedComposeFile"
}
if (-not (Test-Path -LiteralPath $candidateComposeFile -PathType Leaf)) { throw "Compose file was not found: $candidateComposeFile" }
$composeItem = Get-Item -LiteralPath $candidateComposeFile -Force
$current = $composeItem
while ($null -ne $current) {
  if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "ComposeFile path chain contains a reparse point/symlink: $($current.FullName)" }
  $parent = $current.Parent
  if ($null -eq $parent -or $parent.FullName -eq $current.FullName) { break }
  $current = $parent
}
$ComposeFile = $composeItem.FullName

$resolvedEnvFile = Assert-UnderAllowedRoot -Path $EnvFile -Label 'EnvFile'
$resolvedRuntimeDir = Assert-UnderAllowedRoot -Path $RuntimeDir -Label 'RuntimeDir'
$resolvedLogDir = Assert-UnderAllowedRoot -Path $LogDir -Label 'LogDir'
Assert-NoReparsePathChain -Path $resolvedEnvFile -Label 'EnvFile'
Assert-NoReparsePathChain -Path $resolvedRuntimeDir -Label 'RuntimeDir'
Assert-NoReparsePathChain -Path $resolvedLogDir -Label 'LogDir'
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($null -eq $docker) {
  throw 'Docker CLI is unavailable; no container or model files were changed.'
}
& $docker.Source info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker daemon is unavailable; no container or model files were changed.'
}
$composePrefix = @('compose')
if (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf) { $composePrefix += @('--env-file', $resolvedEnvFile) }
$composePrefix += @('-f', $ComposeFile, '--profile', 'reranker')

# Stop only: do not remove containers, volumes, caches, or model files.
& $docker.Source @($composePrefix + @('stop', 'reranker'))
if ($LASTEXITCODE -ne 0) { throw "Reranker stop failed with exit code $LASTEXITCODE." }
Write-Output 'Reranker stopped; GPU memory can now be reclaimed without deleting its model or cache.'
