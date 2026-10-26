import assert from 'node:assert/strict'
import test from 'node:test'
import { preserveDocxTableRows } from '../src/docxTableRows.js'

const cell = value => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`
const table = `<w:tbl><w:tr>${cell('A')}${cell('B')}</w:tr><w:tr>${cell('C')}${cell('D')}</w:tr></w:tbl>`
const render = value => value.replace(/<[^>]*>/gu, '')

test('DOCX table candidate ignores markup-like comments and quoted greater-than, preserves surrounding XML', () => {
  const prefix = '<?xml version="1.0"?><!-- <w:tbl>not content</w:tbl> --><w:document><w:body><w:p note="x > y"/>'
  const result = preserveDocxTableRows(prefix + table + '</w:body></w:document>', render)
  assert.equal(result.length, 1)
  assert.equal(result[0].start, prefix.length)
  assert.equal(result[0].end, prefix.length + table.length)
  assert.deepEqual(result[0].rows, ['| A | B |', '| C | D |'])
})

test('DOCX table candidate never reparents nested/textbox tables or repairs malformed/DTD XML', () => {
  for (const xml of [
    `<w:document><w:body><w:p><w:txbxContent>${table}</w:txbxContent></w:p></w:body></w:document>`,
    `<w:document><w:body>${table}</w:document>`,
    `<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///private">]><w:document><w:body>${table}</w:body></w:document>`
  ]) assert.deepEqual(preserveDocxTableRows(xml, () => { throw Error('must not render') }), [])
})
