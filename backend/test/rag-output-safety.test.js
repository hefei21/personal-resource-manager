import assert from 'node:assert/strict'
import test from 'node:test'
import { isSafeRagText } from '../src/services/ragOutputSafety.js'

test('technical concepts are not credential values', () => {
  for (const text of [
    'A user-id/password mismatch differs from a UTF-8 decoding failure.',
    'The server must protect password confidentiality.',
    'Never publish a shared secret or an API key.',
    'Basic authentication and Bearer tokens are different mechanisms.',
    '密码重试不能省略账户校验条件。',
    '未给出 password 的最大长度。',
    'The same secret must not be reused across unrelated services.'
  ]) assert.equal(isSafeRagText(text), true, text)
})

test('credentials and private references remain blocked even in otherwise technical prose', () => {
  for (const text of [
    'password=synthetic-value', '"password": "synthetic-value"',
    '**password**: synthetic-value', 'password is synthetic-value',
    'secret:\nsynthetic-value', 'api_key=synthetic-value',
    'password value is synthetic-value', 'passwords: synthetic-one, synthetic-two',
    'password "synthetic-value"', 'https://synthetic-user:synthetic-value@example.invalid/',
    '密码是测试值', '口令：测试值', '密钥为测试值',
    'ｐａｓｓｗｏｒｄ＝synthetic-value', 'pass\u200bword=synthetic-value',
    'access_token=synthetic-value', 'Bearer synthetic-token',
    'Basic dXNlcjpwYXNz', '-----BEGIN PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.synthetic',
    'C:\\synthetic\\file.txt', '/mnt/synthetic/file.txt',
    '\\\\synthetic-host\\share', 'storage_key: synthetic',
    'lease_token: synthetic', 'snapshotId: 123', 'sha256_hash: synthetic'
  ]) assert.equal(isSafeRagText(`Password validation guidance. ${text}`), false, text)
})
