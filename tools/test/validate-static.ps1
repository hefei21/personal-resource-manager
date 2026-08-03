[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ValidationRoot = Join-Path $ProjectRoot '.codex\static-validation'
$FixtureRoot = Join-Path $ValidationRoot 'fixtures'
$ReportPath = Join-Path $ValidationRoot 'report.md'
$JsonPath = Join-Path $ValidationRoot 'results.json'
$FixtureGenerator = Join-Path $PSScriptRoot 'generate-fixtures.ps1'
$Results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
  param(
    [string]$Id,
    [ValidateSet('PASS', 'FAIL', 'SKIP')]
    [string]$Status,
    [string]$Message
  )

  $Results.Add([ordered]@{
    id = $Id
    status = $Status
    message = $Message
  })

  $color = switch ($Status) {
    'PASS' { 'Green' }
    'FAIL' { 'Red' }
    'SKIP' { 'DarkGray' }
  }
  Write-Host "[$Status] $Id - $Message" -ForegroundColor $color
}

function Assert-Condition {
  param(
    [string]$Id,
    [bool]$Condition,
    [string]$PassMessage,
    [string]$FailMessage
  )

  if ($Condition) {
    Add-Result $Id 'PASS' $PassMessage
  } else {
    Add-Result $Id 'FAIL' $FailMessage
  }
}

function Get-ProjectFile([string]$RelativePath) {
  return Join-Path $ProjectRoot $RelativePath
}

function Test-ZipEntries {
  param(
    [string]$Id,
    [string]$Path,
    [string[]]$RequiredEntries
  )

  try {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
      $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
      $missing = @($RequiredEntries | Where-Object { $_ -notin $names })
      Assert-Condition $Id ($missing.Count -eq 0) `
        "$([System.IO.Path]::GetFileName($Path)) contains required package entries." `
        "$([System.IO.Path]::GetFileName($Path)) is missing: $($missing -join ', ')"
    } finally {
      $archive.Dispose()
    }
  } catch {
    Add-Result $Id 'FAIL' "Cannot open $([System.IO.Path]::GetFileName($Path)) as ZIP: $($_.Exception.Message)"
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force -Path $ValidationRoot | Out-Null

# PowerShell syntax validation
$powerShellFiles = @(
  Get-ChildItem -LiteralPath (Get-ProjectFile 'tools') -Filter '*.ps1' -File -Recurse
)
$syntaxErrors = @()
foreach ($file in $powerShellFiles) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    $file.FullName,
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    $syntaxErrors += "$($file.Name): $($errors[0].Message)"
  }
}
Assert-Condition 'powershell.syntax' ($syntaxErrors.Count -eq 0) `
  "$($powerShellFiles.Count) PowerShell files parsed successfully." `
  ($syntaxErrors -join '; ')

# Compose isolation invariants that do not require a YAML runtime.
$pcCompose = Get-Content -LiteralPath (Get-ProjectFile 'docker-compose.test.yml') -Encoding UTF8 -Raw
$nasCompose = Get-Content -LiteralPath (Get-ProjectFile 'docker-compose.nas-test.yml') -Encoding UTF8 -Raw
$productionCompose = Get-Content -LiteralPath (Get-ProjectFile 'docker-compose.nas.yml') -Encoding UTF8 -Raw
$localCompose = Get-Content -LiteralPath (Get-ProjectFile 'docker-compose.yml') -Encoding UTF8 -Raw

$pcVolumeLines = @(
  $pcCompose -split "`r?`n" |
    Where-Object { $_ -match '^\s*-\s+[^:]+:.+$' -and $_ -match '/app/data/' }
)
$unsafePcMounts = @($pcVolumeLines | Where-Object { $_ -notmatch '\./\.codex/test-runtime/' })
Assert-Condition 'compose.pc.mounts' ($pcVolumeLines.Count -gt 0 -and $unsafePcMounts.Count -eq 0) `
  'PC test mounts are confined to .codex/test-runtime.' `
  'PC test Compose contains a missing or unsafe application data mount.'

Assert-Condition 'compose.pc.ports' `
  ($pcCompose.Contains('"127.0.0.1:13000:3000"') -and $pcCompose.Contains('"127.0.0.1:15173:80"')) `
  'PC application ports are bound to loopback.' `
  'PC test application ports are not restricted to loopback.'

$pcContainerNames = @(
  [regex]::Matches($pcCompose, '(?m)^\s*container_name:\s*(\S+)\s*$') |
    ForEach-Object { $_.Groups[1].Value }
)
Assert-Condition 'compose.pc.names' `
  ($pcContainerNames.Count -eq 3 -and @($pcContainerNames | Where-Object { $_ -notlike 'pr-test-*' }).Count -eq 0) `
  'PC test container names use the pr-test- prefix.' `
  'PC test Compose contains an unexpected container name.'

$nasVolumeLines = @(
  $nasCompose -split "`r?`n" |
    Where-Object { $_ -match '^\s*-\s+[^:]+:.+$' -and $_ -match '/app/data/' }
)
$unsafeNasMounts = @($nasVolumeLines | Where-Object { $_ -notmatch '\$\{TEST_DATA_ROOT:\?[^}]+\}/' })
Assert-Condition 'compose.nas.mounts' ($nasVolumeLines.Count -gt 0 -and $unsafeNasMounts.Count -eq 0) `
  'NAS test mounts require the explicit TEST_DATA_ROOT.' `
  'NAS test Compose contains a mount outside TEST_DATA_ROOT.'

Assert-Condition 'compose.nas.images' `
  ($nasCompose -notmatch '(?m)^\s*build:' -and $nasCompose -match 'ghcr\.io/.+\$\{IMAGE_TAG:\?[^}]+\}') `
  'NAS test Compose uses versioned GHCR images without local builds.' `
  'NAS test Compose contains a build or an unversioned application image.'

Assert-Condition 'compose.production.images' `
  ($productionCompose -notmatch '(?m)^\s*build:' -and $productionCompose -match 'ghcr\.io/.+\$\{IMAGE_TAG\}') `
  'Production NAS Compose uses versioned GHCR images without local builds.' `
  'Production NAS Compose contains a build or an unversioned application image.'

$composeSecretsAreVariables = (
  $nasCompose -match 'DEFAULT_PASSWORD:\s*\$\{TEST_ADMIN_PASSWORD:\?[^}]+\}' -and
  $nasCompose -match 'PRIVATE_PASSWORD:\s*\$\{TEST_PRIVATE_PASSWORD:\?[^}]+\}' -and
  $productionCompose -match 'DEFAULT_PASSWORD:\s*\$\{DEFAULT_PASSWORD:\?[^}]+\}' -and
  $productionCompose -match 'PRIVATE_PASSWORD:\s*\$\{PRIVATE_PASSWORD:\?[^}]+\}'
)
Assert-Condition 'compose.secrets' $composeSecretsAreVariables `
  'Compose secrets are supplied through environment variables.' `
  'A required Compose secret is missing or is not environment-driven.'

$composeCorsIsExact = @(
  $pcCompose,
  $nasCompose,
  $productionCompose,
  $localCompose
) | ForEach-Object { $_ -notmatch '(?m)CORS_ORIGIN\s*[:=]\s*\*' }
Assert-Condition 'compose.cors' ($composeCorsIsExact -notcontains $false) `
  'Compose files do not enable wildcard credentialed CORS.' `
  'A Compose file enables CORS_ORIGIN=*.'

# Frontend active-content boundaries.
$vueFiles = @(
  Get-ChildItem -LiteralPath (Get-ProjectFile 'frontend\src') -Filter '*.vue' -File -Recurse
)
$unsafeVHtml = @()
$unsanitizedMarkdown = @()
foreach ($file in $vueFiles) {
  $source = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Raw
  foreach ($match in [regex]::Matches($source, 'v-html="([^"]+)"')) {
    $expression = $match.Groups[1].Value
    if ($expression -notmatch '^(highlightedCode|sanitizedPreviewContent|currentChapterContent|sanitizeRichHtml\(|highlightMatch\()') {
      $unsafeVHtml += "$($file.Name): $expression"
    }
  }
  foreach ($match in [regex]::Matches($source, '<Md(?:Preview|Editor)\b[\s\S]*?>')) {
    if ($match.Value -notmatch ':sanitize="sanitizeRichHtml"') {
      $unsanitizedMarkdown += $file.Name
    }
  }
}
Assert-Condition 'frontend.v-html' ($unsafeVHtml.Count -eq 0) `
  'All v-html sites use an approved sanitizer or escaped highlighter output.' `
  "Unsafe v-html expressions: $($unsafeVHtml -join ', ')"
Assert-Condition 'frontend.markdown-sanitize' ($unsanitizedMarkdown.Count -eq 0) `
  'All Markdown editor and preview components use the shared sanitizer.' `
  "Markdown components without sanitizer: $($unsanitizedMarkdown -join ', ')"

# Synthetic fixture generation and package integrity.
if (Test-Path -LiteralPath $FixtureRoot) {
  Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
}
& $FixtureGenerator -OutputRoot $FixtureRoot
$requiredFixtures = @(
  'baseline.txt',
  'baseline.md',
  'baseline.json',
  'baseline.csv',
  'baseline.docx',
  'baseline.xlsx',
  'baseline.epub',
  'cover.png',
  'tone.wav',
  'sample-repository\README.md',
  'sample-repository\src\index.js'
)
$missingFixtures = @(
  $requiredFixtures |
    Where-Object { -not (Test-Path -LiteralPath (Join-Path $FixtureRoot $_)) }
)
Assert-Condition 'fixtures.generate' ($missingFixtures.Count -eq 0) `
  "$($requiredFixtures.Count) required synthetic fixtures were generated." `
  "Missing synthetic fixtures: $($missingFixtures -join ', ')"

try {
  Get-Content -LiteralPath (Join-Path $FixtureRoot 'baseline.json') -Encoding UTF8 -Raw |
    ConvertFrom-Json | Out-Null
  Add-Result 'fixtures.json' 'PASS' 'Synthetic JSON is valid.'
} catch {
  Add-Result 'fixtures.json' 'FAIL' "Synthetic JSON is invalid: $($_.Exception.Message)"
}

Test-ZipEntries 'fixtures.docx' (Join-Path $FixtureRoot 'baseline.docx') @(
  '[Content_Types].xml',
  'word/document.xml'
)
Test-ZipEntries 'fixtures.xlsx' (Join-Path $FixtureRoot 'baseline.xlsx') @(
  '[Content_Types].xml',
  'xl/workbook.xml',
  'xl/worksheets/sheet1.xml'
)
Test-ZipEntries 'fixtures.epub' (Join-Path $FixtureRoot 'baseline.epub') @(
  'META-INF/container.xml',
  'OEBPS/content.opf'
)

# JavaScript syntax validation is useful but optional in environments without Node.
$node = Get-Command 'node' -ErrorAction SilentlyContinue
if ($node) {
  $javascriptFiles = @(
    Get-ChildItem -LiteralPath (Get-ProjectFile 'backend') -Filter '*.js' -File -Recurse |
      Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' }
  )
  $nodeFailures = @()
  foreach ($file in $javascriptFiles) {
    & $node.Source --check $file.FullName 2>$null
    if ($LASTEXITCODE -ne 0) {
      $nodeFailures += $file.Name
    }
  }
  Assert-Condition 'javascript.syntax' ($nodeFailures.Count -eq 0) `
    "$($javascriptFiles.Count) backend JavaScript files passed node --check." `
    "JavaScript syntax failures: $($nodeFailures -join ', ')"
} else {
  Add-Result 'javascript.syntax' 'SKIP' 'Node.js is not available in PATH.'
}

$counts = [ordered]@{
  PASS = @($Results | Where-Object { $_.status -eq 'PASS' }).Count
  FAIL = @($Results | Where-Object { $_.status -eq 'FAIL' }).Count
  SKIP = @($Results | Where-Object { $_.status -eq 'SKIP' }).Count
}

$Results | ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath $JsonPath -Encoding UTF8

$report = @(
  '# Stage 0 static validation'
  ''
  "Generated: $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz'))"
  ''
  "Summary: PASS=$($counts.PASS), FAIL=$($counts.FAIL), SKIP=$($counts.SKIP)"
  ''
  '| Check | Status | Message |'
  '|---|---|---|'
)
foreach ($result in $Results) {
  $message = ([string]$result.message).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
  $report += "| $($result.id) | $($result.status) | $message |"
}
$report += @(
  ''
  'This report performs no Docker, network, GHCR or NAS operation.'
)
[System.IO.File]::WriteAllLines($ReportPath, $report, [System.Text.UTF8Encoding]::new($false))

Write-Host "Static validation report: $ReportPath"
if ($counts.FAIL -gt 0) {
  exit 1
}
exit 0
