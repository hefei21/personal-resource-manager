// Synthetic contract/visual regression. Uses the same isolated Playwright
// runtime convention as theme-browser-check.mjs; never contacts real data.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.THEME_TEST_URL || 'http://127.0.0.1:5178'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
const out = await mkdtemp(join(tmpdir(), 'rag-scope-browser-'))
const browser = await chromium.launch({ headless: true,
  ...(process.env.THEME_BROWSER_PATH ? { executablePath: process.env.THEME_BROWSER_PATH } : {}) })
const book = { id: 701, title: '合成书籍：山间记录', author: '合成作者', fileType: 'epub', progress: 0 }
const chapters = [0, 1].map(index => ({ key: String(index + 1).repeat(64), label: `第${index + 1}章 山间观察`, chapterIndex: index }))
const errors = []
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme,
      reducedMotion: 'reduce', isMobile: width < 768, hasTouch: width < 768 })
    const queries = []
    let stale = false
    await context.route(`${base}/api/**`, async route => {
      const url = new URL(route.request().url()), p = url.pathname
      let status = 200, body = { data: [], total: 0 }
      if (p === '/api/auth/check') body = { authenticated: true, user: { username: 'owner', principal: 'owner', isGuest: false } }
      else if (p === '/api/rag/coverage') body = { data: { data: (width < 768 ? [702] : [701, 702]).map(id => ({ source: { type: 'ebook', id, title: `合成书籍 ${id}` }, status: 'ready', chunkCount: 10 })) } }
      else if (p === '/api/rag/status') body = { data: { status: 'ready' } }
      else if (p === '/api/rag/sources/ebook/701/status') body = { data: { sourceState: { status: 'ready' }, chunks: { count: 10 } } }
      else if (p.endsWith('/sections')) body = { data: { sections: stale ? [] : chapters } }
      else if (p === '/api/rag/queries') {
        queries.push(route.request().postDataJSON())
        status = stale ? 409 : 200
        body = stale ? { code: 'RAG_SECTION_STALE' } : { data: { status: 'abstained', reasonCode: 'no_evidence', abstained: true, citations: [] } }
      } else if (p === '/api/ebooks') body = { data: [book], pagination: { page: 1, pageSize: 24, total: 1, totalPages: 1 }, total: 1 }
      else if (p.endsWith('/701/detail')) body = { data: book }
      else if (p.endsWith('/701/progress')) body = { data: { revision: 0, position: null, progress: 0 } }
      else if (p.endsWith('/701/chapters')) body = { chapters: url.searchParams.has('manifest')
        ? chapters.map((item, index) => ({ id: index + 1, title: item.label, href: `${index}.xhtml` }))
        : [{ content: '<h1>合成章节</h1><p>只用于验证阅读器与问资料范围交互。</p>' }] }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${base}/books?bookId=701&chapterIndex=1`)
    await page.locator('.ebook-reader__paper').waitFor()
    await page.getByRole('button', { name: '询问这本书的资料' }).click()
    await page.getByLabel('书内范围', { exact: true }).waitFor({ timeout: 10000 }).catch(async error => {
      console.error({ url: page.url(), errors, text: (await page.locator('body').innerText()).slice(0, 2500) })
      throw error
    })
    await page.getByRole('button', { name: '限定当前章节', exact: true }).waitFor()
    const scope = page.getByLabel('书内范围', { exact: true })
    assert.equal(await scope.inputValue(), '')
    await page.locator('.search-row input').fill('比较第一章和第二章，不限于第一章')
    await page.locator('.search-row button').click()
    await page.waitForFunction(() => document.querySelector('.answer-abstained'))
    assert.equal(queries.at(-1).section, undefined)
    assert.deepEqual(queries.at(-1).source, { type: 'ebook', id: 701 })
    await page.getByRole('button', { name: '限定当前章节', exact: true }).click()
    assert.equal(await scope.inputValue(), chapters[1].key)
    await page.locator('.search-row button').click()
    await page.waitForFunction(() => document.querySelector('.answer-abstained'))
    assert.equal(queries.at(-1).section, chapters[1].key)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false)
    await page.screenshot({ path: join(out, `${width}-${theme}.png`), fullPage: true })
    stale = true
    await page.locator('.search-row button').click()
    await page.getByText('章节索引已有变化', { exact: false }).waitFor()
    assert.equal(await scope.inputValue(), chapters[1].key)
    await page.getByRole('button', { name: '刷新章节', exact: true }).click()
    await page.getByText('章节范围已失效', { exact: false }).waitFor()
    assert.equal(await scope.inputValue(), chapters[1].key)
    stale = false
    await page.getByLabel('回答范围', { exact: true }).selectOption('ebook:702')
    await page.waitForFunction(() => document.querySelector('.ask-chapter-panel select')?.options.length === 3)
    assert.equal(await scope.inputValue(), '')
    assert.equal(await page.getByRole('button', { name: '限定当前章节', exact: true }).count(), 0)
    await context.close()
    console.log(`PASS ${width} ${theme}: reader hint, whole-book, explicit chapter, stale selection, book change`)
  }
  assert.deepEqual(errors, [])
  console.log(`Screenshots: ${out}`)
} finally { await browser.close() }
