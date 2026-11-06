// Regression for overlapping requests, failures and Chinese input. Synthetic local API only.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.AUDIT_TEST_URL || 'http://127.0.0.1:5187'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
const out = process.env.AUDIT_TEST_OUTPUT
const checks = [], errors = []
const check = (name, value) => checks.push({ name, passed: Boolean(value) })
const browser = await chromium.launch({ headless: true, ...(process.env.THEME_BROWSER_PATH ? { executablePath: process.env.THEME_BROWSER_PATH } : {}) })
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: theme, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' })
    const pending = new Map(), requests = []
    let fail = false, todoWrites = 0, failTodo = true
    await context.route(`${base}/api/**`, async route => {
      const url = new URL(route.request().url()), path = url.pathname
      requests.push(url)
      if (url.searchParams.get('keyword') === 'older' || url.searchParams.get('q') === 'older') {
        pending.set(path, route); return
      }
      let json = { data: [], total: 0 }, status = 200
      if (path === '/api/auth/check') json = { authenticated: true, user: { username: 'fixture', principal: 'owner', isGuest: false } }
      if (path === '/api/todos') json = { data: [{ id: 1, text: '合成待办', confirmed: 0, completed: 0 }] }
      if (path === '/api/todos/1' && route.request().method() === 'PUT') { todoWrites++; status = failTodo ? 503 : 200; json = { success: !failTodo } }
      if (path === '/api/admin/logs/stats') json = { data: { todayCount: 1, totalCount: 100, todayActiveUsers: 1 } }
      if (path === '/api/admin/blacklist/stats') json = { data: { total: 1, active: 1, permanent: 0, todayBlocked: 1 } }
      if (path === '/api/admin/blacklist') json = { data: [{ id: 1, ip_address: '192.0.2.1', reason: '合成记录', blocked_at: '2026-11-06T00:00:00Z' }], total: 1 }
      if (path === '/api/admin/blacklist/block') { pending.set(path, route); return }
      if (path === '/api/admin/logs') json = { data: [{ id: 1, path: '/newer', created_at: '2026-11-06 00:00:00' }, { id: 2, path: '/iso', created_at: '2026-11-06T00:00:00.000Z' }], total: 100 }
      if (path === '/api/trash') json = { data: { items: [{ key: 'document:1', resourceType: 'document', resourceId: 1, title: 'newer', canRestore: true }], summary: { total: 1 }, pagination: { page: 1, pageSize: 20, total: 1 } } }
      if (fail && ['/api/admin/logs', '/api/admin/blacklist'].includes(path)) { status = 503; json = { message: '合成失败' } }
      await route.fulfill({ status, json })
    })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${base}/dashboard`)
    const todo = page.getByPlaceholder('输入待办内容').first()
    await todo.waitFor()
    await todo.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    check(`${theme}: dashboard IME does not save`, todoWrites === 0)
    await todo.focus()
    await page.getByRole('button', { name: '确认', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '待办保存失败' }).waitFor()
    check(`${theme}: failed todo remains editable`, await todo.isEnabled() && await todo.inputValue() === '合成待办')
    failTodo = false
    await todo.press('Enter')
    await page.waitForTimeout(100)
    check(`${theme}: dashboard retry saves once (${todoWrites} total requests)`, todoWrites === 2)
    await page.goto(`${base}/logs`)
    await page.getByText('/newer', { exact: true }).waitFor()
    check(`${theme}: UTC+8 once`, (await page.locator('.logs-container').innerText()).split('08:00:00').length === 3)
    await page.getByRole('combobox', { name: '每页条数' }).selectOption('15')
    await page.waitForTimeout(100)
    check(`${theme}: page size request`, requests.filter(u => u.pathname === '/api/admin/logs').at(-1).searchParams.get('pageSize') === '15')
    await page.getByRole('button', { name: '访问日期（UTC+8）', exact: true }).click()
    const date = page.getByRole('dialog', { name: '日期范围' })
    const day = await date.locator('.native-date-range-picker__day--today').getAttribute('aria-label')
    await date.getByRole('button', { name: day, exact: true }).click()
    await date.getByRole('button', { name: day, exact: true }).click()
    await date.getByRole('button', { name: '确定', exact: true }).click()
    await page.getByRole('button', { name: '查询', exact: true }).click()
    await page.waitForTimeout(100)
    const params = requests.filter(u => u.pathname === '/api/admin/logs').at(-1).searchParams
    check(`${theme}: inclusive UTC+8 date filter`, params.get('startDate') === new Date(`${day}T00:00:00+08:00`).toISOString().slice(0, 19).replace('T', ' ') && params.get('endDate') === `${day} 15:59:59`)
    for (const [path, input, button, apiPath] of [
      ['logs', '搜索用户/IP/路径', '查询', '/api/admin/logs'],
      ['trash', '标题、作者、艺术家或原位置', '筛选', '/api/trash']
    ]) {
      await page.goto(`${base}/${path}`)
      await page.getByPlaceholder(input).fill('older')
      await page.getByRole('button', { name: button, exact: true }).click()
      await page.waitForTimeout(100)
      assert.ok(pending.has(apiPath), `held ${apiPath}`)
      await page.getByPlaceholder(input).fill('newer')
      await page.getByRole('button', { name: button, exact: true }).click()
      await page.waitForTimeout(100)
      await pending.get(apiPath).fulfill({ status: 503, json: { message: '旧请求失败' } })
      pending.delete(apiPath)
      await page.waitForTimeout(100)
      check(`${theme}: ${path} ignores stale error`, (await page.locator('body').innerText()).includes(path === 'logs' ? '/newer' : 'newer') && !(await page.locator('body').innerText()).includes('旧请求失败'))
    }
    fail = true
    await page.goto(`${base}/logs`)
    await page.waitForTimeout(200)
    check(`${theme}: logs visible failure`, (await page.locator('.logs-container').innerText()).includes('日志加载失败'))
    fail = false
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByText('/newer', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'IP黑名单', exact: true }).click()
    await page.getByText('合成记录', { exact: true }).waitFor()
    fail = true
    await page.getByRole('button', { name: '搜索黑名单', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '黑名单加载失败' }).waitFor()
    fail = false
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await page.getByText('合成记录', { exact: true }).waitFor()
    await page.getByRole('button', { name: '手动拉黑', exact: true }).click()
    const block = page.getByRole('dialog', { name: '手动拉黑IP', exact: true })
    await block.getByRole('button', { name: '确认拉黑' }).click()
    check(`${theme}: empty IP validation keeps dialog`, await block.isVisible())
    await block.getByLabel(/IP地址/).fill('192.0.2.2')
    await block.getByRole('button', { name: '确认拉黑' }).click()
    await page.waitForTimeout(100)
    check(`${theme}: block pending locks action`, await block.getByRole('button', { name: '确认拉黑' }).isDisabled() && await block.getByRole('button', { name: '取消' }).isDisabled())
    await pending.get('/api/admin/blacklist/block').fulfill({ status: 503, json: { message: '合成失败' } })
    pending.delete('/api/admin/blacklist/block')
    await page.waitForTimeout(100)
    check(`${theme}: block failure keeps input`, await block.getByLabel(/IP地址/).inputValue() === '192.0.2.2')
    await block.getByRole('button', { name: '确认拉黑' }).click()
    await page.waitForTimeout(100)
    await pending.get('/api/admin/blacklist/block').fulfill({ json: { success: true } })
    pending.delete('/api/admin/blacklist/block')
    await block.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '解除', exact: true }).click()
    await page.waitForTimeout(100)
    check(`${theme}: unblock action delivered`, requests.some(u => u.pathname === '/api/admin/blacklist/unblock'))
    check(`${theme}: toast readable and announced`, await page.locator('.toast-item').first().evaluate(e => {
      const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
      const lum = values => values.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0)
      const a = lum(rgb(getComputedStyle(e).backgroundColor)), b = lum(rgb(getComputedStyle(e.querySelector('.toast-message')).color))
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5 && ['alert', 'status'].includes(e.getAttribute('role')) && getComputedStyle(e).animationName === 'none'
    }))
    if (out) await page.screenshot({ path: `${out}/${theme}-blacklist.png` })
    await page.setViewportSize({ width: 390, height: 960 })
    await page.goto(`${base}/logs`)
    await page.locator('.layout-mobile').waitFor()
    await page.getByText('/newer', { exact: true }).waitFor()
    await page.locator('.global-loading-overlay').waitFor({ state: 'hidden' })
    check(`${theme}: mobile hides admin writes`, await page.getByRole('button', { name: 'IP黑名单', exact: true }).count() === 0 && await page.getByRole('button', { name: '手动拉黑', exact: true }).count() === 0)
    check(`${theme}: mobile logs fit`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
    if (out) await page.screenshot({ path: `${out}/${theme}-logs-mobile.png`, fullPage: true })
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto(`${base}/logs`)
    await page.locator('.fixed-header').waitFor()
    await page.getByText('/newer', { exact: true }).waitFor()
    await page.locator('.global-loading-overlay').waitFor({ state: 'hidden' })
    if (out) await page.screenshot({ path: `${out}/${theme}-logs.png`, fullPage: true })
    // Mount the real shared controls, preserving their real Vue and CSS runtime.
    await page.evaluate(async () => {
      const vueUrl = performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname.endsWith('/deps/vue.js'))
      const { createApp, h, reactive } = await import(vueUrl)
      const [{ default: Input }, { default: Tags }, { default: Select }] = await Promise.all(['NativeInput', 'NativeTagInput', 'NativeSelect'].map(n => import(`/src/components/native/${n}.vue`)))
      document.querySelector('#app').__vue_app__.unmount()
      const host = document.createElement('div'); document.body.append(host)
      const s = reactive({ text: '', enter: 0, tags: ['保留'], selected: 'a' }); window.auditState = s
      createApp({ render: () => h('div', [
        h(Input, { 'aria-label': '中文输入', modelValue: s.text, 'onUpdate:modelValue': v => { s.text = v }, onEnter: () => { s.enter++ } }),
        h(Tags, { 'aria-label': '中文标签', modelValue: s.tags, 'onUpdate:modelValue': v => { s.tags = v } }),
        h(Select, { 'aria-label': '中文选择', filterable: true, modelValue: s.selected, 'onUpdate:modelValue': v => { s.selected = v }, options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] })
      ]) }).mount(host)
    })
    const input = page.getByRole('textbox', { name: '中文输入' })
    await input.dispatchEvent('compositionstart')
    await input.evaluate(e => { e.value = 'zhong'; e.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })) })
    await input.dispatchEvent('keyup', { key: 'Enter', isComposing: true })
    check(`${theme}: IME no interim search`, await page.evaluate(() => auditState.text === '' && auditState.enter === 0))
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await input.evaluate(e => { e.value = '中文'; e.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })) })
    await input.dispatchEvent('keyup', { key: 'Enter', isComposing: false })
    check(`${theme}: IME commit Enter not search`, await page.evaluate(() => auditState.enter === 0))
    check(`${theme}: IME commits`, await page.evaluate(() => auditState.text === '中文'))
    await input.press('Enter')
    check(`${theme}: explicit Enter works`, await page.evaluate(() => auditState.enter === 1))
    const tags = page.getByRole('textbox', { name: '中文标签' })
    check(`${theme}: IME enter not prevented`, await tags.evaluate(e => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))))
    await tags.dispatchEvent('keydown', { key: 'Backspace', isComposing: true })
    check(`${theme}: IME keeps tag`, await page.evaluate(() => auditState.tags.length === 1))
    await page.getByRole('combobox', { name: '中文选择' }).click()
    const filter = page.locator('.native-select__filter-input')
    await filter.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await page.waitForTimeout(100)
    check(`${theme}: IME keeps selector open`, await filter.isVisible())
    await context.close()
  }
} finally {
  await browser.close()
  if (out) { await mkdir(out, { recursive: true }); await writeFile(`${out}/interaction.json`, JSON.stringify({ checks, errors }, null, 2)) }
}
console.log(JSON.stringify({ checks, errors }, null, 2))
assert.equal(errors.length, 0, 'uncaught browser errors')
assert.ok(checks.every(c => c.passed), 'interaction regressions')
