// Synthetic task/trash failure and recovery journeys; never contact an Owner backend.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.THEME_TEST_URL || 'http://127.0.0.1:5187'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
const out = process.env.WORKBENCH_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'workbench-browser-'))
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.THEME_BROWSER_PATH ? { executablePath: process.env.THEME_BROWSER_PATH } : {}) })
const results = [], errors = []
try {
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    let taskReads = 0, taskFailure = false, trashFailure = false
    const writes = []
    let items = [1, 2].map(id => ({ key: `document:${id}`, resourceType: 'document', resourceId: id, title: `待恢复文档 ${id}`, canRestore: true, canPermanentlyDelete: true, isExpired: true, deletedAt: '2026-10-01T00:00:00Z', purgeAfter: '2026-10-02T00:00:00Z' }))
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, reducedMotion: 'reduce' })
    await context.route(`${base}/api/**`, async route => {
      const req = route.request(), path = new URL(req.url()).pathname
      let json = { data: [], total: 0 }, status = 200
      if (req.method() !== 'GET') writes.push({ path, method: req.method() })
      if (path === '/api/auth/check') json = { authenticated: true, user: { username: 'fixture', principal: 'owner', isGuest: false } }
      else if (path === '/api/documents/categories') json = { data: [{ id: 1, name: '分类甲' }, { id: 2, name: '分类乙' }] }
      else if (path === '/api/documents') json = { data: [{ id: 1, title: '长标题资料'.repeat(24), fileName: 'fixture.txt', fileType: 'txt', categoryId: 1, version: 1, currentVersion: 1 }], total: 1 }
      else if (path === '/api/tasks') {
        taskReads++
        if (taskFailure) { status = 503; json = { code: 'TASK_QUERY_FAILED' } }
        else json = { data: [{ id: 1, taskType: 'fixture', status: 'running', progress: 42, attemptCount: 1, maxAttempts: 3, timestamps: {} }], total: 1 }
      } else if (path === '/api/trash') {
        if (trashFailure) { status = 503; json = { message: '合成网络失败' } }
        else json = { data: { items, summary: { total: items.length, restorable: items.length, expired: items.length }, pagination: { page: 1, pageSize: 20, total: items.length } } }
      } else if (path === '/api/trash/batch-restore') {
        items = items.filter(x => x.resourceId !== 1)
        json = { data: { summary: { succeeded: 1 }, results: [{ key: 'document:1', success: true }, { key: 'document:2', success: false, message: '合成恢复冲突' }] } }
      } else if (path === '/api/trash/document/1/restore') { items = items.filter(x => x.resourceId !== 1); json = { success: true } }
      await route.fulfill({ status, json })
    })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${base}/documents`)
    await page.getByText('长标题资料'.repeat(24), { exact: true }).first().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, 'long document title overflow')
    if (width > 768) {
      await page.getByRole('button', { name: '上传文档', exact: true }).click()
      let dialog = page.getByRole('dialog', { name: '上传文档', exact: true })
      await dialog.getByRole('combobox', { name: '分类', exact: true }).click()
      await page.getByRole('button', { name: '分类乙', exact: true }).click()
      assert.ok(await dialog.isVisible())
      assert.ok((await dialog.getByRole('combobox', { name: '分类', exact: true }).innerText()).includes('分类乙'))
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('checkbox', { name: '选择第 1 行', exact: true }).click()
      await page.getByRole('button', { name: '编辑信息', exact: true }).click()
      dialog = page.getByRole('dialog', { name: '批量编辑文档', exact: true })
      await dialog.getByRole('combobox', { name: '分类', exact: true }).click()
      await page.getByRole('button', { name: '分类甲', exact: true }).click()
      assert.ok(await dialog.isVisible())
      assert.ok((await dialog.getByRole('combobox', { name: '分类', exact: true }).innerText()).includes('分类甲'))
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    }
    await page.goto(`${base}/tasks`)
    await page.getByRole('progressbar').waitFor()
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '42')
    const initialReads = taskReads
    await page.clock.install()
    await page.clock.fastForward(60000)
    assert.equal(taskReads, initialReads, 'task list must not poll')
    taskFailure = true
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '任务列表加载失败' }).waitFor()
    taskFailure = false
    await page.getByRole('button', { name: '重新加载', exact: true }).first().click()
    await page.getByRole('alert').filter({ hasText: '任务列表加载失败' }).waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('button', { name: '清理历史任务', exact: true }).count(), width > 768 ? 1 : 0)
    await page.goto(`${base}/trash`)
    await page.getByRole('listitem').filter({ hasText: '待恢复文档 1' }).waitFor()
    assert.equal(writes.length, 0, 'expired trash must not delete itself')
    if (width > 768) {
      await page.getByRole('checkbox', { name: '选择本页可恢复条目' }).click()
      await page.getByRole('button', { name: '批量恢复', exact: true }).click()
      await page.getByText('合成恢复冲突', { exact: false }).waitFor()
      assert.equal(await page.getByRole('listitem').filter({ hasText: '待恢复文档 1' }).count(), 0)
      assert.equal(await page.locator('.trash-list').getByRole('listitem').filter({ hasText: '待恢复文档 2' }).count(), 1)
    } else {
      assert.equal(await page.getByRole('button', { name: '永久删除', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '批量恢复', exact: true }).count(), 0)
      await page.getByRole('listitem').filter({ hasText: '待恢复文档 1' }).getByRole('button', { name: '恢复', exact: true }).click()
      await page.getByRole('listitem').filter({ hasText: '待恢复文档 1' }).waitFor({ state: 'hidden' })
    }
    trashFailure = true
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByText('统一回收站暂时不可用', { exact: true }).waitFor()
    assert.equal(await page.getByText('没有符合条件的回收站条目', { exact: true }).count(), 0)
    trashFailure = false
    await page.getByRole('button', { name: '重新加载', exact: true }).click()
    await page.locator('.trash-list').getByRole('listitem').filter({ hasText: '待恢复文档 2' }).waitFor()
    assert.ok(writes.every(w => w.method === 'POST' && w.path.includes('restore')))
    results.push({ width, theme, taskReads, writes, longDocumentTitle: true, documentPortalSelection: width > 768, taskNoPolling: true, recovery: true, failureHonesty: true })
    await context.close()
  }
  assert.deepEqual(errors, [])
} finally {
  await writeFile(join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2))
  await browser.close()
}
console.log(JSON.stringify({ passed: results.length, errors }))
