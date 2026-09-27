import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.THEME_TEST_URL || 'http://127.0.0.1:5178'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
const browser = await chromium.launch({ headless: true, ...(process.env.THEME_BROWSER_PATH ? { executablePath: process.env.THEME_BROWSER_PATH } : {}) })
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme })
    const sent = [], errors = []
    await context.route(`${base}/api/**`, async route => {
      const p = new URL(route.request().url()).pathname
      let body = { data: [] }
      if (p === '/api/auth/check') body = { authenticated: true, user: { username: 'owner', principal: 'owner', isGuest: false } }
      if (p === '/api/rag/coverage') body = { data: { data: [1, 2].map(id => ({ source: { type: 'document', id, title: `合成资料${id}` }, status: 'ready', chunkCount: 2 })) } }
      if (p === '/api/rag/queries') {
        sent.push(route.request().postDataJSON())
        body = { data: { status: 'complete', answer: `分项回答 ${sent.length} [C1]`, citations: [{ title: '合成依据', excerpt: '明确依据', openUrl: '/documents' }] } }
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${base}/search?mode=ask`)
    await page.locator('.search-input').fill('分别说明两份资料的要求')
    await page.getByRole('button', { name: '拆分提问', exact: true }).click()
    const plan = page.getByRole('region', { name: '分步提问计划' })
    await plan.locator('textarea').nth(0).fill('资料一的要求？')
    await plan.locator('textarea').nth(1).fill('资料二的要求？')
    await plan.locator('select').nth(0).selectOption('document:1')
    assert.equal(await plan.getByRole('button', { name: '确认并依次提问' }).isDisabled(), true)
    await plan.locator('select').nth(1).selectOption('document:2')
    assert.equal(sent.length, 0)
    await plan.getByRole('button', { name: '确认并依次提问' }).click()
    await plan.getByText(/分项结果已汇总/).waitFor()
    assert.equal(sent.length, 2)
    assert.deepEqual(sent.map(x => x.source.id), [1, 2])
    assert.equal(await plan.locator('article').count(), 2)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false)
    await page.locator('.search-input').fill('修改后的问题')
    assert.equal(await plan.count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('RAG plan: desktop/mobile × light/dark passed')
} finally { await browser.close() }
