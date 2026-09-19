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
let searchFailure = false, taskScenario = false, taskFailure = false, taskComplete = false, treeFailure = false
let commitFailure = false
const taskCalls = new Map(), searchCalls = []
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.route('**/api/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname
  if (!path.startsWith('/api/')) return route.continue()
  const json = (data, status = 200) => route.fulfill({ json: data, status })
  if (route.request().method() !== 'GET') writes.push(path)
  if (path === '/api/code' && route.request().method() === 'POST') {
    await new Promise(resolve => setTimeout(resolve, 250))
    repos.push({ ...route.request().postDataJSON(), id: 4, readOnly: false })
    return json({ id: 4, taskId: 40 }, 202)
  }
  if (path === '/api/code/4' && route.request().method() === 'PUT') {
    Object.assign(repos.find(repo => repo.id === 4), route.request().postDataJSON())
    return json({ success: true })
  }
  if (path === '/api/code/4' && route.request().method() === 'DELETE') {
    repos.splice(repos.findIndex(repo => repo.id === 4), 1)
    return json({ success: true })
  }
  if (path === '/api/auth/check') return json({ authenticated: true, user: { username: 'fixture', principal: 'owner', isGuest: false } })
  if (path === '/api/code') {
    const keyword = url.searchParams.get('keyword')
    if (listFailure) return json({ message: '合成连接失败' }, 503)
    if (keyword === 'slow') await new Promise(resolve => setTimeout(resolve, 600))
    return json({ data: taskScenario ? [...repos, { id: 3, name: '第二受管仓库', type: 'git', last_sync: '2026-01-01' }] : keyword === 'slow' ? [repos[0]] : keyword === 'fast' ? [repos[1]] : repos, total: 2 })
  }
  if (path === '/api/search') {
    searchCalls.push(Object.fromEntries(url.searchParams))
    if (searchFailure) return json({ code: 'SEARCH_UNAVAILABLE' }, 500)
    const q = url.searchParams.get('q'), offset = Number(url.searchParams.get('offset'))
    if (q === 'slow') await new Promise(resolve => setTimeout(resolve, 600))
    const total = q === 'empty' ? 0 : 23
    return json({ total, data: Array.from({ length: Math.min(20, Math.max(0, total - offset)) }, (_, index) => ({ entryKey: `result-${offset + index}`, title: `${q} 匹配 ${offset + index + 1}`, snippet: '安全的合成检索内容', locator: { repositoryId: Number(url.searchParams.get('repositoryId')), path: 'long.js', line: 120, ...(url.searchParams.get('mode') === 'symbol' ? { commit } : {}) } })), index: { symbols: { status: 'ready' } } })
  }
  const match = /^\/api\/code\/(\d+)(?:\/(.*))?$/.exec(path)
  if (match) {
    const id = Number(match[1]), kind = match[2]
    if (kind === 'clone-status' || kind === 'sync-status') {
      taskCalls.set(`${id}:${kind}`, (taskCalls.get(`${id}:${kind}`) || 0) + 1)
      if (!taskScenario || kind === 'clone-status') return json({ status: 'unknown' })
      if (taskFailure && id === 3) return json({ code: 'UNAVAILABLE' }, 503)
      return json({ data: id === 2 ? { taskId: 20, status: 'failed', code: 'REPOSITORY_DIRTY', startTime: 100 } : { taskId: 30, status: taskComplete ? 'completed' : 'syncing', progress: 35, startTime: 100 } })
    }
    if (!kind) return json({ data: repos.find(repo => repo.id === id) })
    if (slowRepo && id === 1 && ['tree', 'readme', 'commits'].includes(kind)) await new Promise(resolve => setTimeout(resolve, 600))
    if (kind === 'tree') return treeFailure ? json({ message: '失败' }, 500) : json({ data: ['long.js', 'slow.js', 'fast.js', 'broken.js', 'README.md'].map(name => ({ name, path: name, type: 'file' })) })
    if (kind === 'readme') return readmeFailure ? json({ message: '失败' }, 500) : json({ data: { content: `# 仓库 ${id} 说明\n\n安全的合成内容。\n\n[打开源码](./fast.js)` } })
    if (kind === 'commits') return json({ data: [{ hash: '1234567', message: '合成变更记录', author: '测试作者', date: '2026-01-01' }] })
    if (kind?.startsWith('commit/')) return commitFailure ? json({ code: 'UNAVAILABLE' }, 503) : json({ data: { hash: '1234567', files: [{ file: 'fast.js', changes: 1 }], diff: '@@ -1 +1 @@\n-old value\n+new value' } })
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
  slowRepo = false
  await check('repository search scopes, pages, restores history and opens commit line', async () => {
    await page.goto(`${base}/code?repositoryId=1&tab=search`)
    await page.getByLabel('仓库内关键词').fill('symbol')
    await page.getByRole('combobox', { name: '检索类型' }).click(); await page.getByRole('option', { name: '代码符号', exact: true }).click()
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByText('symbol 匹配 1', { exact: true }).waitFor()
    assert.equal(searchCalls.at(-1).repositoryId, '1')
    assert.equal(searchCalls.at(-1).mode, 'symbol')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.getByText('symbol 匹配 21', { exact: true }).waitFor()
    await page.reload(); await page.getByText('symbol 匹配 21', { exact: true }).waitFor()
    await page.locator('.global-loading-overlay').waitFor({ state: 'hidden' })
    await page.screenshot({ path: join(output, 'pc-code-search.png') })
    await page.getByText('symbol 匹配 21', { exact: true }).click()
    await page.locator('[data-source-line="120"].active').waitFor()
    assert.ok(page.url().includes(`commit=${commit}`))
    await page.goBack(); await page.getByText('symbol 匹配 21', { exact: true }).waitFor()
    searchFailure = true
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByText('搜索未完成，请重试。', { exact: false }).waitFor()
    searchFailure = false
    await page.getByRole('button', { name: '重试搜索', exact: true }).click()
    await page.getByText('symbol 匹配 1', { exact: true }).waitFor()
  })
  await check('repository Markdown links and browser back restore README', async () => {
    await page.goto(`${base}/code?repositoryId=1`)
    await page.getByRole('link', { name: '打开源码', exact: true }).click()
    await page.getByText('// fast.js repository 1', { exact: true }).waitFor()
    await page.goBack(); await page.getByText('仓库 1 说明', { exact: true }).waitFor()
  })
  await check('commit diff failure remains retryable without losing repository context', async () => {
    await page.getByText('提交历史', { exact: true }).click()
    commitFailure = true
    await page.getByText('合成变更记录', { exact: true }).click()
    await page.getByText('提交详情加载失败', { exact: true }).waitFor()
    commitFailure = false
    await page.getByRole('button', { name: '重试提交详情', exact: true }).click()
    await page.getByText('new value', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
  })
  await check('task recovery is independent, network failure stops polling and requires retry', async () => {
    taskScenario = true
    await page.goto(`${base}/code`)
    await page.getByText('同步暂停：仓库存在本地修改，原文件已保留。', { exact: true }).waitFor()
    await page.getByText('正在同步', { exact: true }).waitFor()
    assert.equal(await page.locator('button').filter({ hasText: /^安全重克隆$/ }).count(), 1)
    taskFailure = true
    await page.getByText('任务状态暂不可用，已暂停刷新', { exact: true }).waitFor()
    const count = taskCalls.get('3:sync-status')
    await page.waitForTimeout(1800)
    assert.equal(taskCalls.get('3:sync-status'), count)
    taskFailure = false; taskComplete = true
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await page.getByText('最近任务已完成', { exact: true }).waitFor()
    await page.screenshot({ path: join(output, 'pc-code-tasks.png') })
    taskScenario = false
  })
  await check('mobile readonly journey: failed directory retry, full-screen source and close race', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${base}/code`)
    await page.locator('.repo-open').first().click()
    await page.getByText('仓库 1 说明', { exact: true }).waitFor()
    await page.getByRole('link', { name: '打开源码', exact: true }).click()
    await page.getByText('// fast.js repository 1', { exact: true }).waitFor()
    const dialog = await page.getByRole('dialog').boundingBox()
    assert.ok(dialog.width <= 391 && dialog.height >= 840 && dialog.y === 0)
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    treeFailure = true
    await page.getByRole('button', { name: '刷新当前视图', exact: true }).click()
    await page.getByText('内容加载失败，请重试。', { exact: false }).waitFor()
    assert.equal(await page.getByText('此目录暂无文件', { exact: true }).count(), 0)
    treeFailure = false
    await page.getByRole('button', { name: '重试加载', exact: true }).click()
    await page.locator('.file-item').filter({ hasText: 'slow.js' }).click()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.waitForTimeout(800)
    assert.equal(await page.getByRole('dialog').count(), 0)
    await page.screenshot({ path: join(output, 'mobile-code-files.png') })
    assert.equal(await page.getByRole('button', { name: /添加仓库|删除|同步仓库|安全重克隆/ }).count(), 0)
  })
  await check('mobile search, deep-link line, stale snapshot and narrow viewport are safe', async () => {
    await page.getByRole('button', { name: '检索', exact: true }).click()
    await page.getByLabel('仓库内关键词').fill('mobile')
    await page.getByRole('combobox', { name: '检索类型' }).click(); await page.getByRole('option', { name: '代码符号', exact: true }).click()
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByText('mobile 匹配 1', { exact: true }).click()
    await page.locator('[data-source-line="120"].active').waitFor()
    await page.reload(); await page.locator('[data-source-line="120"].active').waitFor()
    const target = await page.locator('[data-source-line="120"].active').boundingBox(), bounds = await page.locator('.code-source').boundingBox()
    assert.ok(target.y >= bounds.y && target.y + target.height <= bounds.y + bounds.height)
    await page.screenshot({ path: join(output, 'mobile-code-line.png') })
    await page.setViewportSize({ width: 320, height: 568 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.goto(`${base}/code?repositoryId=1&path=long.js&line=120&commit=${'b'.repeat(40)}`)
    await page.getByText('该引用对应的提交已过期，请重新检索后打开。', { exact: true }).waitFor()
    assert.equal(await page.locator('.code-source').count(), 0)
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(writes, [])
  await check('PC managed create/edit/delete requires explicit controls; creation does not double submit', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${base}/code`)
    await page.getByRole('button', { name: '添加仓库', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '添加代码仓库', exact: true })
    await dialog.getByPlaceholder('https://github.com/xxx/xxx.git', { exact: true }).fill('https://example.invalid/fixture.git')
    await dialog.getByPlaceholder('给仓库起个名字', { exact: true }).fill('合成新仓库')
    await dialog.getByRole('button', { name: '确定', exact: true }).dblclick()
    await page.locator('.repo-info').filter({ hasText: '合成新仓库' }).waitFor()
    assert.equal(writes.filter(path => path === '/api/code').length, 1)
    await page.locator('.repo-item').filter({ hasText: '合成新仓库' }).getByRole('button', { name: '编辑仓库', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑代码仓库', exact: true })
    await dialog.getByPlaceholder('仓库名称', { exact: true }).fill('修改后的合成仓库')
    await dialog.getByRole('button', { name: '确定', exact: true }).click()
    await page.locator('.repo-info').filter({ hasText: '修改后的合成仓库' }).click()
    await page.locator('.browser-header').getByRole('button', { name: '删除', exact: true }).last().click()
    assert.equal(writes.length, 2, 'opening confirmation must not delete')
    await page.locator('.native-popconfirm__btn--confirm').click()
    await page.getByRole('button', { name: '添加仓库', exact: true }).waitFor()
    assert.equal(await page.getByText('修改后的合成仓库', { exact: true }).count(), 0)
    assert.deepEqual(writes, ['/api/code', '/api/code/4', '/api/code/4'])
  })
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors, writes }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, errors, output }))
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') })
  console.error(errors, (await page.locator('body').innerText()).slice(0, 2500))
  throw error
} finally { await browser.close() }
