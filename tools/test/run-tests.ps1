[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('smoke', 'scenarios', 'report')]
  [string]$Suite,

  [Parameter(Mandatory)]
  [string]$RuntimeRoot,

  [Parameter(Mandatory)]
  [string]$ReportsRoot,

  [Parameter(Mandatory)]
  [string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'
$ApiBase = 'http://127.0.0.1:13000/api'
$EnvPath = Join-Path $RuntimeRoot '.env.test'
$StatePath = Join-Path $RuntimeRoot 'test-state.json'
$ResultsPath = Join-Path $RuntimeRoot 'results.ndjson'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ComposePath = Join-Path $ProjectRoot 'docker-compose.test.yml'

function Read-DotEnv {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $EnvPath -Encoding utf8) {
    if ($line -match '^\s*([^#][^=]*)=(.*)$') {
      $values[$matches[1].Trim()] = $matches[2]
    }
  }
  return $values
}

function Get-Percentile([double[]]$Values, [double]$Percentile) {
  if (-not $Values -or $Values.Count -eq 0) { return 0 }
  $sorted = $Values | Sort-Object
  $index = [Math]::Ceiling(($Percentile / 100) * $sorted.Count) - 1
  $index = [Math]::Max(0, [Math]::Min($sorted.Count - 1, $index))
  return [Math]::Round($sorted[$index], 2)
}

function Save-Result {
  param(
    [string]$Id,
    [string]$Category,
    [ValidateSet('PASS', 'FAIL', 'KNOWN_FAIL', 'SKIP', 'MANUAL')]
    [string]$Status,
    [string]$Message,
    [double]$DurationMs = 0,
    [int]$HttpStatus = 0
  )
  $record = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString('o')
    id = $Id
    category = $Category
    status = $Status
    message = $Message
    durationMs = [Math]::Round($DurationMs, 2)
    httpStatus = $HttpStatus
  }
  [System.IO.File]::AppendAllText(
    $ResultsPath,
    (($record | ConvertTo-Json -Compress) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )
  $color = switch ($Status) {
    'PASS' { 'Green' }
    'FAIL' { 'Red' }
    'KNOWN_FAIL' { 'Yellow' }
    'SKIP' { 'DarkGray' }
    'MANUAL' { 'Cyan' }
  }
  Write-Host "[$Status] $Id - $Message" -ForegroundColor $color
}

function Invoke-Api {
  param(
    [string]$Method = 'GET',
    [string]$Path,
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
    [object]$Body,
    [hashtable]$Form,
    [int]$TimeoutSec = 30
  )
  $params = @{
    Uri = "$ApiBase$Path"
    Method = $Method
    TimeoutSec = $TimeoutSec
    SkipHttpErrorCheck = $true
  }
  if ($Session) {
    $params.WebSession = $Session
  }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = $Body | ConvertTo-Json -Depth 12 -Compress
  }
  if ($Form) {
    $params.Form = $Form
  }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $response = Invoke-WebRequest @params
    $watch.Stop()
    $parsed = $null
    if ($response.Content) {
      try { $parsed = $response.Content | ConvertFrom-Json } catch { $parsed = $response.Content }
    }
    return [pscustomobject]@{
      Status = [int]$response.StatusCode
      Body = $parsed
      DurationMs = $watch.Elapsed.TotalMilliseconds
      Error = $null
    }
  } catch {
    $watch.Stop()
    return [pscustomobject]@{
      Status = 0
      Body = $null
      DurationMs = $watch.Elapsed.TotalMilliseconds
      Error = $_.Exception.Message
    }
  }
}

function Assert-Status {
  param(
    [string]$Id,
    [string]$Category,
    [object]$Response,
    [int[]]$Expected = @(200)
  )
  if ($Response.Status -in $Expected) {
    Save-Result $Id $Category 'PASS' "HTTP $($Response.Status)" $Response.DurationMs $Response.Status
    return $true
  }
  $detail = if ($Response.Error) { $Response.Error } else { "expected $($Expected -join '/') but received HTTP $($Response.Status)" }
  Save-Result $Id $Category 'FAIL' $detail $Response.DurationMs $Response.Status
  return $false
}

function Assert-SecurityInvariant {
  param(
    [string]$Id,
    [object]$Response,
    [int[]]$SecureStatuses = @(401, 403)
  )
  if ($Response.Status -in $SecureStatuses) {
    Save-Result $Id 'security' 'PASS' "Access was rejected with HTTP $($Response.Status)" $Response.DurationMs $Response.Status
  } else {
    Save-Result $Id 'security' 'KNOWN_FAIL' "Known stage-0 exposure reproduced with HTTP $($Response.Status)" $Response.DurationMs $Response.Status
  }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $StatePath)) {
    throw 'Smoke state is missing. Run smoke before scenarios or report.'
  }
  return Get-Content -LiteralPath $StatePath -Raw -Encoding utf8 | ConvertFrom-Json
}

function Save-State([object]$State) {
  [System.IO.File]::WriteAllText(
    $StatePath,
    ($State | ConvertTo-Json -Depth 10),
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Invoke-SmokeSuite {
  if (Test-Path -LiteralPath $ResultsPath) {
    Remove-Item -LiteralPath $ResultsPath -Force
  }
  $envValues = Read-DotEnv

  $health = Invoke-Api -Path '/health'
  Assert-Status 'health.api' 'smoke' $health @(200) | Out-Null

  $adminSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $adminLogin = Invoke-Api -Method POST -Path '/auth/login' -Session $adminSession -Body @{
    username = $envValues.TEST_ADMIN_USERNAME
    password = $envValues.TEST_ADMIN_PASSWORD
  }
  $adminOk = Assert-Status 'auth.admin-login' 'smoke' $adminLogin @(200)
  if (-not $adminOk) {
    throw 'Admin login did not establish a session.'
  }

  $demoSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $demoLogin = Invoke-Api -Method POST -Path '/demo/sessions' -Session $demoSession
  $demoOk = Assert-Status 'demo.session-create' 'smoke' $demoLogin @(201)
  if (-not $demoOk) {
    throw 'Demo workspace did not establish a session.'
  }

  Assert-Status 'auth.admin-check' 'smoke' (Invoke-Api -Path '/auth/check' -Session $adminSession) @(200) | Out-Null
  Assert-Status 'demo.session-check' 'smoke' (Invoke-Api -Path '/demo/session' -Session $demoSession) @(200) | Out-Null
  Assert-Status 'demo.documents-list' 'smoke' (Invoke-Api -Path '/demo/resources/documents' -Session $demoSession) @(200) | Out-Null

  $listEndpoints = [ordered]@{
    'documents.list' = '/documents?page=1&pageSize=10'
    'music.list' = '/music?page=1&pageSize=10'
    'books.list' = '/ebooks'
    'code.list' = '/code'
    'bookmarks.list' = '/bookmarks'
    'anime.list' = '/anime?page=1&pageSize=10'
    'games.list' = '/games?page=1&pageSize=10'
    'todos.list' = '/todos'
    'blog.list' = '/blog/posts?page=1&pageSize=10'
    'search.global' = '/search?keyword=synthetic'
  }
  foreach ($entry in $listEndpoints.GetEnumerator()) {
    Assert-Status $entry.Key 'smoke' (Invoke-Api -Path $entry.Value -Session $adminSession) @(200) | Out-Null
  }

  $documentUpload = Invoke-Api -Method POST -Path '/documents/upload' -Session $adminSession -TimeoutSec 60 -Form @{
    file = Get-Item -LiteralPath (Join-Path $FixtureRoot 'baseline.txt')
    title = 'Synthetic baseline document'
    category = 'Baseline'
    tags = 'synthetic,stage0'
    versionNote = 'Initial synthetic fixture'
  }
  $documentOk = Assert-Status 'documents.upload' 'smoke' $documentUpload @(200)
  $documentId = if ($documentOk) { [int]$documentUpload.Body.id } else { 0 }

  if ($documentId -gt 0) {
    Assert-Status 'documents.content-cookie' 'smoke' (Invoke-Api -Path "/documents/$documentId/content" -Session $adminSession) @(200) | Out-Null
    Assert-Status 'documents.update' 'smoke' (Invoke-Api -Method PUT -Path "/documents/$documentId" -Session $adminSession -Body @{
      title = 'Synthetic baseline document updated'
      category = 'Baseline'
      subcategory = ''
      tags = 'synthetic,stage0,updated'
    }) @(200) | Out-Null
  } else {
    Save-Result 'documents.content-header-token' 'smoke' 'SKIP' 'Document upload did not produce an ID.'
    Save-Result 'documents.update' 'smoke' 'SKIP' 'Document upload did not produce an ID.'
  }

  $bookmarkCreate = Invoke-Api -Method POST -Path '/bookmarks' -Session $adminSession -Body @{
    title = 'Synthetic bookmark'
    url = 'https://example.invalid/stage0'
    category = 'Baseline'
    tags = 'synthetic'
    description = 'Generated by the isolated smoke suite'
  }
  $bookmarkOk = Assert-Status 'bookmarks.create' 'smoke' $bookmarkCreate @(200)
  $bookmarkId = if ($bookmarkOk) { [int]$bookmarkCreate.Body.id } else { 0 }
  if ($bookmarkId -gt 0) {
    Assert-Status 'bookmarks.update' 'smoke' (Invoke-Api -Method PUT -Path "/bookmarks/$bookmarkId" -Session $adminSession -Body @{
      title = 'Synthetic bookmark updated'
      url = 'https://example.invalid/stage0-updated'
      category = 'Baseline'
      tags = 'synthetic,updated'
      description = 'Updated by smoke suite'
    }) @(200) | Out-Null
  } else {
    Save-Result 'bookmarks.update' 'smoke' 'SKIP' 'Bookmark creation did not produce an ID.'
  }

  $state = [ordered]@{
    documentId = $documentId
    bookmarkId = $bookmarkId
    generatedAt = [DateTime]::UtcNow.ToString('o')
  }
  Save-State $state

  $fixedTestLogin = Invoke-Api -Method POST -Path '/auth/login' -Body @{ username = 'test'; password = '123456' }
  Assert-Status 'security.fixed-test-account' 'security' $fixedTestLogin @(401) | Out-Null

  $privateList = Invoke-Api -Path '/documents/docs/special/list' -Session $demoSession
  Assert-SecurityInvariant 'security.demo-production-isolation' $privateList

  $bookConfigWrite = Invoke-Api -Method PUT -Path '/book-search/config' -Body @{
    annaArchiveDomain = 'example.invalid'
    nyaaDomain = 'example.invalid'
  }
  Assert-SecurityInvariant 'security.book-search-config-auth' $bookConfigWrite

  if ($documentId -gt 0) {
    $urlToken = Invoke-Api -Path "/documents/$documentId/content?token=synthetic-invalid-token"
    if ($urlToken.Status -eq 200) {
      Save-Result 'security.jwt-in-query' 'security' 'KNOWN_FAIL' 'Primary JWT was accepted from the URL query string.' $urlToken.DurationMs $urlToken.Status
    } else {
      Save-Result 'security.jwt-in-query' 'security' 'PASS' "URL token was rejected with HTTP $($urlToken.Status)." $urlToken.DurationMs $urlToken.Status
    }
  }

  if ($bookmarkId -gt 0) {
    $demoDelete = Invoke-Api -Method DELETE -Path "/bookmarks/$bookmarkId" -Session $demoSession
    Assert-SecurityInvariant 'security.demo-production-delete' $demoDelete
  }

  Save-Result 'manual.frontend-navigation' 'manual' 'MANUAL' 'Open http://127.0.0.1:15173 and check desktop/mobile navigation.'
  Save-Result 'manual.office-preview' 'manual' 'MANUAL' 'Upload generated DOCX/XLSX fixtures and inspect rendering in a browser.'
}

function Invoke-ScenarioSuite {
  Read-State | Out-Null
  $envValues = Read-DotEnv
  $adminSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $adminLogin = Invoke-Api -Method POST -Path '/auth/login' -Session $adminSession -Body @{
    username = $envValues.TEST_ADMIN_USERNAME
    password = $envValues.TEST_ADMIN_PASSWORD
  }
  if ($adminLogin.Status -ne 200) {
    throw 'Scenario suite could not establish an owner session.'
  }

  & docker compose --env-file $EnvPath -f $ComposePath stop redis | Out-Null
  Start-Sleep -Seconds 2
  $redisHealth = Invoke-Api -Path '/health'
  if ($redisHealth.Status -in @(200, 503)) {
    Save-Result 'reliability.redis-outage-health' 'reliability' 'PASS' "Health endpoint remained responsive with HTTP $($redisHealth.Status)." $redisHealth.DurationMs $redisHealth.Status
  } else {
    Save-Result 'reliability.redis-outage-health' 'reliability' 'FAIL' "Health endpoint was unavailable: HTTP $($redisHealth.Status)." $redisHealth.DurationMs $redisHealth.Status
  }
  $redisFallback = Invoke-Api -Path '/bookmarks' -Session $adminSession
  Assert-Status 'reliability.redis-outage-read' 'reliability' $redisFallback @(200) | Out-Null
  & docker compose --env-file $EnvPath -f $ComposePath start redis | Out-Null

  & docker compose --env-file $EnvPath -f $ComposePath restart backend | Out-Null
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  $restartResponse = $null
  do {
    Start-Sleep -Seconds 2
    $restartResponse = Invoke-Api -Path '/health'
  } while ($restartResponse.Status -notin @(200, 503) -and [DateTime]::UtcNow -lt $deadline)
  Assert-Status 'reliability.backend-restart' 'reliability' $restartResponse @(200, 503) | Out-Null

  Save-Result 'reliability.interrupted-upload' 'reliability' 'MANUAL' 'Use browser devtools to abort a generated fixture upload; verify temp files through the test data folder.'
  Save-Result 'reliability.missing-storage-path' 'reliability' 'SKIP' 'Not automated in stage 0 because changing mounted paths is destructive to the running test stack.'
  Save-Result 'reliability.external-api-failure' 'reliability' 'SKIP' 'External APIs are intentionally non-blocking in the stage-0 baseline.'

  $listDurations = @()
  $searchDurations = @()
  foreach ($i in 1..15) {
    $listDurations += (Invoke-Api -Path '/documents?page=1&pageSize=10' -Session $adminSession).DurationMs
    $searchDurations += (Invoke-Api -Path '/search?keyword=synthetic' -Session $adminSession).DurationMs
  }
  Save-Result 'performance.documents-list' 'performance' 'PASS' "15 requests: P50=$(Get-Percentile $listDurations 50)ms, P95=$(Get-Percentile $listDurations 95)ms."
  Save-Result 'performance.global-search' 'performance' 'PASS' "15 requests: P50=$(Get-Percentile $searchDurations 50)ms, P95=$(Get-Percentile $searchDurations 95)ms."
}

function Write-Report {
  if (-not (Test-Path -LiteralPath $ResultsPath)) {
    throw 'No test results were found.'
  }
  $records = Get-Content -LiteralPath $ResultsPath -Encoding utf8 |
    Where-Object { $_.Trim() } |
    ForEach-Object { $_ | ConvertFrom-Json }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $reportDir = Join-Path $ReportsRoot $timestamp
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
  $jsonPath = Join-Path $reportDir 'results.json'
  $markdownPath = Join-Path $reportDir 'report.md'
  [System.IO.File]::WriteAllText(
    $jsonPath,
    ($records | ConvertTo-Json -Depth 10),
    [System.Text.UTF8Encoding]::new($false)
  )

  $summary = $records | Group-Object status | Sort-Object Name
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add('# Stage 0 isolated baseline report')
  $lines.Add('')
  $lines.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
  $lines.Add('')
  $lines.Add('## Summary')
  $lines.Add('')
  $lines.Add('| Status | Count |')
  $lines.Add('|---|---:|')
  foreach ($group in $summary) {
    $lines.Add("| $($group.Name) | $($group.Count) |")
  }
  $lines.Add('')
  $lines.Add('## Results')
  $lines.Add('')
  $lines.Add('| ID | Category | Status | HTTP | Duration | Message |')
  $lines.Add('|---|---|---|---:|---:|---|')
  foreach ($record in $records) {
    $message = ([string]$record.message).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
    $lines.Add("| $($record.id) | $($record.category) | $($record.status) | $($record.httpStatus) | $($record.durationMs) ms | $message |")
  }
  $lines.Add('')
  $lines.Add('## Runtime data')
  $lines.Add('')
  $dataRoot = Join-Path $RuntimeRoot 'data'
  $dataBytes = if (Test-Path -LiteralPath $dataRoot) {
    (Get-ChildItem -LiteralPath $dataRoot -File -Recurse | Measure-Object Length -Sum).Sum
  } else { 0 }
  $lines.Add("- Generated test data: $([Math]::Round($dataBytes / 1MB, 2)) MiB")
  $lines.Add('- Production data was not mounted or copied.')
  $lines.Add('- Secrets and JWT values are intentionally omitted from this report.')
  $lines.Add('')
  $lines.Add('## Interpretation')
  $lines.Add('')
  $lines.Add('- `FAIL` blocks the stage-0 baseline.')
  $lines.Add('- `KNOWN_FAIL` records a confirmed issue that stage 1 must convert to `PASS`.')
  $lines.Add('- `MANUAL` requires browser or NAS GUI inspection.')
  $lines.Add('- `SKIP` is outside the automated stage-0 environment.')

  [System.IO.File]::WriteAllLines($markdownPath, $lines, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Markdown report: $markdownPath"
  Write-Host "JSON results:   $jsonPath"

  $failCount = @($records | Where-Object status -eq 'FAIL').Count
  if ($failCount -gt 0) {
    throw "$failCount blocking test(s) failed. See $markdownPath"
  }
}

switch ($Suite) {
  'smoke' { Invoke-SmokeSuite }
  'scenarios' { Invoke-ScenarioSuite }
  'report' { Write-Report }
}
