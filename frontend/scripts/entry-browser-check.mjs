// Real frontend with deterministic demo service data. No Owner service or external network.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createDemoSession, resolveDemoSession, DEMO_JOURNEYS, runDemoJourney, getDemoSummary, listDemoResources, createDemoResource, deleteDemoResource, resetDemoSession } from '../../backend/src/services/demoWorkspace.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.ENTRY_TEST_URL || 'http://127.0.0.1:5187'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
const out = process.env.ENTRY_TEST_OUTPUT
if (out) await mkdir(out, { recursive: true })
const checks = [], errors = []
async function checkEnlargedText(page) {
  await page.evaluate(() => {
    window.entryFontStyles = [...document.body.querySelectorAll('*')].map(e => [e, e.style.fontSize, getComputedStyle(e).fontSize])
    for (const [e, , size] of window.entryFontStyles) e.style.fontSize = `${parseFloat(size) * 2}px`
  })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), '200% text fits page')
  await page.evaluate(() => { for (const [e, size] of window.entryFontStyles) e.style.fontSize = size; delete window.entryFontStyles })
}
const browser = await chromium.launch({ headless: true, ...(process.env.THEME_BROWSER_PATH ? { executablePath: process.env.THEME_BROWSER_PATH } : {}) })
try {
  for (const width of [360, 1440]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, reducedMotion: 'reduce' })
    let mode = 'none', heldLogin, failJourneys = true, failLogin = true, loginRequests = 0
    const { token } = createDemoSession(), session = resolveDemoSession(token)
    await context.route(`${base}/api/**`, async route => {
      const req = route.request(), path = new URL(req.url()).pathname, method = req.method()
      let json = { data: [], total: 0 }, status = 200
      if (path === '/api/auth/check') { status = mode === 'owner' ? 200 : 401; json = { authenticated: mode === 'owner', user: { username: 'fixture', principal: 'owner', isGuest: false } } }
      else if (path === '/api/auth/login') { loginRequests++; if (failLogin) { heldLogin = route; return } mode = 'owner'; json = { success: true, user: { username: 'fixture', principal: 'owner' } } }
      else if (path === '/api/demo/sessions') { mode = 'demo'; json = { authenticated: true, user: { principal: 'demo', isGuest: true } } }
      else if (path === '/api/demo/session') { if (method === 'DELETE') { mode = 'none'; json = { success: true } } else { status = mode === 'demo' ? 200 : 401; json = { authenticated: mode === 'demo', user: { principal: 'demo', isGuest: true } } } }
      else if (path === '/api/demo/journeys') { status = failJourneys ? 503 : 200; json = failJourneys ? { message: '合成初始化失败' } : { journeys: DEMO_JOURNEYS } }
      else if (path === '/api/demo/summary') json = { summary: getDemoSummary(session) }
      else if (path === '/api/demo/reset') { resetDemoSession(session); json = { success: true } }
      else if (path === '/api/demo/resources/notes') json = method === 'POST' ? createDemoResource(session, 'notes', req.postDataJSON()) : listDemoResources(session, 'notes')
      else if (path.startsWith('/api/demo/resources/notes/')) json = deleteDemoResource(session, 'notes', path.split('/').at(-1))
      else if (/\/api\/demo\/journeys\/[^/]+\/run$/.test(path)) json = runDemoJourney(session, path.split('/').at(-2), req.postDataJSON())
      await route.fulfill({ status, json })
    })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${base}/login`)
    await page.getByLabel('用户名', { exact: true }).fill('fixture')
    await page.getByLabel('密码', { exact: true }).fill('Synthetic-only-password')
    assert.equal(await page.getByLabel('密码', { exact: true }).getAttribute('autocomplete'), 'current-password')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForTimeout(100)
    assert.ok(await page.getByRole('button', { name: '体验演示空间', exact: true }).isDisabled())
    await page.locator('form').dispatchEvent('submit')
    assert.equal(loginRequests, 1)
    await heldLogin.fulfill({ status: 401, json: { message: '合成登录失败' } })
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByLabel('用户名', { exact: true }).inputValue(), 'fixture')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
    if (out) await page.screenshot({ path: `${out}/${width}-${theme}-login.png`, fullPage: true })
    await checkEnlargedText(page)
    await page.getByRole('button', { name: '体验演示空间', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '合成初始化失败' }).waitFor()
    failJourneys = false
    await page.getByRole('button', { name: '重试加载', exact: true }).click()
    await page.locator('.result-list li').first().waitFor()
    for (const title of ['有证据的问答', '持久任务与恢复', '资源生命周期']) {
      const journey = DEMO_JOURNEYS.find(j => j.title === title)
      assert.ok(journey, title)
      await page.getByRole('button', { name: new RegExp(title) }).click()
      await page.waitForTimeout(100)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
    }
    await page.getByLabel('写入当前会话覆盖层').fill('浏览器合成笔记')
    await page.getByRole('button', { name: '新增临时条目' }).click()
    await page.getByText('浏览器合成笔记', { exact: true }).waitFor()
    await page.locator('.overlay-list li').filter({ hasText: '浏览器合成笔记' }).getByRole('button').click()
    await page.getByText('浏览器合成笔记', { exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '重置会话' }).click()
    await page.getByText('会话覆盖层已清空，合成基线已恢复', { exact: true }).waitFor()
    if (out) await page.screenshot({ path: `${out}/${width}-${theme}-demo.png`, fullPage: true })
    await checkEnlargedText(page)
    await page.getByRole('button', { name: '退出演示' }).click()
    await page.getByLabel('用户名', { exact: true }).waitFor()
    failLogin = false
    await page.getByLabel('用户名', { exact: true }).fill('fixture')
    await page.getByLabel('密码', { exact: true }).fill('Synthetic-only-password')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/dashboard')
    checks.push({ width, theme, loginRetry: true, exclusiveSubmit: true, demoInitializationRetry: true, fourJourneys: true, lifecycle: true, exit: true })
    await context.close()
  }
} finally {
  await browser.close()
  if (out) await writeFile(`${out}/results.json`, JSON.stringify({ checks, errors }, null, 2))
}
console.log(JSON.stringify({ checks, errors }, null, 2))
assert.deepEqual(errors, [])
