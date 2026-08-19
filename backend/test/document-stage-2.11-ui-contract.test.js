import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(testDirectory, '..', '..')
const readFrontend = (...segments) => fs.readFileSync(path.join(projectRoot, 'frontend', 'src', ...segments), 'utf8')
const apiSource = readFrontend('api', 'index.js')
const pcSource = readFrontend('pc', 'pages', 'DocumentsPC.vue')
const mobileSource = readFrontend('mobile', 'pages', 'DocumentsMobile.vue')

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}`)
  assert.notEqual(start, -1, `expected ${name} to be defined`)
  let depth = 0
  let opened = false
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1
      opened = true
    } else if (source[index] === '}') {
      depth -= 1
      if (opened && depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`could not find the end of ${name}`)
}

test('document API exposes the version trash lifecycle routes', () => {
  assert.match(apiSource, /versionsTrash: \(id\) => api\.get\(`\/documents\/\$\{id\}\/versions\/trash`\)/u)
  assert.match(apiSource, /deleteVersion: \(id, versionId\) => api\.delete\(`\/documents\/\$\{id\}\/versions\/\$\{versionId\}`\)/u)
  assert.match(apiSource, /restoreVersionTrash: \(id, versionId\) => api\.post\(`\/documents\/\$\{id\}\/versions\/\$\{versionId\}\/trash\/restore`\)/u)
})

test('PC and mobile document upload UIs expose the same explicit conflict choices', () => {
  for (const source of [pcSource, mobileSource]) {
    const uploadDialogStart = source.indexOf('title="上传文档"')
    const uploadDialogEnd = source.indexOf('<!-- 上传冲突对话框', uploadDialogStart)
    assert.notEqual(uploadDialogStart, -1)
    assert.notEqual(uploadDialogEnd, -1)
    const uploadDialog = source.slice(uploadDialogStart, uploadDialogEnd)
    assert.match(source, /DOCUMENT_UPLOAD_CONFLICT/u)
    assert.match(source, /formData\.append\('resolution', 'create'\)/u)
    assert.match(source, /formData\.append\('resolution', 'new_version'\)/u)
    assert.match(source, /formData\.append\('targetDocumentId', String\(targetDocumentId\)\)/u)
    assert.match(source, /submitUpload\(\{ resolution: 'create', title: suggestedTitle \}\)/u)
    assert.match(source, /submitUpload\(\{ resolution: 'new_version', targetDocumentId: candidate\.id \}\)/u)
    assert.match(source, /candidate\.title/u)
    assert.match(source, /candidate\.categoryPath \|\| '未分类'/u)
    assert.match(source, /candidate\.currentVersion/u)
    assert.match(source, /candidate\.updatedAt/u)
    assert.match(source, /candidate\.contentBytes/u)
    assert.match(source, /candidate\.hashMatches/u)
    assert.match(source, /:disabled="candidate\.hashMatches \|\| uploading"/u)
    assert.match(source, /使用建议标题另建/u)
    assert.match(source, /选择候选作为新版本/u)
    assert.match(source, /@click="cancelUploadConflict"/u)
    assert.match(uploadDialog, /:confirm-loading="uploading"/u)
    assert.match(uploadDialog, /:confirm-disabled="uploading \|\| !canWrite"/u)
    assert.doesNotMatch(uploadDialog, /:confirm-btn=/u)

    const cancel = functionSource(source, 'cancelUploadConflict')
    assert.doesNotMatch(cancel, /api\.documents\.upload/u)
  }
})

test('PC content editing delegates version numbers and keeps only a read-only current version', () => {
  assert.doesNotMatch(pcSource, /\bnewVersion\b/u)
  assert.match(pcSource, /当前版本/u)
  assert.match(pcSource, /versionNote: editForm\.value\.versionNote/u)
})

test('both document UIs protect current versions and expose version trash recovery', () => {
  assert.match(pcSource, /<template v-if="!row\.isCurrent">/u)
  assert.match(mobileSource, /<template v-if="!ver\.isCurrent">/u)
  assert.match(pcSource, /row\?\.isCurrent/u)
  assert.match(mobileSource, /ver\?\.isCurrent/u)

  for (const source of [pcSource, mobileSource]) {
    assert.match(source, /api\.documents\.versionsTrash\(/u)
    assert.match(source, /api\.documents\.deleteVersion\(/u)
    assert.match(source, /api\.documents\.restoreVersionTrash\(/u)
    assert.match(source, /移入版本回收站/u)
    assert.match(source, /版本回收站/u)
  }
})

test('mobile restore confirmation has no post-success error-path reference and upload errors keep backend messages', () => {
  const confirmRestore = functionSource(mobileSource, 'confirmRestoreVersion')
  assert.match(confirmRestore, /if \(!restored\) return/u)
  assert.doesNotMatch(confirmRestore, /\berror\b/u)
  assert.match(pcSource, /documentErrorMessage\(error, '上传失败'\)/u)
  assert.match(mobileSource, /documentErrorMessage\(error, '上传失败'\)/u)
})
