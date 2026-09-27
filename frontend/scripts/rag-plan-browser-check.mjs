import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.THEME_TEST_URL || 'http://127.0.0.1:5178'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
const browser = await chromium.launch({ headless: true, ...(process.env.THEME_BROWSER_PATH ? { executablePath: process.env.THEME_BROWSER_PATH } : {}) })
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme })
    const sent = [], errors = []
    let scenario = 'evidence'
    await context.route(`${base}/api/**`, async route => {
      const p = new URL(route.request().url()).pathname
      let body = { data: [] }
      if (p === '/api/auth/check') body = { authenticated: true, user: { username: 'owner', principal: 'owner', isGuest: false } }
      if (p === '/api/rag/coverage') body = { data: { data: [1, 2].map(id => ({ source: { type: 'document', id, title: `合成资料${id}` }, status: 'ready', chunkCount: 2 })) } }
      if (p === '/api/rag/queries') {
        sent.push(route.request().postDataJSON())
        body = { data: { status: 'complete', answer: `分项回答 ${sent.length} [C1]`, citations: [{ title: '合成依据' }], evidence: [{ title: '合成依据', excerpt: '明确依据 <script>不可执行</script>', locator: { sectionPath: ['第二节'], startLine: 12, endLine: 18 }, excerptTruncated: true }] } }
        if (scenario === 'structured') body = { data: { status: 'complete', reasonCode: 'structured_fact', answer: '当前正文共 12 章。', citations: [] } }
        if (scenario === 'empty') body = { data: { status: 'degraded', abstained: true, degraded: true, reasonCode: 'no_evidence', evidence: [], citations: [] } }
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
    assert.equal(await plan.locator('blockquote').count(), 2)
    assert.equal(await plan.locator('details[open]').count(), 0)
    assert.equal(await plan.getByText('此处仅显示部分原文，不代表完整上下文。').count(), 2)
    assert.equal(await plan.locator('blockquote script').count(), 0)
    await plan.locator('summary').first().focus()
    await page.keyboard.press('Enter')
    assert.equal(await plan.locator('details[open]').count(), 1)
    assert.match(await plan.locator('.metadata').first().innerText(), /第二节.*12–18/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false)
    await page.locator('.search-input').fill('修改后的问题')
    assert.equal(await plan.count(), 0)
    await page.locator('.search-form').evaluate(form => form.requestSubmit())
    const result = page.locator('.answer-panel .rag-evidence-result')
    await result.locator('blockquote').waitFor()
    assert.equal(await result.locator('details[open]').count(), 0)
    assert.match(await result.innerText(), /相关片段，不代表证据已足以回答/)
    if (process.env.THEME_TEST_OUTPUT) {
      await mkdir(process.env.THEME_TEST_OUTPUT, { recursive: true })
      await page.screenshot({ path: `${process.env.THEME_TEST_OUTPUT}/${width}-${theme}-evidence.png`, fullPage: true })
    }
    scenario = 'structured'
    await page.locator('.search-input').fill('正文有几章？')
    await page.locator('.search-form').evaluate(form => form.requestSubmit())
    await result.getByText('资料记录', { exact: true }).waitFor()
    assert.equal(await result.locator('details').count(), 0)
    scenario = 'empty'
    await page.locator('.search-input').fill('缺少资料的问题')
    await page.locator('.search-form').evaluate(form => form.requestSubmit())
    await result.getByText(/本次未返回可展示的原文片段/).waitFor()
    assert.equal(await result.locator('details').count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('RAG plan: desktop/mobile × light/dark passed')
} finally { await browser.close() }
