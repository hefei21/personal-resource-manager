export const MIN_OWNER_PASSWORD_LENGTH = 12

const KNOWN_WEAK_PASSWORDS = new Set([
  '123456',
  'admin123',
  'password',
  'change-this-password',
  'replace-with-a-random-password'
])

export function validateOwnerPassword(password) {
  if (typeof password !== 'string' || password.trim().length === 0) return '请输入新密码'
  if (
    password.length < MIN_OWNER_PASSWORD_LENGTH ||
    KNOWN_WEAK_PASSWORDS.has(password.toLowerCase())
  ) {
    return '新密码必须至少 12 位且不能使用已知弱密码'
  }
  return ''
}

export function validateOwnerPasswordChange(oldPassword, newPassword) {
  const policyError = validateOwnerPassword(newPassword)
  if (policyError) return policyError
  if (oldPassword === newPassword) return '新密码不能与旧密码相同'
  return ''
}
