// Synthetic shell journeys only. No Owner backend, passwords, or external services.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.SHELL_TEST_URL || 'http://127.0.0.1:5187'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
const out = process.env.SHELL_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'shell-browser-'))
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true,
  ...(process.env.THEME_BROWSER_PATH ? { executablePath: process.env.THEME_BROWSER_PATH } : {}) })
const results = [], errors = [], unexpectedWrites = []
const username = '合成用户名称'.repeat(12)

async function fixture(route) {
  const request = route.request(), path = new URL(request.url()).pathname
  if (request.method() !== 'GET') unexpectedWrites.push({ method: request.method(), path })
  let body = { success: true, data: [], total: 0, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } }
  if (path === '/api/auth/check') body = { authenticated: true, user: { username, principal: 'owner', isGuest: false } }
  else if (path === '/api/health') body = { status: 'ok', database: { status: 'ok' }, redis: { connected: true } }
  else if (path === '/api/stats') body = { data: { documents: 19, books: 18, music: 24, code: 3, bookmarks: 6, games: 4, anime: 2 } }
  else if (path === '/api/rag/status') body = { data: { enabled: false, worker: { online: false }, coverage: { total: 10, indexed: 8 } } }
  else if (path === '/api/rag/coverage' || path === '/api/trash') body = { data: { data: [], items: [], total: 0 } }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

async function settled(page) {
  await page.locator('.fixed-header').waitFor()
  await page.locator('.global-loading-overlay').waitFor({ state: 'hidden' })
}

async function geometry(page, label) {
  const state = await page.evaluate(() => {
    const header = document.querySelector('.header-content')
    const bounds = [...header.children].map(e => e.getBoundingClientRect())
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 2,
      headerOverlap: bounds[0].right > bounds[1].left + 1,
      headerOverflow: bounds.some(r => r.left < 0 || r.right > innerWidth + 1),
      touch: [...document.querySelectorAll('.layout-mobile .fixed-header button, .bottom-navigation button')]
        .map(e => ({ label: e.getAttribute('aria-label') || e.innerText, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height }))
    }
  })
  assert.equal(state.overflow, false, `${label}: page overflow`)
  assert.equal(state.headerOverlap, false, `${label}: header overlap`)
  assert.equal(state.headerOverflow, false, `${label}: header overflow`)
  for (const target of state.touch) assert.ok(target.width >= 44 && target.height >= 44, `${label}: small target ${JSON.stringify(target)}`)
  results.push({ label, ...state })
}

try {
  for (const width of [360, 390, 768, 1440, 3840]) for (const theme of ['light', 'dark']) {
    const mobile = width <= 768
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme,
      reducedMotion: 'reduce', isMobile: mobile, hasTouch: mobile })
    await context.route(`${base}/api/**`, fixture)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${base}/dashboard`)
    await settled(page)
    await geometry(page, `${width}-${theme}-home`)
    if (mobile) {
      assert.equal(await page.getByRole('button', { name: '修改密码', exact: true }).count(), 0)
      const nav = page.getByRole('navigation', { name: '主要导航' })
      await nav.getByRole('button', { name: '资源库', exact: true }).click()
      await page.waitForURL(`${base}/library`)
      await page.getByRole('link').filter({ hasText: '电子书' }).click()
      await page.waitForURL(`${base}/books`)
      await geometry(page, `${width}-${theme}-module`)
      await nav.getByRole('button', { name: '收藏', exact: true }).click()
      await page.waitForURL(`${base}/collection`)
      await nav.getByRole('button', { name: '资源库', exact: true }).click()
      await page.waitForURL(`${base}/books`)
      await nav.getByRole('button', { name: '资源库', exact: true }).click()
      await page.waitForURL(`${base}/library`)
      await page.evaluate(() => localStorage.setItem('pr-manager:last-route:workspace', '/logs'))
      await nav.getByRole('button', { name: '工作台', exact: true }).click()
      await page.waitForURL(`${base}/workspace`)
      await nav.getByRole('button', { name: '更多', exact: true }).click()
      await page.waitForURL(`${base}/more`)
      assert.equal(await page.getByRole('link', { name: /访问日志/ }).count(), 0)
    } else {
      assert.equal(await page.locator('.menu-item[aria-current="page"]').innerText(), '首页')
      const trigger = page.getByRole('button', { name: '修改密码', exact: true })
      await trigger.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: '修改密码', exact: true })
      await dialog.waitFor()
      for (const label of ['旧密码', '新密码', '确认密码']) assert.equal(await dialog.getByLabel(label, { exact: true }).count(), 1)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await trigger.evaluate(e => e === document.activeElement), true, 'dialog restores opener focus')
      await page.getByRole('button', { name: '工作台', exact: true }).click()
      await page.waitForURL(`${base}/workspace`)
    }
    await settled(page)
    await geometry(page, `${width}-${theme}-hub`)
    // Mount the actual shared input through Vite, with the same attributes used
    // by note categories and PDF page navigation. No test-only product route.
    await page.evaluate(async () => {
      const vueUrl = performance.getEntriesByType('resource').map(entry => entry.name)
        .find(url => new URL(url).pathname.endsWith('/deps/vue.js'))
      if (!vueUrl) throw new Error('Vite Vue runtime was not loaded')
      const { createApp, h, reactive } = await import(vueUrl)
      const { default: NativeInput } = await import('/src/components/native/NativeInput.vue')
      const host = document.createElement('section')
      host.id = 'shell-input-check'
      host.style.cssText = 'position:fixed;top:160px;left:20px;width:280px;z-index:99999'
      document.body.append(host)
      const state = reactive({ value: '初始内容', disabled: false, readonly: false, numeric: false })
      window.shellInputCheck = state
      createApp({ render: () => h(NativeInput, {
        modelValue: state.value, 'onUpdate:modelValue': value => { state.value = value },
        'aria-label': '共享输入验证', 'aria-describedby': 'shell-input-description',
        maxlength: 8, clearable: true, disabled: state.disabled, readonly: state.readonly,
        type: state.numeric ? 'number' : 'text', min: 1, max: 5,
        class: 'consumer-layout', style: { width: '260px' }
      }) }).mount(host)
    })
    const field = page.getByRole('textbox', { name: '共享输入验证', exact: true })
    assert.equal(await field.getAttribute('maxlength'), '8')
    assert.equal(await field.getAttribute('aria-describedby'), 'shell-input-description')
    assert.equal(await page.locator('#shell-input-check .native-input-wrapper.consumer-layout').count(), 1)
    await field.fill('')
    await field.pressSequentially('1234567890')
    assert.equal(await field.inputValue(), '12345678')
    const clear = page.locator('#shell-input-check').getByRole('button', { name: '清除', exact: true })
    if (mobile) {
      const box = await clear.boundingBox()
      assert.ok(box.width >= 44 && box.height >= 44)
    }
    await clear.click()
    assert.equal(await field.inputValue(), '')
    assert.equal(await field.evaluate(e => document.activeElement === e), true)
    await field.fill('保留内容')
    await page.evaluate(() => { window.shellInputCheck.disabled = true })
    assert.equal(await field.isDisabled(), true)
    assert.equal(await clear.count(), 0)
    await page.evaluate(() => { window.shellInputCheck.disabled = false; window.shellInputCheck.readonly = true })
    assert.equal(await field.isEditable(), false)
    assert.equal(await clear.count(), 0)
    assert.equal(await field.inputValue(), '保留内容')
    await page.evaluate(() => { window.shellInputCheck.readonly = false; window.shellInputCheck.numeric = true; window.shellInputCheck.value = '6' })
    assert.equal(await page.getByRole('spinbutton', { name: '共享输入验证' }).evaluate(e => e.validity.rangeOverflow), true)
    results.push({ label: `${width}-${theme}-input`, attributes: true, disabled: true, readonly: true, clearFocus: true })
    await page.locator('#shell-input-check').evaluate(e => e.remove())
    await page.screenshot({ path: join(out, `${width}-${theme}-shell.png`), fullPage: true })
    await context.close()
  }
  assert.deepEqual(errors, [], 'uncaught browser exceptions')
  assert.deepEqual(unexpectedWrites, [], 'shell checks never submit credentials or change resources')
} finally {
  await writeFile(join(out, 'results.json'), JSON.stringify({ results, errors, unexpectedWrites }, null, 2))
  await browser.close()
}
console.log(`Shell and input journeys passed: ${results.length} checks; ${out}`)
