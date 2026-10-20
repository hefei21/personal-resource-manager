import test from 'node:test'
import assert from 'node:assert/strict'
import { mapQuestionSlots } from '../src/ragQuestionPlan.js'

const evidence = [{ citationId: 'C1' }, { citationId: 'C2' }]
const yes = (answer, citations = ['C1']) => ({ status: 'supported', answer, citations, missing: [] })
const no = { status: 'unsupported', answer: '', citations: [], missing: [] }

test('multi-slot flattening retains literal objects and order without changing values', () => {
  const result = mapQuestionSlots({ Q2: yes('7天', ['C2']), Q1: yes('20天') }, { spans: ['请求保留多久？', '到书保留多久？'] }, evidence)
  assert.equal(result.answer, '问题：请求保留多久？\n20天\n\n问题：到书保留多久？\n7天')
  assert.deepEqual(result.citations, ['C1', 'C2'])
  assert.equal(result.reasonCode, 'GROUNDED')
})

test('single answers and full refusals retain their original representation', () => {
  assert.equal(mapQuestionSlots({ Q1: yes('原答') }, { spans: ['问题？'] }, evidence).answer, '原答')
  const result = mapQuestionSlots({ Q1: no, Q2: no }, { spans: ['未知一？', '未知二？'] }, evidence)
  assert.equal(result.answer, '')
  assert.equal(result.abstained, true)
  assert.deepEqual(result.citations, [])
})

test('partial answers keep missing requirements separate and do not label them as answered', () => {
  const result = mapQuestionSlots({ Q1: no, Q2: { status: 'partial', answer: '已知', citations: ['C2'], missing: ['另一个条件'] } }, { spans: ['未知？', '对象②怎样？'] }, evidence)
  assert.equal(result.answer, '问题：对象②怎样？\n已知')
  assert.deepEqual(result.missingRequirements, ['未知？', '另一个条件'])
  assert.equal(result.reasonCode, 'PARTIAL')
  assert.throws(() => mapQuestionSlots({ Q1: yes('x', ['C99']) }, { spans: ['问题？'] }, evidence))
})
