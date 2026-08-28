import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isReadOnlyRepository,
  repositorySourceLabel
} from '../src/utils/codeRepositoryCapabilities.js'

test('NAS Git capability is derived from the public flag with a type fallback', () => {
  assert.equal(isReadOnlyRepository({ readOnly: true, type: 'git' }), true)
  assert.equal(isReadOnlyRepository({ type: 'git_nas' }), true)
  assert.equal(isReadOnlyRepository({ readOnly: false, type: 'git' }), false)
  assert.equal(isReadOnlyRepository(null), false)
})

test('repository source labels do not confuse NAS discovery with clone state', () => {
  assert.equal(repositorySourceLabel({ type: 'git_nas' }), 'NAS 只读 Git')
  assert.equal(repositorySourceLabel({ type: 'git' }), '受管 Git')
})
