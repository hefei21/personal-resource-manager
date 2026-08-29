import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const readFrontend = (relativePath) => fs.readFileSync(path.join(repositoryRoot, 'frontend', relativePath), 'utf8')

test('exposes one shared Owner search route in PC and mobile navigation', () => {
  const router = readFrontend('src/router/index.js')
  const navigation = readFrontend('src/router/navigation.js')
  const desktop = readFrontend('src/pc/layout/Layout.vue')
  const mobile = readFrontend('src/mobile/layout/Layout.vue')
  assert.match(router, /path:\s*'search'[\s\S]*name:\s*'Search'[\s\S]*views\/Search\.vue/u)
  assert.match(navigation, /routeName:\s*'Search'[\s\S]*?value:\s*'search'[\s\S]*?label:\s*'统一搜索'[\s\S]*?mobile:\s*true/u)
  assert.match(desktop, /navigationItemsForGroup[\s\S]*menuSections/u)
  assert.match(mobile, /MOBILE_BOTTOM_NAVIGATION/u)
  assert.match(mobile, /navigationItemsForGroup\(item\.group,\s*\{\s*mobile:\s*true\s*\}\)/u)
})

test('search UI preserves the Stage 6A scope, feedback, and safe locator contract', () => {
  const source = readFrontend('src/views/Search.vue')
  for (const text of [
    '我的资源', '外部发现', '综合结果', '仅元数据', 'PC Worker 离线',
    'SEARCH_INDEX_MISSING', '完整重建', 'includeCodeFiles', 'locator.line', 'chapterIndex'
  ]) assert.match(source, new RegExp(text, 'u'))
  assert.match(source, /api\.search\.global/u)
  assert.match(source, /api\.search\.refreshIndex/u)
  assert.match(source, /api\.tasks\.get/u)
  assert.doesNotMatch(source, /v-html/u)
  assert.doesNotMatch(source, /bookSearch|anime\.searchResources|fetch\s*\(/u)
})

test('frontend API and task presentation expose only the controlled search endpoints and task type', () => {
  const api = readFrontend('src/api/index.js')
  const tasks = readFrontend('src/views/Tasks.vue')
  const presentation = readFrontend('src/domain/taskPresentation.js')
  assert.match(api, /global:\s*\(params\)\s*=>\s*api\.get\('\/search'/u)
  assert.match(api, /status:\s*\(\)\s*=>\s*api\.get\('\/search\/status'/u)
  assert.match(api, /refreshIndex:[\s\S]*api\.post\('\/search\/index\/refresh'/u)
  assert.match(presentation, /search\.index\.refresh/u)
  assert.match(presentation, /统一搜索索引刷新/u)
  assert.match(tasks, /taskSourcePresentation/u)
})

test('resource pages consume public search locators on both layouts', () => {
  const targets = [
    ['src/pc/pages/DocumentsPC.vue', /route\.query\.documentId/u],
    ['src/mobile/pages/DocumentsMobile.vue', /route\.query\.documentId/u],
    ['src/pc/pages/BooksPC.vue', /route\.query\.bookId[\s\S]*searchChapterIndex/u],
    ['src/mobile/pages/BooksMobile.vue', /route\.query\.bookId[\s\S]*searchChapterIndex/u],
    ['src/mobile/components/BookReader.vue', /props\.book\.searchChapterIndex/u],
    ['src/pc/pages/CodePC.vue', /route\.query\.repositoryId[\s\S]*loadFile\(route\.query\.path/u],
    ['src/mobile/pages/CodeMobile.vue', /route\.query\.repositoryId[\s\S]*previewFile/u],
    ['src/pc/pages/BlogPC.vue', /route\.query\.postId/u],
    ['src/mobile/pages/BlogMobile.vue', /route\.query\.postId/u]
  ]
  for (const [relativePath, pattern] of targets) assert.match(readFrontend(relativePath), pattern)
})
