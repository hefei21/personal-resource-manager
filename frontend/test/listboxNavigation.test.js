import test from 'node:test'
import assert from 'node:assert/strict'

import {
  findFirstEnabledIndex,
  findLastEnabledIndex,
  moveListboxActiveIndex
} from '../src/utils/listboxNavigation.js'

const options = [
  { value: 'first', disabled: false },
  { value: 'blocked-a', disabled: true },
  { value: 'middle' },
  { value: 'blocked-b', disabled: true },
  { value: 'last' }
]

test('empty and all-disabled lists have no active option', () => {
  assert.equal(findFirstEnabledIndex([]), -1)
  assert.equal(findLastEnabledIndex([]), -1)
  assert.equal(moveListboxActiveIndex([], -1, 'ArrowDown'), -1)
  assert.equal(moveListboxActiveIndex([{ disabled: true }], 0, 'Home'), -1)
})

test('arrow navigation skips disabled options and clamps at boundaries', () => {
  assert.equal(findFirstEnabledIndex(options), 0)
  assert.equal(findLastEnabledIndex(options), 4)
  assert.equal(moveListboxActiveIndex(options, 0, 'ArrowDown'), 2)
  assert.equal(moveListboxActiveIndex(options, 2, 'ArrowDown'), 4)
  assert.equal(moveListboxActiveIndex(options, 4, 'ArrowDown'), 4)
  assert.equal(moveListboxActiveIndex(options, 4, 'ArrowUp'), 2)
  assert.equal(moveListboxActiveIndex(options, 2, 'ArrowUp'), 0)
  assert.equal(moveListboxActiveIndex(options, 0, 'ArrowUp'), 0)
})

test('Home and End select the first and last enabled options', () => {
  assert.equal(moveListboxActiveIndex(options, 4, 'Home'), 0)
  assert.equal(moveListboxActiveIndex(options, 0, 'End'), 4)
})

test('closed-state opening starts ArrowDown at the first and ArrowUp at the last enabled option', () => {
  // NativeSelect uses -1 as the closed/no-active sentinel before opening.
  assert.equal(moveListboxActiveIndex(options, -1, 'ArrowDown'), 0)
  assert.equal(moveListboxActiveIndex(options, -1, 'ArrowUp'), 4)
})
