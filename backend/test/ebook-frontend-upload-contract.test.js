import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.join(testDirectory, '..', '..', 'frontend', 'src')
const pcSource = fs.readFileSync(path.join(frontendRoot, 'components', 'books', 'EbookUploadDialog.vue'), 'utf8')
const mobileSource = fs.readFileSync(path.join(frontendRoot, 'mobile', 'pages', 'BooksMobile.vue'), 'utf8')

test('ebook upload confirmation cannot race metadata parsing on PC or mobile', () => {
  assert.match(pcSource, /:confirm-loading="uploading"/u)
  assert.match(pcSource, /:confirm-disabled="uploading \|\| parsing"/u)
  assert.match(pcSource, /:close-on-overlay-click="!uploading && !parsing"/u)
  assert.match(pcSource, /const parsing = ref\(false\)/u)
  assert.match(pcSource, /const uploading = ref\(false\)/u)
  assert.doesNotMatch(pcSource, /:confirm-btn=/u)

  assert.match(mobileSource, /import EbookUploadDialog from '@\/components\/books\/EbookUploadDialog\.vue'/u)
  assert.match(mobileSource, /<EbookUploadDialog v-model="uploadVisible"/u)
  assert.match(pcSource, /if \(uploading\.value \|\| parsing\.value\) return/u)
})
