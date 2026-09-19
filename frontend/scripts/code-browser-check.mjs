// Synthetic API only: no repository writes, real credentials or production files.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = process.env.CODE_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'code-browser-'))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.CODE_BROWSER_PATH ? { executablePath: process.env.CODE_BROWSER_PATH } : {}) })
const base = process.env.CODE_TEST_URL || 'http://127.0.0.1:5178'
const commit = 'a'.repeat(40), checks = [], errors = [], writes = []
const repos = [{ id: 1, name: '示例 NAS 仓库', type: 'git_nas', readOnly: true }, { id: 2, name: '示例受管仓库', type: 'git', last_sync: '2026-01-01' }]
const source = Array.from({ length: 180 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n// <img src=x onerror=alert(1)>'
let listFailure = false, fileFailure = true, readmeFailure = false, slowRepo = false
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.route('**/api/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname
  if (!path.startsWith('/api/')) return route.continue()
  const json = (data, status = 200) => route.fulfill({ json: data, status })
  if (route.request().method() !== 'GET') writes.push(path)
  if (path === '/api/auth/check') return json({ authenticated: true, user: { username: 'fixture', principal: 'owner', isGuest: false } })
  if (path === '/api/code') {
    const keyword = url.searchParams.get('keyword')
    if (listFailure) return json({ message: '合成连接失败' }, 503)
    if (keyword === 'slow') await new Promise(resolve => setTimeout(resolve, 600))
    return json({ data: keyword === 'slow' ? [repos[0]] : keyword === 'fast' ? [repos[1]] : repos, total: 2 })
  }
  const match = /^\/api\/code\/(\d+)(?:\/(.*))?$/.exec(path)
  if (match) {
    const id = Number(match[1]), kind = match[2]
    if (!kind) return json({ data: repos[id - 1] })
    if (slowRepo && id === 1 && ['tree', 'readme', 'commits'].includes(kind)) await new Promise(resolve => setTimeout(resolve, 600))
    if (kind === 'tree') return json({ data: ['long.js', 'slow.js', 'fast.js', 'broken.js', 'README.md'].map(name => ({ name, path: name, type: 'file' })) })
    if (kind === 'readme') return readmeFailure ? json({ message: '失败' }, 500) : json({ data: { content: `# 仓库 ${id} 说明\n\n安全的合成内容。` } })
    if (kind === 'commits') return json({ data: [] })
    if (kind === 'file') {
      const name = url.searchParams.get('path')
      if (url.searchParams.get('commit') === 'b'.repeat(40)) return json({ code: 'CODE_SNAPSHOT_STALE' }, 409)
      if (name === 'slow.js') await new Promise(resolve => setTimeout(resolve, 600))
      if (name === 'broken.js' && fileFailure) return json({ message: '失败' }, 500)
      return json({ data: { name, path: name, type: 'text', content: name === 'long.js' || name === 'README.md' ? source : `// ${name} repository ${id}`, ...(url.searchParams.has('commit') ? { commit } : {}) } })
    }
  }
  return json({ data: [], total: 0 })
})
const page = await context.newPage()
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') console.error('browser:', message.text()) })
page.on('requestfailed', request => console.error('request:', request.url(), request.failure()?.errorText))
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`) }
const file = name => page.locator('.tree-node-label').filter({ hasText: name })
try {
  await page.goto(`${base}/code`)
  await page.locator('.repo-info').first().waitFor()
  await check('list retains results on failure and latest query wins', async () => {
    listFailure = true
    await page.getByRole('button', { name: '刷新列表', exact: true }).click()
    await page.getByText(/当前保留上次加载的结果/).waitFor()
    assert.equal(await page.locator('.repo-info').count(), 2)
    listFailure = false
    await page.getByRole('button', { name: '重试列表', exact: true }).click()
    await page.getByText(/当前保留上次加载的结果/).waitFor({ state: 'hidden' })
    const search = page.getByPlaceholder('搜索代码仓库...')
    await search.fill('slow'); await search.press('Enter')
    await search.fill('fast'); await search.press('Enter')
    await page.waitForTimeout(800)
    assert.equal(await page.locator('.repo-info').count(), 1)
    assert.match(await page.locator('.repo-info').innerText(), /受管/)
    await search.fill(''); await search.press('Enter')
    await page.waitForFunction(() => document.querySelectorAll('.repo-info').length === 2)
    await page.screenshot({ path: join(output, 'pc-code-list.png') })
  })
  await check('NAS writes absent; keyboard opens repository; latest file wins', async () => {
    assert.equal(await page.locator('.repo-item').first().locator('.repo-actions').count(), 0)
    await page.locator('.repo-info').first().focus(); await page.keyboard.press('Enter')
    await file('slow.js').click(); await file('fast.js').click()
    await page.waitForTimeout(800)
    assert.match(await page.locator('.code-source__text').innerText(), /fast.js repository 1/)
    assert.equal(await page.locator('.browser-header').getByText('删除', { exact: true }).count(), 0)
  })
  await check('failed file hides old body, retries, and closing cancels pending selection', async () => {
    await file('broken.js').click()
    await page.getByText('文件加载失败，请重试', { exact: true }).waitFor()
    assert.equal(await page.locator('.code-source').count(), 0)
    fileFailure = false
    await page.getByRole('button', { name: '重新加载文件' }).click()
    await page.getByText('// broken.js repository 1', { exact: true }).waitFor()
    await file('slow.js').click()
    await page.locator('.file-header button').click()
    await page.waitForTimeout(800)
    assert.equal(await page.locator('.code-source').count(), 0)
    await page.getByText('仓库 1 说明', { exact: true }).waitFor()
  })
  await check('commit-bound deep links highlight and scroll to actual source line safely', async () => {
    await page.goto(`${base}/code?repositoryId=1&path=long.js&line=120&commit=${commit}`)
    const target = page.locator('[data-source-line="120"]')
    await target.waitFor(); await page.waitForTimeout(150)
    assert.match(await target.getAttribute('class'), /active/)
    const bounds = await page.locator('.code-source').boundingBox(), line = await target.boundingBox()
    assert.ok(line.y >= bounds.y && line.y + line.height <= bounds.y + bounds.height, 'citation line must be in the viewport')
    assert.ok(await page.locator('.code-source').evaluate(el => el.scrollTop > 1000))
    assert.equal(await page.locator('.code-source img').count(), 0)
    await page.screenshot({ path: join(output, 'pc-code-line.png') })
    await page.goto(`${base}/code?repositoryId=1&path=README.md&line=120&commit=${commit}`)
    await page.locator('[data-source-line="120"].active').waitFor()
    await page.setViewportSize({width:1024,height:800})
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.goto(`${base}/code?repositoryId=1&path=long.js&line=999&commit=${commit}`)
    await page.getByText('引用行超出当前文件范围，请重新搜索确认位置。', {exact:true}).waitFor()
    assert.equal(await page.locator('[data-source-line].active').count(), 0)
    await page.setViewportSize({width:1440,height:1000})
    await page.goto(`${base}/code?repositoryId=1&path=long.js&line=120&commit=${'b'.repeat(40)}`)
    await page.getByText(/该引用对应的提交已过期/).waitFor()
    assert.equal(await page.locator('.code-source').count(), 0)
  })
  await check('switching repository discards stale requests and refresh reports partial failure', async () => {
    await page.goto(`${base}/code`); await page.locator('.repo-info').first().waitFor()
    slowRepo = true
    await page.locator('.repo-info').first().click()
    await page.getByRole('button', { name: '返回列表' }).click()
    await page.locator('.repo-info').nth(1).click()
    await page.waitForTimeout(800)
    await page.getByText('仓库 2 说明', { exact: true }).waitFor()
    assert.equal(await page.getByText('仓库 1 说明', { exact: true }).count(), 0)
    readmeFailure = true
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByText('README 加载失败', { exact: true }).waitFor()
    await page.getByText('部分内容更新失败，可在对应区域重试', { exact: true }).waitFor()
    readmeFailure = false
    await page.getByRole('button', { name: '重试 README' }).click()
    await page.getByText('仓库 2 说明', { exact: true }).waitFor()
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(writes, [])
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors, writes }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, errors, output }))
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') })
  console.error(errors, (await page.locator('body').innerText()).slice(0, 2500))
  throw error
} finally { await browser.close() }
