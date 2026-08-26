[CmdletBinding()]
param(
  [string]$ComposeFile = '',
  [string]$EnvFile = 'D:\PRManagerAI\config\reranker\.env',
  [string]$ModelDir = 'D:\PRManagerAI\models\bge-reranker-v2-m3',
  [string]$CacheDir = 'D:\PRManagerAI\cache\huggingface',
  [string]$RuntimeDir = 'D:\PRManagerAI\runtime\tei',
  [string]$LogDir = 'D:\PRManagerAI\logs\bge-reranker',
  [int]$ReadinessTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
$allowedRoot = 'D:\PRManagerAI'
$modelId = 'BAAI/bge-reranker-v2-m3'
$modelRevision = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e'
$expectedManifestSha256 = '3b0f3c138d07d98b4325e19856124ef874d3f34cb488bc35247e3d2132649fb9'
$requiredModelFiles = [ordered]@{
  'config.json' = @{ length = 795; sha256 = '13DCD6C31D9FEC9D1D8E158702072F62D7FA7D312A64B9FE057BEC9A08CFE41A' }
  'model.safetensors' = @{ length = 2271071852; sha256 = 'D9E3E081FAFF1EEFB84019509B2F5558FD74C1A05A2C7DB22F74174FCEDB5286' }
  'sentencepiece.bpe.model' = @{ length = 5069051; sha256 = 'CFC8146ABE2A0488E9E2A0C56DE7952F7C11AB059ECA145A0A727AFCE0DB2865' }
  'special_tokens_map.json' = @{ length = 964; sha256 = '8C785ABEBEA9AE3257B61681B4E6FD8365CEAFDE980C21970D001E834CF10835' }
  'tokenizer.json' = @{ length = 17098273; sha256 = '69564B696052886ED0AC63FA393E928384E0F8CAADA38C1F4864A9BFBF379C15' }
  'tokenizer_config.json' = @{ length = 1173; sha256 = '7E4C1CC848840AECCDD763458C18DD525EB0F795C992E00EBE9C28554E7DB2D4' }
}

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

function Resolve-TrustedComposeFile {
  $expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\docker-compose.pc-reranker.yml'))
  $candidate = if ([string]::IsNullOrWhiteSpace($ComposeFile)) { $expected } else { [IO.Path]::GetFullPath($ComposeFile) }
  if (-not $candidate.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "ComposeFile must be the repository's fixed docker-compose.pc-reranker.yml: $expected"
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Compose file was not found: $candidate" }
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ComposeFile cannot be a reparse point/symlink.' }
  return $item.FullName
}

function Assert-NoReparsePoints {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $current = $item
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label path chain contains a reparse point/symlink: $($current.FullName)" }
    $parent = $current.Parent
    if ($null -eq $parent -or $parent.FullName -eq $current.FullName) { break }
    $current = $parent
  }
  # Windows PowerShell 5.1 ignores -Attributes when Get-ChildItem targets a
  # single file and returns that file itself. Only directories can contain
  # descendants, so recursive reparse-point inspection is directory-only.
  if ($item.PSIsContainer) {
    $children = @(Get-ChildItem -LiteralPath $item.FullName -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop)
    if ($children.Count -gt 0) { throw "$Label contains reparse points/symlinks." }
  }
}

function Assert-ModelFiles {
  param([Parameter(Mandatory = $true)][string]$Directory, [Parameter(Mandatory = $true)]$Manifest)
  if ($null -eq $Manifest -or $Manifest.modelId -ne $modelId -or $Manifest.revision -ne $modelRevision -or
      ([string]$Manifest.manifestSha256).ToLowerInvariant() -ne $expectedManifestSha256) {
    throw 'The model manifest identity or fixed attestation does not match; service was not started.'
  }
  foreach ($relativePath in $requiredModelFiles.Keys) {
    $manifestEntry = $Manifest.files.PSObject.Properties[$relativePath]
    if ($null -eq $manifestEntry -or [int64]$manifestEntry.Value.length -ne [int64]$requiredModelFiles[$relativePath].length -or
        ([string]$manifestEntry.Value.sha256).ToUpperInvariant() -ne $requiredModelFiles[$relativePath].sha256) {
      throw "The model manifest does not contain the fixed attestation for $relativePath; service was not started."
    }
    $file = Get-Item -LiteralPath (Join-Path $Directory $relativePath) -Force -ErrorAction Stop
    if ($file.PSIsContainer -or [int64]$file.Length -ne [int64]$requiredModelFiles[$relativePath].length) {
      throw "Model file length check failed for $relativePath; service was not started."
    }
    $actualHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $requiredModelFiles[$relativePath].sha256) {
      throw "Model file SHA256 check failed for $relativePath; service was not started."
    }
  }
  $manifestKeys = @($Manifest.files.PSObject.Properties.Name)
  if ($manifestKeys.Count -ne $requiredModelFiles.Count -or @($manifestKeys | Where-Object { -not $requiredModelFiles.Contains($_) }).Count -gt 0) {
    throw 'The model manifest contains an unexpected file set; service was not started.'
  }
}

function Test-TeiInfo {
  param([Parameter(Mandatory = $true)]$Info)
  if ($null -eq $Info -or $Info.PSObject.Properties.Name -contains 'error') { return $false }
  $typeValue = if ($null -ne $Info.model_type) { $Info.model_type } else { $Info.modelType }
  $typeIsReranker = if ($typeValue -is [string]) {
    [string]$typeValue -eq 'reranker'
  } elseif ($null -ne $typeValue) {
    @($typeValue.PSObject.Properties.Name) -contains 'reranker'
  } else {
    $false
  }
  if (-not $typeIsReranker) { return $false }
  $served = if ($Info.served_model_name) { [string]$Info.served_model_name } else { [string]$Info.servedModelName }
  $reported = if ($Info.model_id) { [string]$Info.model_id } else { [string]$Info.modelId }
  if ($served -and $served -ne $modelId) { return $false }
  if ($reported -and $reported -ne $modelId -and $reported -ne '/models/reranker') { return $false }
  $revision = if ($Info.revision) { [string]$Info.revision } elseif ($Info.model_revision) { [string]$Info.model_revision } else { [string]$Info.model_sha }
  if ($revision -and $revision -ne $modelRevision) { return $false }
  return [bool]($served -or $reported)
}

$resolvedComposeFile = Resolve-TrustedComposeFile
$resolvedEnvFile = Assert-UnderAllowedRoot -Path $EnvFile -Label 'EnvFile'
$resolvedModelDir = Assert-UnderAllowedRoot -Path $ModelDir -Label 'ModelDir'
$resolvedCacheDir = Assert-UnderAllowedRoot -Path $CacheDir -Label 'CacheDir'
$resolvedRuntimeDir = Assert-UnderAllowedRoot -Path $RuntimeDir -Label 'RuntimeDir'
$resolvedLogDir = Assert-UnderAllowedRoot -Path $LogDir -Label 'LogDir'
if (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf) {
  Assert-NoReparsePoints -Path $resolvedEnvFile -Label 'EnvFile'
}

if (-not (Test-Path -LiteralPath $resolvedModelDir -PathType Container)) {
  throw "Model directory is missing. Run reranker-prepare-model.ps1 first: $resolvedModelDir"
}
Assert-NoReparsePoints -Path $resolvedModelDir -Label 'ModelDir'
$markerPath = Join-Path $resolvedModelDir '.prmanager-reranker-revision'
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
    (Get-Content -LiteralPath $markerPath -Raw -ErrorAction Stop).Trim() -ne $modelRevision) {
  throw "Model revision marker does not match the fixed revision $modelRevision."
}
$manifestPath = Join-Path $resolvedModelDir '.prmanager-reranker-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'The model manifest is missing. Run reranker-prepare-model.ps1 to attest the existing clean model.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
Assert-ModelFiles -Directory $resolvedModelDir -Manifest $manifest

foreach ($directory in @($resolvedCacheDir, $resolvedRuntimeDir, $resolvedLogDir)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  Assert-NoReparsePoints -Path $directory -Label $directory
}

$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($null -eq $docker) {
  throw 'Docker CLI is unavailable. Install/start Docker Desktop before using this script; no runtime was installed automatically.'
}
& $docker.Source info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker daemon is unavailable. Start Docker Desktop before using this script; the TEI service was not started.'
}
$env:RERANKER_MODEL_DIR = $resolvedModelDir -replace '\\', '/'
$env:RERANKER_CACHE_DIR = $resolvedCacheDir -replace '\\', '/'
$env:RERANKER_RUNTIME_DIR = $resolvedRuntimeDir -replace '\\', '/'
$env:RERANKER_LOG_DIR = $resolvedLogDir -replace '\\', '/'

$composePrefix = @('compose')
if (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf) { $composePrefix += @('--env-file', $resolvedEnvFile) }
$composePrefix += @('-f', $resolvedComposeFile, '--profile', 'reranker')

& $docker.Source @($composePrefix + @('config', '--quiet'))
if ($LASTEXITCODE -ne 0) { throw "Docker Compose configuration validation failed with exit code $LASTEXITCODE." }
& $docker.Source @($composePrefix + @('up', '-d', '--no-build', 'reranker'))
if ($LASTEXITCODE -ne 0) { throw "Reranker start failed with exit code $LASTEXITCODE." }

$timeoutSeconds = [Math]::Max(1, [Math]::Min(300, $ReadinessTimeoutSeconds))
$deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
$ready = $false
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $info = Invoke-RestMethod -Uri 'http://127.0.0.1:18081/info' -Method Get -TimeoutSec 3 -Headers @{ Accept = 'application/json' }
    if (Test-TeiInfo -Info $info) { $ready = $true; break }
  } catch {
    # The container can still be loading. Do not expose the response body.
  }
  Start-Sleep -Seconds 1
}
if (-not $ready) {
  # Docker Compose writes ordinary lifecycle messages to stderr. Windows
  # PowerShell 5.1 turns redirected native stderr into ErrorRecord objects, so
  # temporarily keep those messages non-terminating while we perform cleanup.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $docker.Source @($composePrefix + @('logs', '--no-color', '--tail', '100', 'reranker')) *> $null
    & $docker.Source @($composePrefix + @('stop', 'reranker')) *> $null
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  throw "Reranker did not publish a pinned /info identity within $timeoutSeconds seconds; service was stopped."
}

Write-Output 'Reranker started explicitly and passed pinned /info readiness; ordinary compose up remains unaffected.'
Write-Output 'Endpoint: http://127.0.0.1:18081'
