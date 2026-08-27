import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acquireBodyScrollLock,
  filterFocusableCandidates,
  getNextFocusIndex
} from '../src/composables/useModalFocus.js'

test('filters disabled, hidden, and negative-tab-index candidates', () => {
  const candidates = [
    { id: 'button' },
    { id: 'disabled', disabled: true },
    { id: 'hidden', hidden: true },
    { id: 'aria-hidden', ariaHidden: 'true' },
    { id: 'negative', tabIndex: -1 },
    { id: 'string-zero', tabIndex: '0' },
    { id: 'hidden-input', type: 'hidden' }
  ]

  assert.deepEqual(
    filterFocusableCandidates(candidates).map((candidate) => candidate.id),
    ['button', 'string-zero']
  )
})

test('wraps Tab and Shift+Tab at both ends and handles entry from outside', () => {
  assert.equal(getNextFocusIndex(0, 3), 1)
  assert.equal(getNextFocusIndex(2, 3), 0)
  assert.equal(getNextFocusIndex(0, 3, true), 2)
  assert.equal(getNextFocusIndex(2, 3, true), 1)
  assert.equal(getNextFocusIndex(-1, 3), 0)
  assert.equal(getNextFocusIndex(-1, 3, true), 2)
  assert.equal(getNextFocusIndex(0, 0), -1)
})

test('body scroll lock restores the original value only after the final release', () => {
  const documentLike = { body: { style: { overflow: 'auto' } } }
  const releaseFirst = acquireBodyScrollLock(documentLike)
  const releaseSecond = acquireBodyScrollLock(documentLike)

  assert.equal(documentLike.body.style.overflow, 'hidden')
  releaseFirst()
  assert.equal(documentLike.body.style.overflow, 'hidden')
  releaseSecond()
  assert.equal(documentLike.body.style.overflow, 'auto')
  releaseSecond()
  assert.equal(documentLike.body.style.overflow, 'auto')
})
