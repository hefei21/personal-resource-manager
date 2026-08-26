[CmdletBinding()]
param(
  [string]$ModelId = 'BAAI/bge-reranker-v2-m3',
  [string]$Revision = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e',
  [string]$ModelDir = 'D:\PRManagerAI\models\bge-reranker-v2-m3',
  [string]$CacheDir = 'D:\PRManagerAI\cache\huggingface'
)

$ErrorActionPreference = 'Stop'
$allowedRoot = 'D:\PRManagerAI'
$expectedManifestSha256 = '3b0f3c138d07d98b4325e19856124ef874d3f34cb488bc35247e3d2132649fb9'
$expectedFiles = [ordered]@{
  'config.json' = @{ length = 795; sha256 = '13DCD6C31D9FEC9D1D8E158702072F62D7FA7D312A64B9FE057BEC9A08CFE41A' }
  'model.safetensors' = @{ length = 2271071852; sha256 = 'D9E3E081FAFF1EEFB84019509B2F5558FD74C1A05A2C7DB22F74174FCEDB5286' }
  'sentencepiece.bpe.model' = @{ length = 5069051; sha256 = 'CFC8146ABE2A0488E9E2A0C56DE7952F7C11AB059ECA145A0A727AFCE0DB2865' }
  'special_tokens_map.json' = @{ length = 964; sha256 = '8C785ABEBEA9AE3257B61681B4E6FD8365CEAFDE980C21970D001E834CF10835' }
  'tokenizer.json' = @{ length = 17098273; sha256 = '69564B696052886ED0AC63FA393E928384E0F8CAADA38C1F4864A9BFBF379C15' }
  'tokenizer_config.json' = @{ length = 1173; sha256 = '7E4C1CC848840AECCDD763458C18DD525EB0F795C992E00EBE9C28554E7DB2D4' }
}

function Assert-UnderAllowedRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label cannot be empty." }
  $root = [IO.Path]::GetFullPath($allowedRoot).TrimEnd('\')
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ieq $root -or -not $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay below ${root}: $full"
  }
  return $full
}

function Assert-NoReparsePoints {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $current = $item
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label path chain contains a reparse point/symlink; refusing to use it: $($current.FullName)"
    }
    $parent = $current.Parent
    if ($null -eq $parent -or $parent.FullName -eq $current.FullName) { break }
    $current = $parent
  }
  $reparsePoints = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop)
  if ($reparsePoints.Count -gt 0) {
    throw "$Label contains reparse points/symlinks; refusing to use a cache link."
  }
}

function Read-ManifestIfPresent {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json }
  catch { throw "The existing reranker manifest is not valid JSON; refusing to regenerate it: $Path" }
}

function Assert-ManifestMatchesPinnedFiles {
  param([Parameter(Mandatory = $true)]$Manifest)
  if ($null -eq $Manifest -or $Manifest.modelId -ne 'BAAI/bge-reranker-v2-m3' -or
      $Manifest.revision -ne '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e' -or
      ([string]$Manifest.manifestSha256).ToLowerInvariant() -ne $expectedManifestSha256) {
    throw 'The existing reranker manifest is not the fixed attestation; refusing to overwrite or regenerate it.'
  }
  foreach ($relativePath in $expectedFiles.Keys) {
    $entry = $Manifest.files.PSObject.Properties[$relativePath]
    if ($null -eq $entry -or [int64]$entry.Value.length -ne [int64]$expectedFiles[$relativePath].length -or
        ([string]$entry.Value.sha256).ToUpperInvariant() -ne $expectedFiles[$relativePath].sha256) {
      throw "The existing reranker manifest has an unexpected attestation for $relativePath; refusing to regenerate it."
    }
  }
  $manifestKeys = @($Manifest.files.PSObject.Properties.Name)
  if ($manifestKeys.Count -ne $expectedFiles.Count -or @($manifestKeys | Where-Object { -not $expectedFiles.Contains($_) }).Count -gt 0) {
    throw 'The existing reranker manifest contains an unexpected file set; refusing to regenerate it.'
  }
}

function Assert-ModelFiles {
  param([Parameter(Mandatory = $true)][string]$Directory)
  foreach ($relativePath in $expectedFiles.Keys) {
    $file = Get-Item -LiteralPath (Join-Path $Directory $relativePath) -Force -ErrorAction Stop
    if (-not $file.PSIsContainer -and [int64]$file.Length -eq [int64]$expectedFiles[$relativePath].length) {
      $actualHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
      if ($actualHash -eq $expectedFiles[$relativePath].sha256) { continue }
    }
    throw "Model file integrity check failed for $relativePath; refusing to attest or start the service."
  }
}

if ($ModelId -ne 'BAAI/bge-reranker-v2-m3') {
  throw 'The reranker model id is fixed to BAAI/bge-reranker-v2-m3.'
}
if ($Revision -ne '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e') {
  throw 'The reranker revision is fixed to 953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e.'
}

$resolvedModelDir = Assert-UnderAllowedRoot -Path $ModelDir -Label 'ModelDir'
$resolvedCacheDir = Assert-UnderAllowedRoot -Path $CacheDir -Label 'CacheDir'
New-Item -ItemType Directory -Path $resolvedCacheDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $resolvedModelDir)) {
  New-Item -ItemType Directory -Path $resolvedModelDir -Force | Out-Null
}
Assert-NoReparsePoints -Path $resolvedModelDir -Label 'ModelDir'
Assert-NoReparsePoints -Path $resolvedCacheDir -Label 'CacheDir'

$manifestPath = Join-Path $resolvedModelDir '.prmanager-reranker-manifest.json'
$markerPath = Join-Path $resolvedModelDir '.prmanager-reranker-revision'
$existingManifest = Read-ManifestIfPresent -Path $manifestPath
if ($null -ne $existingManifest) { Assert-ManifestMatchesPinnedFiles -Manifest $existingManifest }
if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
  if ((Get-Content -LiteralPath $markerPath -Raw -ErrorAction Stop).Trim() -ne $Revision) {
    throw "The existing revision marker does not match the fixed revision $Revision; refusing to replace it."
  }
}

$missingFiles = @($expectedFiles.Keys | Where-Object {
  -not (Test-Path -LiteralPath (Join-Path $resolvedModelDir $_) -PathType Leaf)
})
if ($missingFiles.Count -gt 0) {
  $existing = @(Get-ChildItem -LiteralPath $resolvedModelDir -Force)
  $metadataFiles = @('.prmanager-reranker-revision', '.prmanager-reranker-manifest.json')
  $nonMetadataExisting = @($existing | Where-Object { $metadataFiles -notcontains $_.Name })
  if ($nonMetadataExisting.Count -gt 0) {
    throw "The existing model directory is incomplete; refusing to overwrite or redownload it: $resolvedModelDir"
  }

  $hfCommand = Get-Command hf.exe -ErrorAction SilentlyContinue
  if ($null -eq $hfCommand) { $hfCommand = Get-Command huggingface-cli.exe -ErrorAction SilentlyContinue }
  if ($null -eq $hfCommand) {
    throw 'The model is missing and neither hf.exe nor huggingface-cli.exe is installed. No repository path is used for downloads.'
  }
  $env:HF_HOME = $resolvedCacheDir
  $env:HUGGINGFACE_HUB_CACHE = Join-Path $resolvedCacheDir 'hub'
  $env:TRANSFORMERS_CACHE = Join-Path $resolvedCacheDir 'transformers'
  $env:HF_HUB_DISABLE_TELEMETRY = '1'
  Push-Location -LiteralPath $allowedRoot
  try {
    & $hfCommand.Source download $ModelId --revision $Revision --local-dir $resolvedModelDir
    if ($LASTEXITCODE -ne 0) { throw "Hugging Face model download failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

Assert-NoReparsePoints -Path $resolvedModelDir -Label 'ModelDir'
Assert-ModelFiles -Directory $resolvedModelDir

if ($null -eq $existingManifest) {
  $fileManifest = [ordered]@{}
  foreach ($relativePath in $expectedFiles.Keys) {
    $fileManifest[$relativePath] = [ordered]@{
      length = [int64]$expectedFiles[$relativePath].length
      sha256 = $expectedFiles[$relativePath].sha256
    }
  }
  $manifest = [ordered]@{
    modelId = $ModelId
    revision = $Revision
    manifestSha256 = $expectedManifestSha256
    files = $fileManifest
    preparedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  Set-Content -LiteralPath $markerPath -Value $Revision -NoNewline -Encoding utf8
} else {
  Write-Output 'Existing fixed reranker manifest accepted; it was not regenerated.'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    Set-Content -LiteralPath $markerPath -Value $Revision -NoNewline -Encoding utf8
  }
}

Write-Output "Prepared $ModelId at revision $Revision"
Write-Output "Model directory: $resolvedModelDir"
Write-Output "Cache directory: $resolvedCacheDir"
