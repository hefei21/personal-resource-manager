import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_OWNER_PASSWORD_LENGTH,
  validateOwnerPassword,
  validateOwnerPasswordChange
} from '../src/utils/passwordPolicy.js'

test('owner password policy requires 12 non-weak characters', () => {
  assert.equal(MIN_OWNER_PASSWORD_LENGTH, 12)
  assert.equal(validateOwnerPassword(''), '请输入新密码')
  assert.equal(validateOwnerPassword('            '), '请输入新密码')
  assert.equal(
    validateOwnerPassword('admin123'),
    '新密码必须至少 12 位且不能使用已知弱密码'
  )
  assert.equal(validateOwnerPassword('safe-random-password-123'), '')
  assert.equal(
    validateOwnerPasswordChange('safe-random-password-123', 'safe-random-password-123'),
    '新密码不能与旧密码相同'
  )
})
