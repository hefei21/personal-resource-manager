[CmdletBinding()]
param(
  [string]$ProjectRoot,
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $ProjectRoot '.codex\stage-1'
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$RoutesRoot = Join-Path $ProjectRoot 'backend\src\routes'
$JsonPath = Join-Path $OutputRoot 'route-inventory.json'
$ReportPath = Join-Path $OutputRoot 'route-inventory.md'

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$records = [System.Collections.Generic.List[object]]::new()
foreach ($file in Get-ChildItem -LiteralPath $RoutesRoot -Filter '*.js' -File | Sort-Object Name) {
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $file.FullName -Encoding UTF8) {
    $lineNumber++
    if ($line -notmatch 'router\.(get|post|put|patch|delete)\s*\(') {
      continue
    }

    $method = $matches[1].ToUpperInvariant()
    $pathMatch = [regex]::Match($line, "router\.(?:get|post|put|patch|delete)\s*\(\s*['""]([^'""]+)['""]")
    $routePath = if ($pathMatch.Success) { $pathMatch.Groups[1].Value } else { '<dynamic>' }
    $authenticated = $line -match '\bauthenticateToken\b'
    $writeGuard = $line -match '\brequireWritePermission\b'
    $mutating = $method -in @('POST', 'PUT', 'PATCH', 'DELETE')

    $flags = [System.Collections.Generic.List[string]]::new()
    if (-not $authenticated) {
      $flags.Add('NO_AUTH')
    }
    if ($mutating -and -not $writeGuard) {
      $flags.Add('NO_WRITE_GUARD')
    }
    if ($line -match 'req\.query\.token|token') {
      # This is only a routing-line hint; detailed token-flow review remains
      # source based and is not inferred from this flag.
      $flags.Add('TOKEN_REVIEW')
    }

    $records.Add([ordered]@{
      module = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
      file = "backend/src/routes/$($file.Name)"
      line = $lineNumber
      method = $method
      path = $routePath
      authenticated = $authenticated
      writeGuard = $writeGuard
      mutating = $mutating
      flags = @($flags)
      declaration = $line.Trim()
    })
  }
}

$summary = [ordered]@{
  generatedAt = [DateTime]::Now.ToString('o')
  total = $records.Count
  byMethod = [ordered]@{}
  unauthenticated = @($records | Where-Object { -not $_.authenticated }).Count
  mutatingWithoutWriteGuard = @(
    $records | Where-Object { $_.mutating -and -not $_.writeGuard }
  ).Count
}
foreach ($group in $records | Group-Object method | Sort-Object Name) {
  $summary.byMethod[$group.Name] = $group.Count
}

[ordered]@{
  summary = $summary
  routes = $records
} | ConvertTo-Json -Depth 8 |
  Set-Content -LiteralPath $JsonPath -Encoding UTF8

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# Route authorization inventory')
$lines.Add('')
$lines.Add("Generated: $($summary.generatedAt)")
$lines.Add('')
$lines.Add("Total routes: $($summary.total)")
$lines.Add('')
$lines.Add("| Metric | Count |")
$lines.Add("|---|---:|")
foreach ($method in $summary.byMethod.Keys) {
  $lines.Add("| $method | $($summary.byMethod[$method]) |")
}
$lines.Add("| Unauthenticated | $($summary.unauthenticated) |")
$lines.Add("| Mutating without write guard | $($summary.mutatingWithoutWriteGuard) |")
$lines.Add('')
$lines.Add('## Routes requiring policy classification')
$lines.Add('')
$lines.Add('| Module | Source | Method | Path | Auth | Write guard | Flags |')
$lines.Add('|---|---|---|---|---:|---:|---|')
foreach ($record in $records | Where-Object { $_.flags.Count -gt 0 }) {
  $flags = $record.flags -join ', '
  $lines.Add(
    "| $($record.module) | $($record.file):$($record.line) | " +
    "$($record.method) | ``$($record.path)`` | " +
    "$($record.authenticated) | $($record.writeGuard) | $flags |"
  )
}
$lines.Add('')
$lines.Add(
  'This inventory identifies middleware presence only. Every flagged route ' +
  'must be classified against the approved authorization matrix before repair.'
)

[System.IO.File]::WriteAllLines(
  $ReportPath,
  $lines,
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Route inventory JSON: $JsonPath"
Write-Host "Route inventory report: $ReportPath"
Write-Host (
  "Routes=$($summary.total) Unauthenticated=$($summary.unauthenticated) " +
  "MutatingWithoutWriteGuard=$($summary.mutatingWithoutWriteGuard)"
)
