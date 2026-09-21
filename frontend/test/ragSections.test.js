import test from 'node:test'
import assert from 'node:assert/strict'
import { useRagSections } from '../src/composables/useRagSections.js'

const response = sections => ({ data: { data: { sections } } })
const chapter = { key: 'a'.repeat(64), label: '第一章', chapterIndex: 0 }
test('default stays whole-book after loading; failed refresh preserves explicit selection', async () => {
  let fail = false
  const state = useRagSections({ api: { sections: async () => { if (fail) throw Error(); return response([chapter]) } } })
  await state.load(1)
  assert.equal(state.selected.value, '')
  state.selected.value = chapter.key
  fail = true
  await state.retry()
  assert.equal(state.selected.value, chapter.key)
  assert.ok(state.error.value)
  fail = false
  await state.load(2)
  assert.equal(state.selected.value, '')
})
test('late chapter lists cannot cross books or refill an unmounted view', async () => {
  const pending = []
  const state = useRagSections({ api: { sections: () => new Promise(resolve => pending.push(resolve)) } })
  const first = state.load(1), second = state.load(2)
  pending[1](response([{ ...chapter, label: 'second' }]))
  await second
  pending[0](response([chapter]))
  await first
  assert.equal(state.options.value[0].label, 'second')
  const third = state.load(3)
  state.dispose()
  pending[2](response([chapter]))
  await third
  assert.deepEqual(state.options.value, [])
})
test('stale selected key is not silently replaced with whole-book', async () => {
  const state = useRagSections({ api: { sections: async () => response([]) } })
  await state.load(1)
  state.selected.value = chapter.key
  await state.retry()
  assert.equal(state.selected.value, chapter.key)
  assert.match(state.error.value, /失效/u)
})
