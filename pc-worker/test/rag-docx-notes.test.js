import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { createRagContentExtractProcessor } from '../src/ragContentExtractProcessor.js'

const paragraph = (value) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`
function extract({ body, footnotes, endnotes, rels, target = 'word/footnotes.xml' }) {
  const zip = new AdmZip()
  zip.addFile('word/document.xml', Buffer.from(`<w:document>${paragraph(body)}</w:document>`))
  if (footnotes !== undefined) zip.addFile(target, Buffer.from(`<w:footnotes>${footnotes}</w:footnotes>`))
  if (endnotes !== undefined) zip.addFile('word/endnotes.xml', Buffer.from(`<w:endnotes>${endnotes}</w:endnotes>`))
  if (rels !== undefined) zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<Relationships>${rels}</Relationships>`))
  const buffer = zip.toBuffer()
  return createRagContentExtractProcessor().process({
    taskType: 'rag.content.extract', processorVersion: 'v1', executionClass: 'cpu',
    input: { schemaVersion: 1, sourceType: 'document', sourceId: 7, sourceVersionId: 'v1',
      sourceContentSha256: crypto.createHash('sha256').update(buffer).digest('hex'), contentBytes: buffer.length, format: 'docx' }
  }, Readable.from([buffer]))
}
// Close/open the text run so references are actual XML nodes, not visible text.
const ref = (kind, id) => `</w:t><w:${kind}Reference w:id="${id}"/><w:t>`
const note = (kind, id, value, attrs = '') => `<w:${kind} w:id="${id}" ${attrs}>${paragraph(value)}</w:${kind}>`
const relationship = (target, mode = '') => `<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="${target}" ${mode}/>`

test('DOCX attaches only referenced footnotes and endnotes to their owning text', async () => {
  const result = await extract({ body: `Permit${ref('footnote', 2)}. Stop${ref('endnote', 3)}.`,
    footnotes: note('footnote', -1, 'SECRET separator', 'w:type="separator"') + note('footnote', 1, 'unreferenced') + note('footnote', 2, 'Only for owners.'),
    endnotes: note('endnote', 3, 'Except active jobs.') })
  assert.equal(result.artifact.sections[0].text, 'Permit [footnote 2: Only for owners.] . Stop [endnote 3: Except active jobs.] .')
  assert.deepEqual(result.artifact.sections[0].locator, { paragraphStart: 0, paragraphEnd: 0 })
})
test('DOCX resolves a nonstandard internal note part and preserves visible text only', async () => {
  const result = await extract({ body: `Rule${ref('footnote', 1)}`, target: 'word/notes/custom.xml', rels: relationship('notes/custom.xml'),
    footnotes: note('footnote', 1, 'A &amp; B</w:t><w:instrText>hidden</w:instrText><w:t> only') })
  assert.equal(result.artifact.sections[0].text, 'Rule [footnote 1: A & B only]')
})
test('DOCX preserves nonbreaking hyphens inside referenced notes', async () => {
  const result = await extract({ body: `Rule${ref('footnote', 1)}${ref('endnote', 2)}`,
    footnotes: note('footnote', 1, 'Non</w:t><w:noBreakHyphen/><w:t>Performance only.'),
    endnotes: note('endnote', 2, 'Sub</w:t><w:noBreakHyphen/><w:t>Licensee excluded.') })
  assert.match(result.artifact.sections[0].text, /footnote 1: Non-Performance only/u)
  assert.match(result.artifact.sections[0].text, /endnote 2: Sub-Licensee excluded/u)
})

test('DOCX without note references ignores unused note parts', async () => {
  const result = await extract({ body: 'Original', footnotes: 'malformed unused notes' })
  assert.equal(result.artifact.sections[0].text, 'Original')
})
test('DOCX repeated references retain association without dropping either owning paragraph', async () => {
  const result = await extract({ body: `A${ref('footnote', 1)} B${ref('footnote', 1)}`,
    footnotes: note('footnote', 1, 'Applies to both.') })
  assert.equal(result.artifact.sections[0].text, 'A [footnote 1: Applies to both.] B [footnote 1: Applies to both.]')
})
test('DOCX accepts XML whitespace around note attributes', async () => {
  const result = await extract({ body: `A${ref('footnote', 1).replace('w:id=', 'w:id = ')}`,
    footnotes: note('footnote', 1, 'Condition').replace('w:id=', 'w:id = ') })
  assert.match(result.artifact.sections[0].text, /Condition/u)
})
test('DOCX rejects repeated note expansion above the artifact budget', async () => {
  await assert.rejects(extract({ body: ref('footnote', 1).repeat(18),
    footnotes: note('footnote', 1, 'x'.repeat(1024 * 1024)) }), { code: 'WORKER_CONTENT_EXTRACT_ARTIFACT_TOO_LARGE' })
})
test('DOCX note relationship cannot escape the package', async () => {
  await assert.rejects(extract({ body: ref('footnote', 1), rels: relationship('../../outside.xml') }),
    { code: 'WORKER_CONTENT_EXTRACT_ARCHIVE_UNSAFE' })
})
for (const [name, options] of Object.entries({
  missing: { footnotes: note('footnote', 2, 'Other') },
  duplicate: { footnotes: note('footnote', 1, 'A') + note('footnote', 1, 'B') },
  separator: { footnotes: note('footnote', 1, 'Separator', 'w:type="separator"') },
  nested: { footnotes: note('footnote', 1, `Nested${ref('footnote', 2)}`) },
  external: { rels: relationship('https://example.com/notes.xml', 'TargetMode="External"') },
  ambiguous: { rels: relationship('footnotes.xml') + relationship('other.xml') }
})) test(`DOCX rejects ${name} referenced notes instead of silently omitting evidence`, async () => {
  await assert.rejects(extract({ body: `Rule${ref('footnote', 1)}`, ...options }), { code: 'WORKER_CONTENT_EXTRACT_DOCX_NOTE_INVALID' })
})
