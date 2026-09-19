// Synthetic owner data only. All API writes are intercepted; external URLs are never fetched.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = process.env.BOOKMARK_TEST_OUTPUT
if (!output) throw new Error('BOOKMARK_TEST_OUTPUT is required')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BOOKMARK_BROWSER_PATH
    ? { executablePath: process.env.BOOKMARK_BROWSER_PATH }
    : {}),
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
})
const base = process.env.BOOKMARK_TEST_URL || 'http://127.0.0.1:5183'
let items = Array.from({ length: 31 }, (_, i) => ({
  id: i + 1,
  title:
    ['设计资料库', '开发文档', '个人 NAS', '在线工具箱'][i % 4] + ' ' + (i + 1),
  url: 'https://site' + i + '.example/',
  category: i % 2 ? '开发' : '日常',
  tags: i % 2 ? ['开发'] : ['常用'],
  description: '随时打开的日常工具，保留自己的使用备注。',
  version: 'v0',
  icon_data: null,
}))
let listFail = false,
  saveFail = false,
  slow = false,
  nextId = 32,
  checks = [],
  errors = [],
  writes = [],
  external = [],
  inspection = null,
  importRequests = 0
await context.route('**/*', async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname,
    method = req.method()
  if (url.origin !== base) {
    external.push(req.url())
    return route.abort()
  }
  if (!path.startsWith('/api/')) return route.continue()
  const json = (data, status = 200) => route.fulfill({ json: data, status })
  if (path === '/api/auth/check')
    return json({
      authenticated: true,
      user: { id: 1, username: 'fixture', principal: 'owner', isGuest: false },
    })
  if (method !== 'GET') writes.push(path)
  if (path === '/api/bookmarks/metadata')
    return json({
      data: {
        categories: [
          { name: '开发', count: 15 },
          { name: '日常', count: 16 },
        ],
        tags: [
          { name: '开发', count: 15 },
          { name: '常用', count: 16 },
        ],
        total: items.length,
      },
    })
  if (path === '/api/bookmarks' && method === 'GET') {
    if (listFail) return json({ message: '合成列表故障' }, 503)
    const q = url.searchParams.get('keyword') || '',
      p = Number(url.searchParams.get('page') || 1),
      s = Number(url.searchParams.get('pageSize') || 24)
    const found = items.filter(
      (i) =>
        [i.title, i.url, i.description].some((v) => v.includes(q)) &&
        (!url.searchParams.get('category') ||
          i.category === url.searchParams.get('category')) &&
        (!url.searchParams.get('tag') ||
          i.tags.includes(url.searchParams.get('tag'))),
    )
    if (q === '慢请求') await new Promise((r) => setTimeout(r, 450))
    return json({
      data: found.slice((p - 1) * s, p * s),
      total: found.length,
      page: p,
      pageSize: s,
    })
  }
  if (path === '/api/bookmarks/export')
    return json({
      data: { format: 'pr-manager-bookmarks-v1', bookmarks: items },
    })
  if (path === '/api/bookmarks/import-preview')
    return json({
      data: [
        {
          index: 0,
          form: {
            title: '导入的新网站',
            url: 'https://import.example/',
            tags: [],
          },
          duplicate: false,
        },
        { index: 1, form: items[0], duplicate: true },
        { index: 2, error: '仅支持 HTTP/HTTPS' },
      ],
    })
  if (path === '/api/bookmarks/import') {
    importRequests++
    const input = req.postDataJSON().items
    for (const value of input)
      items.unshift({
        ...value,
        id: nextId++,
        version: 'v0',
        category: '',
        description: '',
      })
    return json({ data: { imported: input.length, skipped: 0 } })
  }
  if (path === '/api/bookmarks/batch-delete') {
    const ids = req.postDataJSON().ids
    items = items.filter((i) => !ids.includes(i.id))
    return json({ data: { count: ids.length } })
  }
  const inspect = path.match(/^\/api\/bookmarks\/(\d+)\/(inspect|inspection)$/)
  if (inspect) {
    if (method === 'POST') {
      inspection = { taskId: 1, status: 'pending' }
      return json({ data: inspection })
    }
    return json({ data: inspection })
  }
  const match = path.match(/^\/api\/bookmarks\/(\d+)$/)
  if (match) {
    const item = items.find((i) => i.id === Number(match[1]))
    if (!item) return json({ message: '书签不存在' }, 404)
    if (method === 'GET') {
      if (slow) await new Promise((r) => setTimeout(r, 400))
      return json({ data: item })
    }
    if (method === 'DELETE') {
      items = items.filter((i) => i !== item)
      return json({ data: { count: 1 } })
    }
    if (method === 'PUT') {
      if (saveFail) return json({ message: '合成保存故障' }, 503)
      const body = req.postDataJSON()
      if (body.baseVersion !== item.version)
        return json(
          { message: '书签已在其他位置修改，本机输入已保留', current: item },
          409,
        )
      Object.assign(item, body, {
        version: 'v' + Date.now(),
        icon_data: body.iconData,
      })
      return json({ data: item })
    }
  }
  if (path === '/api/bookmarks' && method === 'POST') {
    const body = req.postDataJSON()
    const dup = items.find((i) => i.url === body.url)
    if (dup && !body.allowDuplicate)
      return json({ message: '已有相同链接', duplicates: [dup] }, 409)
    const item = { ...body, id: nextId++, version: 'v0', icon_data: null }
    items.unshift(item)
    return json({ data: item })
  }
  return json({ data: [], total: 0, success: true })
})
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(e.message))
page.on('dialog', (d) => d.accept())
const check = async (name, fn) => {
  await fn()
  checks.push(name)
  console.log('PASS ' + name)
}
const editor = () => page.locator('.bookmark-editor')
const closeDrawer = () => page.locator('.native-drawer__close').click()
try {
  await page.goto(base + '/bookmarks')
  await page.locator('.bookmark-card').first().waitFor()
  await page.waitForTimeout(500)
  await check(
    'compact direct links, no default selection, no external icon requests',
    async () => {
      assert.equal(await page.locator('.bookmark-card').count(), 24)
      assert.equal(await page.locator('.selection-indicator').count(), 0)
      const anchor = page.locator('.bookmark-card-link').first()
      assert.equal(await anchor.getAttribute('target'), '_blank')
      assert.equal(await anchor.getAttribute('rel'), 'noopener noreferrer')
      assert.equal(external.length, 0)
      await page.screenshot({ path: join(output, 'pc-bookmarks.png') })
    },
  )
  await check(
    'category and tag dropdowns filter real selection and persist URL',
    async () => {
      await page.getByRole('combobox', { name: '分类', exact: true }).click()
      await page.getByRole('option', { name: '开发 · 15', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.bookmark-card').length === 15,
      )
      assert.ok(page.url().includes('category='))
      await page.getByRole('combobox', { name: '分类', exact: true }).click()
      await page.getByRole('option', { name: '全部分类', exact: true }).click()
      await page.getByRole('combobox', { name: '标签', exact: true }).click()
      await page.getByRole('option', { name: '常用', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.bookmark-card').length === 16,
      )
      await page.getByRole('combobox', { name: '标签', exact: true }).click()
      await page.getByRole('option', { name: '全部标签', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.bookmark-card').length === 24,
      )
    },
  )
  await check(
    'explicit selection and select-all stay within current page',
    async () => {
      await page
        .getByRole('button', { name: '整理与迁移', exact: false })
        .click()
      await page.getByRole('button', { name: '多选整理', exact: true }).click()
      await page.getByText('全选本页', { exact: true }).click()
      assert.equal(await page.locator('.bookmark-card.selected').count(), 24)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(await page.locator('.selection-indicator').count(), 0)
    },
  )
  await check(
    'pagination and failed refresh preserve existing cards; retry works',
    async () => {
      await page.getByRole('button', { name: '下一页', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.bookmark-card').length === 7,
      )
      listFail = true
      await page.getByRole('button', { name: '上一页', exact: true }).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.locator('.bookmark-card').count(), 7)
      listFail = false
      await page.getByRole('button', { name: '重试', exact: true }).click()
      await page.getByRole('alert').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '上一页', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.bookmark-card').length === 24,
      )
    },
  )
  await check(
    'detail and editor share metadata; failed save preserves inputs',
    async () => {
      await page.locator('.bookmark-more').first().click()
      await page.locator('.bookmark-detail h2').waitFor()
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await editor().getByLabel('名称', { exact: true }).fill('我的工具入口')
      saveFail = true
      await editor().getByRole('button', { name: '保存', exact: true }).click()
      await page
        .getByRole('alert')
        .filter({ hasText: '合成保存故障' })
        .waitFor()
      assert.equal(
        await editor().getByLabel('名称', { exact: true }).inputValue(),
        '我的工具入口',
      )
      saveFail = false
      await editor().getByRole('button', { name: '保存', exact: true }).click()
      await editor().waitFor({ state: 'hidden' })
      assert.equal(items[0].title, '我的工具入口')
    },
  )
  await check('duplicate URL requires explicit keep-both consent', async () => {
    const count = items.length
    await page.getByRole('button', { name: '添加书签', exact: true }).click()
    await editor().getByLabel('链接', { exact: true }).fill(items[0].url)
    await editor().getByLabel('名称', { exact: true }).fill('独立入口')
    await editor().getByRole('button', { name: '保存', exact: true }).click()
    await page
      .getByRole('button', { name: '仍保存为独立书签', exact: true })
      .click()
    await editor().waitFor({ state: 'hidden' })
    assert.equal(items.length, count + 1)
  })
  await check(
    'concurrent edit never overwrites server; copy is explicit',
    async () => {
      await page.locator('.bookmark-more').first().click()
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await editor().getByLabel('备注', { exact: true }).fill('本机保留的备注')
      const server = items[0]
      server.version = 'newer'
      server.description = '另一端内容'
      await editor().getByRole('button', { name: '保存', exact: true }).click()
      await page
        .getByRole('button', { name: '本机修改另存书签', exact: true })
        .waitFor()
      assert.equal(server.description, '另一端内容')
      await page
        .getByRole('button', { name: '本机修改另存书签', exact: true })
        .click()
      await editor().waitFor({ state: 'hidden' })
      assert.ok(items.some((i) => i.description === '本机保留的备注'))
    },
  )
  await check(
    'explicit durable inspection does not overwrite fields until reviewed and saved',
    async () => {
      await page.locator('.bookmark-more').first().click()
      await page
        .getByRole('button', { name: '获取网站信息', exact: true })
        .click()
      await page
        .getByText('任务处理中，可稍后刷新状态', { exact: true })
        .waitFor()
      inspection = {
        taskId: 1,
        status: 'succeeded',
        result: {
          title: '网站建议名称',
          description: '建议备注',
          status: 'reachable',
          checkedAt: '2026-09-20T01:00:00Z',
        },
      }
      await page.getByRole('button', { name: '刷新状态', exact: true }).click()
      await page.getByText('可以访问', { exact: true }).waitFor()
      assert.notEqual(items[0].title, '网站建议名称')
      await page
        .getByRole('button', { name: '带入编辑，确认后保存', exact: true })
        .click()
      assert.equal(
        await editor().getByLabel('名称', { exact: true }).inputValue(),
        '网站建议名称',
      )
      await editor().getByRole('button', { name: '保存', exact: true }).click()
      await editor().waitFor({ state: 'hidden' })
    },
  )
  await check(
    'HTML import previews duplicates/invalid rows before any write',
    async () => {
      await page
        .getByRole('button', { name: '整理与迁移', exact: false })
        .click()
      await page.getByRole('button', { name: '导入书签', exact: true }).click()
      await page
        .getByLabel('选择书签文件')
        .setInputFiles({
          name: 'bookmarks.html',
          mimeType: 'text/html',
          buffer: Buffer.from(
            '<DL><DT><A HREF="https://import.example/">新入口</A></DL>',
          ),
        })
      await page
        .getByRole('button', { name: '确认导入 1 条', exact: true })
        .waitFor()
      assert.equal(importRequests, 0)
      assert.equal(
        await page.locator('.bookmark-import-list input:disabled').count(),
        2,
      )
      await page
        .getByRole('button', { name: '确认导入 1 条', exact: true })
        .click()
      await page.locator('.bookmark-import').waitFor({ state: 'hidden' })
      assert.equal(importRequests, 1)
    },
  )
  await check('export is an explicit downloadable HTML artifact', async () => {
    await page.getByRole('button', { name: '整理与迁移', exact: false }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出 HTML', exact: true }).click()
    assert.equal((await download).suggestedFilename(), 'bookmarks.html')
  })
  await check('search latest response wins', async () => {
    await page.getByLabel('搜索书签').fill('慢请求')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByLabel('搜索书签').fill('导入的新网站')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.bookmark-card').length === 1,
    )
    await page.waitForTimeout(550)
    assert.equal(
      await page.locator('.bookmark-card strong').innerText(),
      '导入的新网站',
    )
    await page.getByLabel('搜索书签').fill('')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
  })
  await check(
    'mobile compact cards, safe actions and 320/390/768 layout',
    async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(base + '/bookmarks')
      await page.locator('.bookmark-card').first().waitFor()
      await page.waitForTimeout(600)
      assert.equal(
        await page
          .getByRole('button', { name: '整理与迁移', exact: false })
          .count(),
        0,
      )
      await page.screenshot({ path: join(output, 'mobile-bookmarks.png') })
      await page.locator('.bookmark-more').first().click()
      assert.equal(
        await page
          .getByRole('button', { name: '获取网站信息', exact: true })
          .count(),
        0,
      )
      await page.waitForTimeout(350)
      await page.screenshot({
        path: join(output, 'mobile-bookmark-detail.png'),
      })
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await editor().waitFor()
      assert.ok(
        (
          await editor()
            .getByRole('button', { name: '保存', exact: true })
            .boundingBox()
        ).height >= 44,
      )
      await page.waitForTimeout(350)
      await page.screenshot({
        path: join(output, 'mobile-bookmark-editor.png'),
      })
      await editor().getByRole('button', { name: '取消', exact: true }).click()
      for (const width of [320, 768]) {
        await page.setViewportSize({ width, height: 844 })
        await page.waitForTimeout(200)
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        )
      }
    },
  )
  await check(
    'mobile next batch, reversible single deletion and reduced motion',
    async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(base + '/bookmarks')
      await page.locator('.bookmark-card').first().waitFor()
      await page
        .getByRole('button', { name: '加载下一批', exact: true })
        .click()
      await page.waitForFunction(
        () => document.querySelectorAll('.bookmark-card').length > 24,
      )
      const count = items.length
      await page.locator('.bookmark-more').first().click()
      await page
        .getByRole('button', { name: '移入回收站', exact: true })
        .click()
      await page.locator('.bookmark-detail').waitFor({ state: 'hidden' })
      assert.equal(items.length, count - 1)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.ok(
        await page
          .locator('.bookmark-card')
          .first()
          .evaluate((el) =>
            getComputedStyle(el)
              .transitionDuration.split(',')
              .every((v) => parseFloat(v) <= 0.001),
          ),
      )
    },
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ checks, errors, external, writes }, null, 2),
  )
  console.log(JSON.stringify({ passed: checks.length, errors, external }))
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') })
  throw error
} finally {
  await browser.close()
}
