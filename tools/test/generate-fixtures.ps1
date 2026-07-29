[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'

function Write-Utf8File([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function New-ZipFixture([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Force
  }
  $temporaryZip = [System.IO.Path]::ChangeExtension($Destination, '.zip')
  if (Test-Path -LiteralPath $temporaryZip) {
    Remove-Item -LiteralPath $temporaryZip -Force
  }
  Compress-Archive -Path (Join-Path $Source '*') -DestinationPath $temporaryZip -CompressionLevel Optimal
  Move-Item -LiteralPath $temporaryZip -Destination $Destination
}

function New-WaveFixture([string]$Path) {
  $sampleRate = 8000
  $durationSeconds = 1
  $samples = $sampleRate * $durationSeconds
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $dataLength = $samples * 2
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
    $writer.Write(36 + $dataLength)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
    $writer.Write(16)
    $writer.Write([int16]1)
    $writer.Write([int16]1)
    $writer.Write($sampleRate)
    $writer.Write($sampleRate * 2)
    $writer.Write([int16]2)
    $writer.Write([int16]16)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
    $writer.Write($dataLength)
    for ($i = 0; $i -lt $samples; $i++) {
      $value = [int16](12000 * [Math]::Sin(2 * [Math]::PI * 440 * $i / $sampleRate))
      $writer.Write($value)
    }
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

Write-Utf8File (Join-Path $OutputRoot 'baseline.txt') "Synthetic baseline text.`nNo production or personal data is included.`n"
Write-Utf8File (Join-Path $OutputRoot 'baseline.md') "# Synthetic baseline`n`n- isolated`n- repeatable`n- privacy-safe`n"
Write-Utf8File (Join-Path $OutputRoot 'baseline.json') '{"name":"synthetic-baseline","private":false,"items":[1,2,3]}'
Write-Utf8File (Join-Path $OutputRoot 'baseline.csv') "id,name,status`n1,alpha,ready`n2,beta,pending`n"

$pngBytes = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
[System.IO.File]::WriteAllBytes((Join-Path $OutputRoot 'cover.png'), $pngBytes)
New-WaveFixture (Join-Path $OutputRoot 'tone.wav')

$workRoot = Join-Path $OutputRoot '.work'
if (Test-Path -LiteralPath $workRoot) {
  Remove-Item -LiteralPath $workRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

$docx = Join-Path $workRoot 'docx'
Write-Utf8File (Join-Path $docx '[Content_Types].xml') '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
Write-Utf8File (Join-Path $docx '_rels\.rels') '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
Write-Utf8File (Join-Path $docx 'word\document.xml') '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic DOCX fixture</w:t></w:r></w:p></w:body></w:document>'
New-ZipFixture $docx (Join-Path $OutputRoot 'baseline.docx')

$xlsx = Join-Path $workRoot 'xlsx'
Write-Utf8File (Join-Path $xlsx '[Content_Types].xml') '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
Write-Utf8File (Join-Path $xlsx '_rels\.rels') '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
Write-Utf8File (Join-Path $xlsx 'xl\workbook.xml') '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Baseline" sheetId="1" r:id="rId1"/></sheets></workbook>'
Write-Utf8File (Join-Path $xlsx 'xl\_rels\workbook.xml.rels') '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
Write-Utf8File (Join-Path $xlsx 'xl\worksheets\sheet1.xml') '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Synthetic XLSX fixture</t></is></c></row></sheetData></worksheet>'
New-ZipFixture $xlsx (Join-Path $OutputRoot 'baseline.xlsx')

$epub = Join-Path $workRoot 'epub'
Write-Utf8File (Join-Path $epub 'mimetype') 'application/epub+zip'
Write-Utf8File (Join-Path $epub 'META-INF\container.xml') '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
Write-Utf8File (Join-Path $epub 'OEBPS\content.opf') '<?xml version="1.0" encoding="UTF-8"?><package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic EPUB</dc:title><dc:creator>Baseline Generator</dc:creator><dc:identifier id="bookid">synthetic-epub-001</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'
Write-Utf8File (Join-Path $epub 'OEBPS\chapter.xhtml') '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Baseline</title></head><body><h1>Synthetic chapter</h1><p>No production data.</p></body></html>'
New-ZipFixture $epub (Join-Path $OutputRoot 'baseline.epub')

$repo = Join-Path $OutputRoot 'sample-repository'
Write-Utf8File (Join-Path $repo 'README.md') "# Synthetic repository`n`nGenerated for isolated baseline testing."
Write-Utf8File (Join-Path $repo 'src\index.js') "export function baseline(value) { return String(value ?? 'synthetic') }`n"
Write-Utf8File (Join-Path $repo 'data\config.json') '{"environment":"isolated-test"}'

Remove-Item -LiteralPath $workRoot -Recurse -Force
Write-Host "Synthetic fixtures generated at $OutputRoot"
