import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRepositoryLink } from '../src/utils/repositoryNavigation.js'

test('repository links resolve root, siblings, fragments and encoded filenames', () => {
  assert.deepEqual(resolveRepositoryLink('../guide.md#intro', 'docs/README.md'), { path: 'guide.md', anchor: 'intro', sameFile: false })
  assert.deepEqual(resolveRepositoryLink('#说明', 'docs/readme.md'), { path: 'docs/readme.md', anchor: '说明', sameFile: true })
  assert.equal(resolveRepositoryLink('./使用%20说明.md', 'docs/readme.md').path, 'docs/使用 说明.md')
  assert.equal(resolveRepositoryLink('/src/main.js', 'docs/readme.md').path, 'src/main.js')
})
test('repository links reject escaping roots, schemes and malformed encoding', () => {
  for (const href of ['../../secret', '../%2e%2e/secret', 'javascript:alert(1)', 'file:///private', '//other.test/file', 'C:/private', '%', 'x%5cy', '%00secret']) assert.equal(resolveRepositoryLink(href, 'docs/README.md'), null)
})
