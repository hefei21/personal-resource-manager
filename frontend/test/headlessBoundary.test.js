import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const frontendRoot = new URL('..', import.meta.url)
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

function read(relativePath) {
  return readFileSync(new URL(relativePath, frontendRoot), 'utf8')
}

function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? collectSourceFiles(path) : [path]
  })
}

test('reka-ui stays behind Native component wrappers', () => {
  const directImports = collectSourceFiles(sourceRoot)
    .filter(path => ['.js', '.vue'].includes(extname(path)))
    .filter(path => /from\s+['"]reka-ui['"]/.test(readFileSync(path, 'utf8')))
    .map(path => relative(sourceRoot, path).replaceAll('\\', '/'))

  assert.deepEqual(directImports, [
    'components/native/NativeDialog.vue',
    'components/native/NativeSelect.vue'
  ])
})

test('NativeDialog preserves legacy close and footer compatibility props', () => {
  const source = read('src/components/native/NativeDialog.vue')

  for (const prop of [
    'closeOnOverlayClick',
    'closeOnEsc',
    'closeOnEscKeydown',
    'destroyOnClose',
    'body',
    'showClose',
    'confirmBtn',
    'showFooter',
    'zIndex'
  ]) {
    assert.match(source, new RegExp(`\\b${prop}\\b`), `missing compatibility prop: ${prop}`)
  }

  assert.match(source, /defineEmits\(\['update:modelValue', 'close', 'confirm', 'cancel', 'closed'\]\)/)
  assert.match(source, /value !== false && value !== 'false'/)
  assert.match(source, /@click="handleOverlayClick"/)
})

test('native controls keep platform keyboard semantics and recursive component identity', () => {
  const button = read('src/components/native/NativeButton.vue')
  const select = read('src/components/native/NativeSelect.vue')
  const treeNode = read('src/components/native/NativeTreeNode.vue')
  const treeNode2 = read('src/components/native/NativeTreeNode2.vue')

  assert.doesNotMatch(button, /@keydown\.(?:enter|space)/)
  assert.match(select, /props\.modelValue !== ''/)
  assert.match(treeNode, /<NativeTreeNode\b/)
  assert.match(treeNode2, /<NativeTreeNode2\b/)
  assert.doesNotMatch(treeNode, /<TreeNode\b/)
  assert.doesNotMatch(treeNode2, /<TreeNode\b/)
  assert.match(select, /const useRekaSelect = computed\(\(\) => !props\.filterable && !props\.multiple\)/)
  assert.match(select, /native-select-option-/)
  assert.match(select, /:body-lock="false"/)
})
