import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(testDirectory, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8')
}

test('PDF preview uses one pinned local PDF.js runtime on PC and mobile', () => {
  const packageJson = JSON.parse(read('package.json'))
  const runtimeSource = read('src/utils/pdfPreview.js')
  const desktopPageSource = read('src/pc/pages/DocumentsPC.vue')
  const desktopPreviewSource = read('src/pc/components/documents/DocumentPreviewDialog.vue')
  const mobileSource = read('src/mobile/pages/DocumentsMobile.vue')

  assert.equal(packageJson.dependencies['pdfjs-dist'], '6.2.108')
  assert.match(runtimeSource, /import\('pdfjs-dist'\)/u)
  assert.match(runtimeSource, /pdf\.worker\.min\.mjs\?url/u)
  assert.match(desktopPreviewSource, /openPdfDocument/u)
  assert.match(mobileSource, /openPdfDocument/u)
  assert.match(desktopPreviewSource, /const pdfDocument = shallowRef\(null\)/u)
  assert.match(mobileSource, /const pdfDoc = shallowRef\(null\)/u)
  assert.match(desktopPageSource, /\/api\/documents\/download\/\$\{row\.id\}/u)
  assert.match(desktopPreviewSource, /\/api\/documents\/preview\/\$\{row\.id\}/u)
  assert.match(mobileSource, /\/api\/documents\/download\/\$\{doc\.id\}/u)
  assert.doesNotMatch(mobileSource, /content\?download=1/u)
  for (const source of [runtimeSource, desktopPageSource, desktopPreviewSource, mobileSource]) {
    assert.doesNotMatch(source, /cdnjs|jsdelivr|window\.pdfjsLib/u)
  }
})

test('PDF.js CMaps, standard fonts, WASM and ICC assets are served locally', () => {
  const runtimeSource = read('src/utils/pdfPreview.js')
  const viteSource = read('vite.config.js')
  const nginxSource = read('nginx.conf')

  assert.match(runtimeSource, /cMapUrl:[\s\S]*cMapPacked: true/u)
  assert.match(runtimeSource, /standardFontDataUrl:/u)
  assert.match(runtimeSource, /wasmUrl:/u)
  assert.match(runtimeSource, /iccUrl:/u)
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    assert.match(viteSource, new RegExp(`['\"]${directory}['\"]`, 'u'))
    assert.match(viteSource, new RegExp(`pdfjs/\\$\\{directory\\}`, 'u'))
  }
  assert.match(nginxSource, /location ~\* \\.mjs\$/u)
  assert.match(nginxSource, /default_type application\/javascript/u)
  assert.match(nginxSource, /wasm\|bcmap\|icc\|pfb/u)
})
