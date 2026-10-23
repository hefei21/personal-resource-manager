import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceApiDeclarations, declaredApiName } from '../src/services/ragApiDeclarations.js'
const read = text => sourceApiDeclarations({ sections: [{ format: 'txt', text }] })
test('raw declaration provenance excludes examples, fences, methods, overloads and ambiguous modules', () => {
  const module = '.. module:: alpha\n\n'
  assert.deepEqual(read(module + '.. function:: wait(x)'), [{ name: 'wait', module: 'alpha', line: 3 }])
  assert.equal(read(module + '.. function:: wait').length, 1)
  for (const suffix of [
    '.. code-block:: rst\n\n   .. function:: wait(x)',
    'Example::\n\n   .. function:: wait(x)',
    'Example::\n\n' + '   filler\n'.repeat(1000) + '\n   .. function:: wait(x)',
    '```rst\n.. function:: wait(x)\n```',
    '.. function:: wait(x)\n\n.. function:: wait(y)',
    '.. module:: beta\n\n.. function:: wait(x)',
    '.. method:: wait(x)', '.. function:: wait extra', '.. function:: wait.member(x)'
  ]) assert.deepEqual(read(module + suffix), [], suffix.slice(0, 60))
  assert.deepEqual(read('.. function:: wait(x)'), [])
  assert.equal(declaredApiName('wait返回什么？'), 'wait')
  for (const q of ['wait和poll？', 'ｗait如何？', 'wait20秒与wait？', 'wait']) assert.equal(declaredApiName(q), null)
})
