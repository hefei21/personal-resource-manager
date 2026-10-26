// Real app routes with synthetic API responses; no Owner backend or model calls.
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.RAG_TEST_URL || 'http://127.0.0.1:5191'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
const browser = await chromium.launch({ headless: true,
  ...(process.env.RAG_BROWSER_PATH ? { executablePath: process.env.RAG_BROWSER_PATH } : {}) })
const excerpt = '合成原文：借阅期限为十四天，续借须无其他读者预约。'
const evidence = [{ citationId: 'C1', title: '合成借阅说明', excerpt, openUrl: '/documents' }]
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme,
      reducedMotion: 'reduce', isMobile: width < 768, hasTouch: width < 768 })
    const errors = [], requests = []
    let answerImmediately = false, cancelled = 0, recoveryMode = false, recoveryReady = false
    await context.route(`${base}/api/**`, async route => {
      const request = route.request(), url = new URL(request.url()), p = url.pathname
      assert.equal(url.origin, base, 'No external API requests')
      let body = { data: [], total: 0 }, status = 200
      if (p === '/api/auth/check') body = { authenticated: true, user: { username: 'owner', principal: 'owner', isGuest: false } }
      else if (p === '/api/rag/status') body = { data: { status: 'ready' } }
      else if (p === '/api/rag/coverage') body = { data: { data: [{ source: { type: 'document', id: 701, title: '合成借阅说明' }, status: 'ready', chunkCount: 2 }] } }
      else if (p === '/api/rag/queries') {
        requests.push(request.postDataJSON())
        body = { data: answerImmediately
          ? { status: 'complete', answer: '可借十四天。', citations: evidence, evidence }
          : request.postDataJSON().phase === 'evidence'
            ? { status: 'evidence', enhancementRequired: true, evidence, citations: [] }
            : { status: 'queued', runId: 'synthetic-run', cancellable: true, evidence, citations: [] } }
      } else if (p.includes('/api/rag/queries/')) {
        if (recoveryMode && !recoveryReady) { status = 503; body = { code: 'SYNTHETIC_CONNECTION_FAILURE' } }
        else if (recoveryMode) body = { data: { status: 'complete', answer: '恢复原任务的回答。', citations: evidence, evidence } }
        else if (request.method() !== 'GET') { cancelled++; body = { data: { status: 'cancelled' } } }
        else body = { data: { status: 'running', runId: 'synthetic-run', cancellable: true, evidence, citations: [] } }
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${base}/search?mode=ask`)
    const input = page.locator('.search-row input')
    await input.waitFor({ timeout: 10000 }).catch(async error => {
      console.error({ url: page.url(), errors, body: (await page.locator('body').innerText()).slice(0, 1800) })
      throw error
    })
    await input.fill('合成借阅期限和续借条件是什么？')
    await page.locator('.search-row button').click()
    await page.getByText(excerpt, { exact: true }).waitFor()
    await page.waitForFunction(() => document.body.innerText.includes('取消'))
    const before = requests.length
    await page.getByRole('button', { name: '打开来源', exact: true }).click()
    await page.waitForURL(`${base}/documents`)
    await page.goBack()
    await page.getByText(excerpt, { exact: true }).waitFor()
    assert.equal(await page.getByText('已保留离开前的原文，本页已停止等待总结。需要总结时可重新提问。', { exact: true }).isVisible(), true)
    assert.equal(await input.inputValue(), '合成借阅期限和续借条件是什么？')
    await page.waitForTimeout(1400)
    assert.equal(requests.length, before, 'Return must not resubmit the question')
    assert.equal(cancelled, 1, 'Leaving must cancel the pending task')
    answerImmediately = true
    await input.fill('再次询问借阅期限')
    await page.locator('.search-row button').click()
    await page.locator('summary').click()
    await page.getByText('可借十四天。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '打开来源', exact: true }).click()
    await page.waitForURL(`${base}/documents`)
    await page.goBack()
    await page.getByText('可借十四天。', { exact: true }).waitFor()
    assert.equal(await input.inputValue(), '再次询问借阅期限')
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state }))
    assert.ok(!storage.includes(excerpt) && !storage.includes('可借十四天。'), 'Evidence and answers stay out of persistent storage/history')
    await page.reload()
    await input.waitFor()
    assert.equal(await page.locator('.rag-evidence-result').count(), 0, 'Reload must not restore private result content')

    answerImmediately = false
    recoveryMode = true
    await input.fill('连接恢复后继续当前问题')
    await page.locator('.search-row button').click()
    await page.getByText('暂时无法读取回答状态', { exact: false }).waitFor()
    assert.equal(await page.getByText(excerpt, { exact: true }).isVisible(), true)
    const beforeRecovery = requests.length
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByText('尚未确认取消', { exact: false }).waitFor()
    assert.equal(await page.getByText('已取消本次提问', { exact: false }).count(), 0)
    recoveryReady = true
    await page.getByRole('button', { name: '继续查询', exact: true }).click()
    await page.locator('summary').click()
    await page.getByText('恢复原任务的回答。', { exact: true }).waitFor()
    assert.equal(requests.length, beforeRecovery, 'Recovery reads the original task, never creates a new one')
    assert.deepEqual(errors, [])
    console.log(`PASS ${width} ${theme}: source navigation/back, memory-only results, reload clears, polling failure, failed cancel, same-task recovery`)
    await context.close()
  }
} finally { await browser.close() }
