// Real Vue/browser regression with an entirely synthetic, in-memory API.
// Run against Vite using EBOOK_TEST_URL; install Playwright in an isolated tools
// directory and point PLAYWRIGHT_MODULE at its index.mjs when it is not local.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.EBOOK_TEST_URL || 'http://127.0.0.1:5178'
const output = process.env.EBOOK_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'ebook-browser-'))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.EBOOK_BROWSER_PATH ? { executablePath: process.env.EBOOK_BROWSER_PATH } : {}) })
const errors = [], checks = [], writes = []
const progress = new Map()
const books = Array.from({ length: 49 }, (_, i) => ({ id: i + 1, title: ['漫步城市：生活的细节', '纸上的远行', '写给明天的信', '窗边的四季'][i % 4] + ` · ${i + 1}`, author: ['林岚', '顾川', '乔木', '陆遥'][i % 4], categoryId: i % 3 + 1, categoryName: ['随笔', '文学', '设计'][i % 3], fileType: i === 1 ? 'pdf' : i === 2 ? 'txt' : 'epub', coverImage: i % 4 !== 2, fileSize: 20480, progress: i === 0 ? 22 : 0, indexStatus: 'ready', publisher: '合成测试出版社', createdAt: '2026-01-01T00:00:00Z' }))
const categories = Array.from({ length: 32 }, (_, i) => ({ id: i + 1, name: ['随笔', '文学', '设计'][i] || `分类 ${i + 1}`, bookCount: books.filter(book => book.categoryId === i + 1).length }))
books[1].title = '这是一段用来验证移动端长书名换行后阅读进度仍然对齐的书籍标题'
const chapters = Array.from({ length: 12 }, (_, i) => ({ id: `chapter-${i}`, href: `Text/ch${i}.xhtml`, title: `第 ${i + 1} 章 · 日常的风景` }))
const content = index => `<h1 id="start">${chapters[index].title}</h1><p><a href="ch8.xhtml#note">跳转第九章注释</a></p>` + Array.from({ length: 65 }, (_, i) => `<p id="p${i}">段落 ${i + 1}。清晨的光沿着窗台铺开，街道从沉静中醒来。我们记录行走时遇见的细节，也记录那些尚未说出口的故事。阅读并不是赶路，而是看清沿途的风景。</p>`).join('') + '<h2 id="note">注释定位目标</h2><p>这里是章节内部的注释位置。</p>'
function pdfFixture() {
  const text = 'BT /F1 24 Tf 60 700 Td (A quiet reading test) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`]
  let result = '%PDF-1.4\n'; const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(result)
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(result)
}
let failNextPage = false, offlineWrites = false, delayChapter = -1, uploadedBody = '', delayListMs = 0
async function apiRoute(route) {
  const request = route.request(), url = new URL(request.url()), path = url.pathname
  if (!path.startsWith('/api/')) return route.continue()
  const json = (data, status = 200) => route.fulfill({ status, json: data })
  if (path === '/api/auth/check') return json({ authenticated: true, user: { username: 'reader', principal: 'owner', isGuest: false } })
  if (path === '/api/documents') return json({ data: [{ id: 101, title: '合成文档验收', filePath: 'fixture.txt', size: 128, version: 1, tags: [], category: '文档', createdAt: '2026-01-01', updatedAt: '2026-01-01' }], total: 1 })
  if (path === '/api/documents/categories') return json({ data: [{ id: 1, name: '文档', children: [], documentCount: 1 }] })
  if (path === '/api/ebooks/categories') return json({ data: categories })
  if (path === '/api/ebooks' && request.method() === 'GET') {
    if (delayListMs) await new Promise(resolve => setTimeout(resolve, delayListMs))
    const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('pageSize') || 24)
    if (page > 1 && failNextPage) { failNextPage = false; return json({ message: '测试网络波动' }, 503) }
    let selected = books.filter(book => !book.deleted)
    const category = url.searchParams.get('category'), state = url.searchParams.get('readingStatus'), type = url.searchParams.get('fileType'), keyword = url.searchParams.get('keyword')
    if (category) selected = selected.filter(book => String(book.categoryId || 'uncategorized') === category)
    if (state) selected = selected.filter(book => state === 'reading' ? book.progress > 0 && book.progress < 100 : state === 'finished' ? book.progress >= 100 : !book.progress)
    if (type) selected = selected.filter(book => book.fileType === type)
    if (keyword) selected = selected.filter(book => book.title.includes(keyword) || book.author.includes(keyword))
    return json({ data: selected.slice((page - 1) * size, page * size), pagination: { page, pageSize: size, total: selected.length, totalPages: Math.max(1, Math.ceil(selected.length / size)) } })
  }
  const match = /^\/api\/ebooks\/(\d+)(?:\/(.*))?$/.exec(path)
  if (match) {
    const id = Number(match[1]), kind = match[2], book = books.find(item => item.id === id)
    if (kind === 'cover') {
      const colors = ['#dad6c8', '#556b69', '#e8dfcf', '#8a5c4c']; const foreground = id % 4 === 1 || id % 4 === 3 ? '#f9f4e7' : '#334340'
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="${colors[id % 4]}"/><path d="M30 500 Q200 160 370 480 M30 520 Q170 180 370 500" fill="none" stroke="${foreground}" stroke-width="1" opacity=".4"/><text x="38" y="95" font-size="18" fill="${foreground}">COLLECTED MOMENTS</text><text x="38" y="200" font-size="38" fill="${foreground}">${['漫步城市', '纸上的远行', '写给明天', '窗边四季'][id % 4]}</text><text x="38" y="550" font-size="17" fill="${foreground}">合成验收 · ${id}</text></svg>` })
    }
    if (kind === 'detail') return json({ data: { ...book, ...(progress.has(id) ? { progress: progress.get(id).progress } : {}) } })
    if (kind === 'chapters') {
      if (url.searchParams.has('manifest')) return json({ chapters, toc: chapters.map((chapter, index) => ({ ...chapter, chapterIndex: index })) })
      const start = Number(url.searchParams.get('start') || 0)
      if (start === delayChapter) await new Promise(resolve => setTimeout(resolve, 600))
      const notes = '<p>注释样式 <a href="#note"><sup>(10)</sup></a> 与 <sup><a href="#note">11</a></sup>，普通序号 <a href="#note">[12]</a>；<a role="doc-noteref" href="#note">注</a>。<a href="https://example.com">普通外部链接</a></p>'
      return json({ chapters: [{ ...chapters[start], content: notes + content(start) }] })
    }
    if (kind === 'content') return json({ content: '写给明天的信\n\n' + '合成文本阅读测试。\n'.repeat(180) })
    if (kind === 'preview') return route.fulfill({ contentType: 'application/pdf', body: pdfFixture() })
    if (kind === 'progress') {
      const previous = progress.get(id) || { currentPage: 0, progress: 0, chapterFraction: 0, cfi: null, revision: 0 }
      if (request.method() === 'GET') return json(previous)
      if (offlineWrites) return route.abort('internetdisconnected')
      const input = request.postDataJSON()
      if (input.revision !== previous.revision && !input.force) return json({ code: 'EBOOK_PROGRESS_CONFLICT', latest: previous }, 409)
      const next = { ...input, revision: previous.revision + 1 }
      progress.set(id, next); book.progress = next.progress; writes.push({ id, ...input })
      return json({ data: next })
    }
    if (!kind && request.method() === 'PUT') { Object.assign(book, request.postDataJSON()); return json({ data: book }) }
    if (!kind && request.method() === 'DELETE') { book.deleted = true; return json({ success: true }) }
  }
  if (path === '/api/ebooks/upload') { uploadedBody = request.postDataBuffer().toString(); return json({ success: true, id: 90 }) }
  return json({ data: [], total: 0 })
}
async function makePage(viewport, mobile = false) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
  await context.route('**/api/**', apiRoute)
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', async message => {
    if (message.type() !== 'error') return
    console.error('browser:', message.text())
    for (const argument of message.args()) {
      const details = await argument.evaluate(value => value instanceof Error ? { cause: String(value.cause || ''), fallback: String(value.fallbackError || '') } : null).catch(() => null)
      if (details?.cause || details?.fallback) console.error('browser error details:', details)
    }
  })
  await page.goto(`${base}/books`)
  try { await page.locator(mobile ? '.mobile-book' : '.ebook-card').first().waitFor() }
  catch (error) { await page.screenshot({ path: join(output, 'startup-failure.png') }); console.error(await page.locator('body').innerText(), errors); throw error }
  await page.locator('.global-loading-overlay').waitFor({ state: 'hidden' })
  await page.waitForTimeout(250)
  return page
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`) }
async function noOverflow(page) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal page overflow') }
async function readerReady(page) { await page.locator('.ebook-reader__flow').waitFor(); await page.waitForFunction(() => document.querySelector('.ebook-reader__surface')?.scrollHeight > 1000); await page.waitForTimeout(150) }
async function openPcReader(page) { await page.locator('.ebook-card').first().hover(); await page.locator('.ebook-card__read').first().click(); await readerReady(page) }
try {
  const mobile = await makePage({ width: 390, height: 844 }, true)
  await check('mobile hierarchy, touch targets and first page', async () => {
    assert.equal(await mobile.locator('.mobile-book').count(), 24)
    assert.equal(await mobile.locator('.mobile-book').getByText('可问').count(), 0)
    assert.ok((await mobile.getByLabel('上传书籍', { exact: true }).boundingBox()).width >= 44)
    assert.ok((await mobile.locator('.mobile-book__more').first().boundingBox()).width >= 44)
    await noOverflow(mobile)
    await mobile.screenshot({ path: join(output, 'mobile-library.png'), fullPage: false })
  })
  await check('mobile progress baselines survive long titles and enlarged unclamped text', async () => {
    const style = await mobile.addStyleTag({ content: '.mobile-book__heading>button:first-child { -webkit-line-clamp:unset!important; font-size:20px!important }' })
    for (const width of [360, 390, 768]) {
      await mobile.setViewportSize({ width, height: 900 })
      const positions = await mobile.locator('.mobile-book').evaluateAll(items => items.slice(0, 6).map(el => ({ top: el.getBoundingClientRect().top, progress: el.querySelector('.mobile-book__progress').getBoundingClientRect().y })))
      for (const item of positions) for (const other of positions) if (Math.abs(item.top - other.top) < 1) assert.ok(Math.abs(item.progress - other.progress) < 1, 'same-row progress baseline')
    }
    await style.evaluate(el => el.remove())
    await mobile.setViewportSize({ width: 390, height: 844 })
  })
  await check('mobile paging keeps rows on failure and supports retry', async () => {
    failNextPage = true
    await mobile.getByRole('button', { name: '加载下一批' }).click()
    await mobile.getByText('测试网络波动，点击重试').waitFor()
    assert.equal(await mobile.locator('.mobile-book').count(), 24)
    await mobile.getByText('测试网络波动，点击重试').click()
    await mobile.waitForFunction(() => document.querySelectorAll('.mobile-book').length === 48)
    await mobile.getByRole('button', { name: '加载下一批' }).click()
    await mobile.getByText('共 49 本 · 已加载全部').waitFor()
  })
  await check('category counts, filters and upload eligibility', async () => {
    await mobile.locator('.mobile-books__category').click()
    await mobile.getByRole('button', { name: '随笔 17 本' }).click()
    await mobile.waitForFunction(() => document.querySelectorAll('.mobile-book').length === 17)
    assert.equal(await mobile.getByLabel('上传书籍', { exact: true }).count(), 0)
    await mobile.locator('.mobile-books__category').click()
    await mobile.getByRole('button', { name: '全部分类', exact: true }).click()
    await mobile.getByRole('button', { name: '未开始', exact: true }).click()
    assert.equal(await mobile.getByLabel('上传书籍', { exact: true }).count(), 0)
    await mobile.getByRole('button', { name: '全部', exact: true }).click()
    await mobile.getByLabel('上传书籍', { exact: true }).waitFor()
  })
  await check('details sheet contains index status and only mobile-safe actions', async () => {
    await mobile.locator('.mobile-book__more').first().click()
    await mobile.getByRole('button', { name: '编辑信息', exact: true }).waitFor({ state: 'visible' })
    await mobile.getByText('可问', { exact: true }).waitFor()
    await mobile.waitForTimeout(250)
    assert.ok(await mobile.evaluate(() => document.elementFromPoint(30, 20)?.closest('.native-drawer')), 'sheet mask must cover fixed app navigation')
    assert.ok(await mobile.locator('.mobile-book-detail h3').evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + 5, r.y + 5)) }), 'book decorations must not overlay the sheet')
    assert.equal(await mobile.locator('.mobile-books-sheet .native-drawer__content').evaluate(el => getComputedStyle(el).borderTopLeftRadius), '18px')
    assert.equal(await mobile.getByRole('button', { name: '重解析元数据' }).count(), 0)
    await mobile.screenshot({ path: join(output, 'mobile-details.png') })
    await mobile.getByRole('button', { name: '编辑信息', exact: true }).click()
    await mobile.getByRole('dialog', { name: '编辑书籍信息' }).waitFor()
    await noOverflow(mobile)
    const edit = mobile.getByRole('dialog', { name: '编辑书籍信息' })
    await edit.locator('input').first().fill('调整书名后的合成书籍')
    await edit.getByRole('button', { name: '确定', exact: true }).click()
    await edit.waitFor({ state: 'hidden' })
    assert.equal(books[0].publisher, '合成测试出版社', 'editing a visible field must preserve hidden metadata')
    assert.equal(books[0].title, '调整书名后的合成书籍')
  })
  await check('mobile upload uses selectable categories inside the dialog', async () => {
    await mobile.getByLabel('上传书籍', { exact: true }).click()
    const dialog = mobile.getByRole('dialog', { name: '上传书籍' })
    await dialog.locator('input[type=file]').setInputFiles({ name: '河畔随笔.txt', mimeType: 'text/plain', buffer: Buffer.from('一段合成的阅读文字。') })
    await dialog.getByPlaceholder('书籍名称', { exact: true }).fill('河畔随笔')
    await dialog.getByRole('combobox').click()
    await mobile.getByRole('option', { name: '文学', exact: true }).click()
    await noOverflow(mobile)
    await mobile.screenshot({ path: join(output, 'mobile-upload.png') })
    await dialog.getByRole('button', { name: '上传书籍', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.match(uploadedBody, /河畔随笔/u)
    assert.match(uploadedBody, /name="categoryId"\r\n\r\n2/u)
  })
  await check('mobile EPUB resume and internal link navigation', async () => {
    await mobile.locator('.mobile-book__cover').first().click(); await readerReady(mobile)
    await mobile.getByRole('link', { name: '跳转第九章注释' }).click()
    await mobile.waitForFunction(() => document.querySelector('.ebook-reader__flow')?.dataset.chapterId === 'chapter-8')
    await mobile.waitForFunction(() => document.querySelector('.ebook-reader__surface').scrollTop > 1000)
    await mobile.locator('.ebook-reader__surface').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) * .43 })
    await mobile.waitForTimeout(1000)
    const saved = progress.get(1); assert.equal(saved.currentPage, 8); assert.ok(Math.abs(saved.chapterFraction - .43) < .02)
    await mobile.getByLabel('关闭阅读器', { exact: true }).click()
    await mobile.locator('.ebook-reader').waitFor({ state: 'detached' })
    await mobile.locator('.mobile-book__cover').first().click(); await readerReady(mobile)
    assert.equal(await mobile.locator('.ebook-reader__flow').getAttribute('data-chapter-id'), 'chapter-8')
    assert.ok(await mobile.locator('.ebook-reader__surface').evaluate(el => el.scrollTop / (el.scrollHeight - el.clientHeight) > .35))
    await mobile.getByLabel('打开或关闭目录').click()
    const active = mobile.locator('.ebook-reader__toc-list button.active')
    assert.ok(await active.isVisible()); await active.click(); await readerReady(mobile)
    await mobile.screenshot({ path: join(output, 'mobile-reader.png') })
    const surface = await mobile.locator('.ebook-reader__surface').boundingBox(), footer = await mobile.locator('.ebook-reader__footer').boundingBox()
    assert.ok(Math.abs(surface.y + surface.height - footer.y) <= 1)
    await mobile.getByLabel('关闭阅读器', { exact: true }).click()
  })
  await check('mobile PDF renders locally and resizes with orientation', async () => {
    await mobile.locator('.mobile-book__cover').nth(1).click()
    await mobile.waitForFunction(() => document.querySelector('.ebook-reader__pdf-canvas')?.width > 100)
    await mobile.waitForTimeout(250)
    const portraitCanvas = await mobile.locator('canvas').boundingBox()
    assert.ok(portraitCanvas.x >= 0 && portraitCanvas.x + portraitCanvas.width <= 391, `PDF overflow: ${JSON.stringify(portraitCanvas)}`)
    const pixels = await mobile.locator('canvas').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data).some((v, i) => i % 4 !== 3 && v < 150))
    assert.ok(pixels, 'PDF must contain drawn text, not only a blank canvas')
    await mobile.screenshot({ path: join(output, 'mobile-pdf.png') })
    await mobile.locator('canvas').click({position:{x:60,y:60}})
    await mobile.locator('.ebook-reader__header').waitFor({state:'hidden'})
    await mobile.waitForTimeout(150)
    await mobile.locator('canvas').click({position:{x:60,y:60}})
    await mobile.locator('.ebook-reader__header').waitFor({state:'visible'})
    await mobile.setViewportSize({ width: 740, height: 390 }); await mobile.waitForTimeout(500)
    const canvas = await mobile.locator('canvas').boundingBox(); assert.ok(canvas.width > 500 && canvas.width <= 740)
    await mobile.getByLabel('关闭阅读器', { exact: true }).click()
    await mobile.setViewportSize({ width: 390, height: 844 })
  })
  const pc = await makePage({ width: 1440, height: 1000 })
  await check('PC category actions stay within their own row on hover and keyboard focus', async () => {
    const row = pc.locator('.ebook-category-row').first()
    await row.hover()
    const bounds = await row.boundingBox(), actions = await row.locator('.category-actions').boundingBox()
    assert.ok(actions.y >= bounds.y && actions.y + actions.height <= bounds.y + bounds.height)
    await pc.screenshot({ path: join(output, 'pc-category-hover.png') })
    await row.getByTitle('重命名分类').focus()
    assert.equal(await row.locator('.category-actions').evaluate(el => getComputedStyle(el).pointerEvents), 'auto')
  })
  await check('PC skeleton cover geometry matches loaded covers at desktop and 4K widths', async () => {
    for (const width of [1440, 3840]) {
      await pc.setViewportSize({ width, height: 1100 })
      delayListMs = 700
      await pc.reload()
      await pc.locator('.ebook-loading-card__cover').first().waitFor()
      const placeholders = await pc.locator('.ebook-loading-card__cover').evaluateAll(items => items.slice(0, 4).map(el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height } }))
      if (width === 3840) await pc.screenshot({ path: join(output, 'pc-loading-4k.png') })
      delayListMs = 0
      await pc.locator('.ebook-card__read').first().waitFor({state:'attached'})
      const covers = await pc.locator('.ebook-card__cover').evaluateAll(items => items.slice(0, 4).map(el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height } }))
      placeholders.forEach((item, i) => { for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(item[key] - covers[i][key]) < 1, `${width}px skeleton ${key}`) })
      await noOverflow(pc)
    }
    await pc.setViewportSize({ width: 1440, height: 1000 })
  })
  await check('PC reading actions appear over covers on hover or keyboard focus without reflow', async () => {
    await pc.mouse.move(0, 0)
    const card = pc.locator('.ebook-card').first(), action = card.locator('.ebook-card__read')
    await action.waitFor({state:'hidden'})
    const before = await card.boundingBox(), progressBefore = await card.locator('.ebook-card__progress').boundingBox()
    await pc.screenshot({path:join(output,'pc-covers-idle.png')})
    await card.hover(); await pc.waitForTimeout(220)
    assert.ok(await action.isVisible())
    const cover = await card.locator('.ebook-card__cover').boundingBox(), button = await action.boundingBox()
    assert.ok(button.y >= cover.y && button.y + button.height <= cover.y + cover.height)
    assert.deepEqual(await card.boundingBox(), before)
    assert.deepEqual(await card.locator('.ebook-card__progress').boundingBox(), progressBefore)
    assert.equal(await pc.locator('.ebook-card').nth(1).locator('.ebook-card__read').isVisible(), false)
    await pc.screenshot({path:join(output,'pc-cover-hover.png')})
    await pc.mouse.move(0, 0); await action.waitFor({state:'hidden'})
    await card.focus(); await action.waitFor({state:'visible'})
    await pc.keyboard.press('Tab')
    assert.ok(await action.evaluate(el => document.activeElement === el))
    await pc.keyboard.press('Enter'); await readerReady(pc)
    await pc.getByLabel('关闭阅读器', {exact:true}).click()
    await pc.emulateMedia({reducedMotion:'reduce'})
    await card.hover()
    assert.ok(await action.evaluate(el => getComputedStyle(el).transitionDuration.split(',').every(value => parseFloat(value) <= .001)))
    await pc.emulateMedia({reducedMotion:'no-preference'})
  })
  await check('PC selection mode, all-page selection and detail stacking', async () => {
    assert.equal(await pc.locator('.ebook-card__select').count(), 0)
    await pc.getByRole('button', { name: '多选', exact: true }).click()
    assert.equal(await pc.getByText('点击卡片选择', { exact: true }).count(), 0)
    assert.equal(await pc.locator('.ebook-card__read').count(), 0)
    await pc.getByRole('button', { name: /全选本页/ }).click()
    assert.equal(await pc.locator('.ebook-card__select input:checked').count(), 24)
    await pc.screenshot({ path: join(output, 'pc-selection.png') })
    await pc.getByRole('button', { name: '退出多选', exact: true }).click()
    await pc.locator('.ebook-card').first().click()
    assert.equal(await pc.locator('.ebook-card__select').count(), 0)
    await pc.getByRole('button', { name: '关闭', exact: true }).last().click()
    await pc.locator('.native-drawer').waitFor({ state: 'hidden' })
    await pc.screenshot({ path: join(output, 'pc-library.png') })
    await noOverflow(pc)
  })
  await check('cross-device restore, fast chapter navigation, no-op close', async () => {
    const saved = progress.get(1), before = writes.length
    await openPcReader(pc)
    assert.equal(await pc.locator('.ebook-reader__flow').getAttribute('data-chapter-id'), `chapter-${saved.currentPage}`)
    await pc.getByLabel('关闭阅读器', { exact: true }).click(); await pc.waitForTimeout(250)
    assert.equal(writes.length, before, 'open/close without reading should not create a revision')
    await openPcReader(pc)
    delayChapter = 9
    await pc.getByLabel('打开或关闭目录').click(); await pc.getByRole('button', { name: /第 10 章 · 日常的风景/ }).click()
    await pc.getByLabel('打开或关闭目录').click(); await pc.getByRole('button', { name: /第 11 章 · 日常的风景/ }).click()
    await pc.waitForTimeout(900)
    assert.equal(await pc.locator('.ebook-reader__flow').getAttribute('data-chapter-id'), 'chapter-10')
    await pc.screenshot({ path: join(output, 'pc-reader.png') })
    await pc.getByLabel('关闭阅读器', { exact: true }).click()
  })
  await check('reader tools follow reading column; footnotes stay quiet but clickable', async () => {
    await pc.setViewportSize({ width: 3840, height: 1920 })
    await openPcReader(pc)
    const topbar = await pc.locator('.ebook-reader__topbar').boundingBox()
    const toc = await pc.getByLabel('打开或关闭目录').boundingBox()
    const footer = await pc.locator('.ebook-reader__footer').boundingBox()
    assert.ok(topbar.width <= 980 && Math.abs(topbar.x + topbar.width / 2 - 1920) < 1)
    assert.ok(toc.y >= footer.y && toc.y + toc.height <= footer.y + footer.height)
    assert.equal(await pc.locator('.ebook-reader__header').getByLabel('打开或关闭目录').count(), 0)
    const notes = pc.locator('.ebook-reader__flow a[data-reader-note]')
    assert.equal(await notes.count(), 4)
    for (const note of await notes.all()) assert.equal(await note.evaluate(el => getComputedStyle(el).textDecorationLine), 'none')
    assert.equal(await pc.getByText('普通外部链接', { exact:true }).evaluate(el => getComputedStyle(el).textDecorationLine), 'underline')
    await pc.locator('.ebook-reader__surface').evaluate(el => { el.scrollTop = 0 })
    await pc.screenshot({ path: join(output, 'pc-reader-4k.png') })
    await notes.first().click()
    await pc.waitForTimeout(200)
    const target = await pc.locator('#note').boundingBox(), surface = await pc.locator('.ebook-reader__surface').boundingBox()
    assert.ok(target.y >= surface.y && target.y < surface.y + surface.height)
    await pc.getByLabel('关闭阅读器', { exact:true }).click()
    await pc.setViewportSize({ width:1440, height:1000 })
  })
  await check('mobile boundary widths and reduced motion', async () => {
    for (const width of [360, 768]) { await mobile.setViewportSize({ width, height: 900 }); await mobile.waitForTimeout(120); await noOverflow(mobile) }
    await mobile.emulateMedia({ reducedMotion: 'reduce' })
    assert.ok(parseFloat(await mobile.locator('.mobile-book__cover').first().evaluate(el => getComputedStyle(el).transitionDuration)) <= .001)
  })
  await check('mobile panels fit the viewport and meet the actual header without a gap', async () => {
    await mobile.setViewportSize({ width:390, height:844 })
    await mobile.locator('.mobile-book__cover').first().click(); await readerReady(mobile)
    const enlargedHeader = await mobile.addStyleTag({ content: '.ebook-reader__header{padding-top:24px!important}' })
    for (const width of [320,390,768]) {
      await mobile.setViewportSize({ width, height:844 })
      for (const [label, selector, close] of [['打开或关闭目录','.ebook-reader__toc','关闭目录'],['阅读设置','.ebook-reader__settings','关闭阅读设置']]) {
        await mobile.getByLabel(label, { exact:true }).click()
        await mobile.waitForTimeout(250)
        const header = await mobile.locator('.ebook-reader__header').boundingBox(), panel = await mobile.locator(selector).boundingBox()
        assert.ok(Math.abs(panel.y - header.y - header.height) < 1, 'panel touches actual header')
        assert.ok(panel.width <= width * .77 && panel.width <= 320, 'panel leaves reading context exposed')
        assert.ok(await mobile.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'panel content does not overflow')
        if (width === 390) await mobile.screenshot({path:join(output, selector.includes('settings') ? 'mobile-settings-panel.png' : 'mobile-toc-panel.png')})
        await mobile.getByLabel(close, { exact:true }).click()
      }
    }
    await enlargedHeader.evaluate(el => el.remove())
    await mobile.getByLabel('关闭阅读器', { exact:true }).click()
    await mobile.setViewportSize({width:390,height:844})
  })
  await check('mobile immersive tap restores chrome and ignores selection, drags and links', async () => {
    await mobile.locator('.mobile-book__cover').first().click(); await readerReady(mobile)
    const paragraph = mobile.locator('#p3')
    await paragraph.scrollIntoViewIfNeeded(); await mobile.waitForTimeout(900)
    const before = writes.length
    const top = await mobile.locator('.ebook-reader__surface').evaluate(el => el.scrollTop)
    await paragraph.click()
    await mobile.locator('.ebook-reader__header').waitFor({state:'hidden'})
    assert.equal(await mobile.locator('.ebook-reader__footer').isVisible(), false)
    assert.ok(Math.abs(await mobile.locator('.ebook-reader__surface').evaluate(el => el.scrollTop) - top) < 2)
    await mobile.waitForTimeout(800)
    assert.equal(writes.length, before, 'toggling chrome alone does not write progress')
    await mobile.screenshot({path:join(output,'mobile-immersive.png')})
    await paragraph.click()
    await mobile.locator('.ebook-reader__header').waitFor({state:'visible'})
    await mobile.waitForTimeout(80)
    await paragraph.evaluate(el => { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range); el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,isPrimary:true,button:0})); el.dispatchEvent(new MouseEvent('click',{bubbles:true})); })
    assert.ok(await mobile.locator('.ebook-reader__header').isVisible())
    await mobile.evaluate(() => window.getSelection().removeAllRanges())
    await paragraph.dispatchEvent('pointerdown',{isPrimary:true,button:0,clientX:100,clientY:100})
    await paragraph.dispatchEvent('pointermove',{isPrimary:true,clientX:100,clientY:170})
    await paragraph.dispatchEvent('click')
    assert.ok(await mobile.locator('.ebook-reader__header').isVisible())
    await paragraph.dispatchEvent('pointerdown',{isPrimary:true,button:0})
    await mobile.waitForTimeout(500); await paragraph.dispatchEvent('click')
    assert.ok(await mobile.locator('.ebook-reader__header').isVisible())
    await mobile.getByRole('link',{name:'跳转第九章注释'}).click()
    assert.ok(await mobile.locator('.ebook-reader__header').isVisible())
    await mobile.getByLabel('阅读设置',{exact:true}).click()
    await mobile.getByRole('button',{name:'进入沉浸阅读',exact:true}).click()
    await mobile.locator('.ebook-reader__header').waitFor({state:'hidden'})
    await mobile.waitForTimeout(80)
    assert.ok(await mobile.locator('.ebook-reader').evaluate(el => document.activeElement === el))
    await mobile.keyboard.press('Escape')
    await mobile.locator('.ebook-reader__header').waitFor({state:'visible'})
    await mobile.getByLabel('关闭阅读器',{exact:true}).click()
    await mobile.locator('.mobile-book__cover').first().click(); await readerReady(mobile)
    assert.ok(await mobile.locator('.ebook-reader__header').isVisible(), 'reopen starts with discoverable controls')
    await mobile.getByLabel('关闭阅读器',{exact:true}).click()
  })
  await check('live device conflict requires a choice; offline position resumes on reconnect', async () => {
    await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.locator('.mobile-book__cover').first().click(); await readerReady(mobile)
    await openPcReader(pc)
    await mobile.locator('.ebook-reader__surface').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) * .21 })
    await mobile.waitForTimeout(1000)
    await pc.locator('.ebook-reader__surface').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) * .62 })
    await pc.getByRole('button', { name: '前往其他设备位置', exact: true }).waitFor()
    await pc.getByRole('button', { name: '前往其他设备位置', exact: true }).click()
    await pc.waitForTimeout(300)
    assert.ok(await pc.locator('.ebook-reader__surface').evaluate(el => el.scrollTop / (el.scrollHeight - el.clientHeight) < .35))
    offlineWrites = true
    await mobile.locator('.ebook-reader__surface').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) * .48 })
    await mobile.getByText('当前离线，阅读位置已保存在本机，联网后自动同步。').waitFor()
    assert.ok(await mobile.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('pr-manager:ebook-progress-pending:'))))
    offlineWrites = false
    await mobile.evaluate(() => window.dispatchEvent(new Event('online')))
    await mobile.getByText('当前离线，阅读位置已保存在本机，联网后自动同步。').waitFor({ state: 'hidden' })
    assert.ok(Math.abs(progress.get(1).chapterFraction - .48) < .02)
    await mobile.getByLabel('关闭阅读器', { exact: true }).click()
    await pc.getByLabel('关闭阅读器', { exact: true }).click()
  })
  await check('shared drawer remains usable in the document module', async () => {
    await pc.goto(`${base}/documents`)
    await pc.getByRole('button', { name: '详情', exact: true }).click()
    await pc.locator('.document-detail').waitFor()
    await pc.waitForTimeout(250)
    const title = await pc.locator('.document-detail-hero').boundingBox()
    assert.ok(title.y >= 72)
    assert.ok(await pc.evaluate(() => document.elementFromPoint(30, 20)?.closest('.native-drawer')))
    await pc.keyboard.press('Escape')
    await pc.locator('.native-drawer').waitFor({ state: 'hidden' })
    await noOverflow(pc)
  })
  assert.deepEqual(errors, [], 'browser runtime errors')
  console.log(JSON.stringify({ passed: checks.length, errors, screenshots: output }, null, 2))
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors, writes: writes.length }, null, 2))
  await browser.close()
}
