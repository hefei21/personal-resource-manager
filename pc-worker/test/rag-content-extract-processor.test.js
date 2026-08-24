import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import test from 'node:test'

import AdmZip from 'adm-zip'

import { createRagContentExtractProcessor } from '../src/ragContentExtractProcessor.js'

function task(format, buffer) {
  return {
    taskType: 'rag.content.extract',
    processorVersion: 'v1',
    executionClass: 'cpu',
    input: {
      schemaVersion: 1,
      sourceType: format === 'epub' ? 'ebook' : 'document',
      sourceId: 7,
      sourceVersionId: 'version-7',
      sourceContentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      contentBytes: buffer.length,
      format
    }
  }
}

function docx() {
  const zip = new AdmZip()
  zip.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>'))
  return zip.toBuffer()
}

function epub() {
  const zip = new AdmZip()
  zip.addFile('META-INF/container.xml', Buffer.from('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'))
  zip.addFile('OPS/book.opf', Buffer.from('<package><manifest><item id="c1" href="chapter.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>'))
  zip.addFile('OPS/chapter.xhtml', Buffer.from('<html><head><title>Chapter One</title></head><body><h1>Hello</h1><p>Grounded text.</p></body></html>'))
  return zip.toBuffer()
}

function pdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (Hello PDF evidence) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}

test('extracts bounded DOCX paragraphs into a hash-bound artifact manifest', async () => {
  const buffer = docx()
  const result = await createRagContentExtractProcessor().process(task('docx', buffer), Readable.from([buffer]))
  assert.equal(result.output.sectionCount, 1)
  assert.equal(result.output.manifest.format, 'docx')
  assert.match(result.output.manifest.sections[0].text, /第一段\n\nSecond paragraph/u)
  assert.equal(result.output.artifactSha256, result.output.manifest.artifactSha256)
})

test('extracts EPUB spine order and strips markup', async () => {
  const buffer = epub()
  const result = await createRagContentExtractProcessor().process(task('epub', buffer), Readable.from([buffer]))
  assert.equal(result.output.manifest.sections[0].title, 'Chapter One')
  assert.match(result.output.manifest.sections[0].text, /Hello Grounded text\./u)
  assert.deepEqual(result.output.manifest.sections[0].locator, { spineIndex: 0 })
})

test('extracts PDF page text with a page locator', async () => {
  const buffer = pdf()
  const result = await createRagContentExtractProcessor().process(task('pdf', buffer), Readable.from([buffer]))
  assert.equal(result.output.manifest.sections[0].title, 'Page 1')
  assert.match(result.output.manifest.sections[0].text, /Hello PDF evidence/u)
  assert.deepEqual(result.output.manifest.sections[0].locator, { page: 1 })
})

test('rejects hash mismatch, malformed archives, and unsupported formats', async () => {
  const buffer = docx()
  const mismatch = task('docx', buffer)
  mismatch.input.sourceContentSha256 = 'a'.repeat(64)
  await assert.rejects(createRagContentExtractProcessor().process(mismatch, Readable.from([buffer])), (error) => error.code === 'WORKER_INPUT_MISMATCH')

  const malformed = Buffer.from('not a zip archive')
  await assert.rejects(createRagContentExtractProcessor().process(task('docx', malformed), Readable.from([malformed])),
    (error) => error.code === 'WORKER_CONTENT_EXTRACT_ARCHIVE_INVALID')

  const invalid = task('docx', buffer)
  invalid.input.format = 'exe'
  await assert.rejects(createRagContentExtractProcessor().process(invalid, Readable.from([buffer])),
    (error) => error.code === 'WORKER_CONTENT_EXTRACT_INPUT_INVALID')
})
