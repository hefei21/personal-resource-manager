// Isolated Vue component/DOM contracts, using synthetic HTTP responses only.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.CONTROLS_TEST_URL || 'http://127.0.0.1:5187'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
const out = process.env.CONTROLS_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'form-controls-'))
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.THEME_BROWSER_PATH ? { executablePath: process.env.THEME_BROWSER_PATH } : {}) })
const checks = [], errors = []
try {
  for (const width of [390, 1440]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme, reducedMotion: 'reduce' })
    await context.route(`${base}/api/**`, route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/auth/check'
      ? { authenticated: true, user: { username: 'fixture', principal: 'owner', isGuest: false } }
      : { data: [], total: 0 } }))
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${base}/dashboard`)
    await page.locator('.fixed-header').waitFor()
    await page.evaluate(async () => {
      const vueUrl = performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname.endsWith('/deps/vue.js'))
      const { createApp, h, reactive, ref } = await import(vueUrl)
      const modules = await Promise.all(['NativeForm','NativeFormItem','NativeInput','NativeTextarea','NativeSelect','NativeTabs','NativeTabPanel','NativeTreeSelect','NativeDateRangePicker','NativePopconfirm','NativeButton','NativeDialog','NativeRadioGroup','NativeRadio','NativeCheckbox','NativeTagInput','NativePagination','NativeSwitch','NativeTable','NativeProgress','NativeDrawer'].map(name => import(`/src/components/native/${name}.vue`)))
      const [Form, Item, Input, Textarea, Select, Tabs, Panel, TreeSelect, DateRange, Popconfirm, Button, Dialog, RadioGroup, Radio, Checkbox, Tags, Pagination, Switch, Table, Progress, Drawer] = modules.map(m => m.default)
      document.querySelector('#app').__vue_app__.unmount()
      const host = document.createElement('div'); host.style.cssText = 'padding:24px;max-width:700px'; document.body.append(host)
      const s = reactive({ title: '', description: '', selected: [0], single: 0, disabled: false, filterable: false, tree: 0, dates: [], tab1: 'a', tab2: 'a', dialog: false, radio: 'a', radioChanges: 0, checked: false, tags: ['保留','移除'], page: 5, switched: false, submits: 0, confirms: 0, rows: [], sortKey: '', sortOrder: '', drawer: false })
      const form = ref()
      window.controlsFixture = { state: s, validate: () => form.value.validate() }
      const options = [{ value: 0, label: '未分类' }, { value: 1, label: '日常' }, { value: 2, label: '不可用', disabled: true }]
      const item = (label, child, props = {}) => h(Item, { label, ...props }, { default: () => child })
      const treeData = [{ value: 0, label: '根分类', children: [{ value: 1, label: '子分类' }] }]
      const tabs = (id, key) => h(Tabs, { id, modelValue: s[key], 'onUpdate:modelValue': v => { s[key] = v } }, { default: () => ['a','b','c'].map(name => h(Panel, { name, label: `${id}-${name}`, disabled: name === 'b' }, { default: () => `内容 ${name}` })) })
      createApp({ render: () => h(Form, { ref: form, modelValue: s, onSubmit: () => { s.submits++ }, rules: { title: [{ required: true, message: '请输入标题' }] } }, {
        default: () => [
          item('标题', h(Input, { modelValue: s.title, 'onUpdate:modelValue': v => { s.title = v } }), { name: 'title', required: true, tips: '这是提示' }),
          item('简介', h(Textarea, { modelValue: s.description, 'onUpdate:modelValue': v => { s.description = v }, maxlength: 12, name: 'description' })),
          item('分类', h(Select, { options, modelValue: s.single, 'onUpdate:modelValue': v => { s.single = v }, filterable: s.filterable, disabled: s.disabled })),
          item('标签', h(Select, { options, multiple: true, modelValue: s.selected, 'onUpdate:modelValue': v => { s.selected = v }, disabled: s.disabled })),
          item('多输入', [h(Input, { 'aria-label': '开始', id: 'explicit-start' }), h(Input, { 'aria-label': '结束' })]),
          h('p', { id: 'explicit-help' }, '自定义提示'),
          item('默认标题', h(Textarea, { 'aria-label': '自定义名称', 'aria-describedby': 'explicit-help', maxlength: 20 })),
          item('树分类', h(TreeSelect, { data: treeData, modelValue: s.tree, 'onUpdate:modelValue': v => { s.tree = v }, filterable: true, disabled: s.disabled })),
          h(DateRange, { modelValue: s.dates, 'onUpdate:modelValue': v => { s.dates = v } }),
          tabs('one', 'tab1'), tabs('two', 'tab2'),
          h(RadioGroup, { modelValue: s.radio, 'onUpdate:modelValue': v => { s.radio = v; s.radioChanges++ }, disabled: s.disabled }, { default: () => ['a','b','c'].map(value => h(Radio, { value, disabled: value === 'b' }, { default: () => `单选${value}` })) }),
          h(Checkbox, { modelValue: s.checked, 'onUpdate:modelValue': v => { s.checked = v }, disabled: s.disabled }, { default: () => '复选' }),
          item('输入标签', h(Tags, { modelValue: s.tags, 'onUpdate:modelValue': v => { s.tags = v }, disabled: s.disabled })),
          h(Pagination, { total: 300, current: s.page, pageSize: 10, 'onUpdate:current': v => { s.page = v } }),
          h(Switch, { label: '均衡器', modelValue: s.switched, 'onUpdate:modelValue': v => { s.switched = v }, disabled: s.disabled }),
          h(Table, { dataSource: [{ id: 2, name: '第二项' }, { id: 0, name: '零号项' }], columns: [{ key: 'name', title: '名称', sorter: true }], selectable: true, selectedKeys: s.rows, 'onUpdate:selectedKeys': v => { s.rows = v }, sortKey: s.sortKey, 'onUpdate:sortKey': v => { s.sortKey = v }, sortOrder: s.sortOrder, 'onUpdate:sortOrder': v => { s.sortOrder = v } }),
          h(Progress, { percentage: 125, 'aria-label': '上传进度' }),
          h(Button, { onClick: () => { s.drawer = true } }, { default: () => '打开抽屉' }),
          h(Drawer, { modelValue: s.drawer, 'onUpdate:modelValue': v => { s.drawer = v }, title: '详情测试' }, { default: () => h(Button, { onClick: () => { s.dialog = true } }, { default: () => '抽屉内编辑' }) }),
          h(Button, { onClick: () => { s.dialog = true } }, { default: () => '打开编辑' }),
          h(Dialog, { modelValue: s.dialog, 'onUpdate:modelValue': v => { s.dialog = v }, title: '编辑测试', footer: false }, { default: () => [
            item('弹窗分类', h(TreeSelect, { data: treeData, filterable: true, modelValue: s.tree, 'onUpdate:modelValue': v => { s.tree = v } })),
            item('弹窗标签', h(Select, { options, multiple: true, filterable: true, filterPlaceholder: '搜索弹窗标签', modelValue: s.selected, 'onUpdate:modelValue': v => { s.selected = v } })),
            h(Popconfirm, { content: '确认测试', onConfirm: () => { s.confirms++ } }, { trigger: () => h(Button, null, { default: () => '删除测试' }) })
          ] })
        ]
      }) }).mount(host)
    })
    const title = page.getByRole('textbox', { name: '标题', exact: true })
    assert.equal(await title.count(), 1)
    await page.locator('label').filter({ hasText: /^标题/ }).click()
    assert.ok(await title.evaluate(e => e === document.activeElement))
    assert.equal(await title.getAttribute('aria-required'), 'true')
    assert.equal(await page.evaluate(() => window.controlsFixture.validate()), false)
    assert.equal(await title.getAttribute('aria-invalid'), 'true')
    assert.equal(await title.evaluate(e => document.getElementById(e.getAttribute('aria-describedby')).textContent.trim()), '请输入标题')
    await title.fill('已填写')
    assert.equal(await page.evaluate(() => window.controlsFixture.validate()), true)
    assert.equal(await title.getAttribute('aria-invalid'), null)
    const description = page.getByRole('textbox', { name: '简介', exact: true })
    await description.fill('测试简介')
    assert.equal(await description.getAttribute('name'), 'description')
    assert.equal(await page.getByRole('textbox', { name: '自定义名称' }).getAttribute('aria-describedby'), 'explicit-help')
    assert.equal(await page.getByRole('textbox', { name: '开始', exact: true }).getAttribute('id'), 'explicit-start')
    assert.equal(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(e => e.id); return ids.length === new Set(ids).size }), true)
    const single = page.getByRole('combobox', { name: '分类', exact: true })
    await single.click()
    await page.getByRole('option', { name: '日常', exact: true }).click()
    assert.equal(await page.evaluate(() => window.controlsFixture.state.single), 1)
    await page.evaluate(() => { window.controlsFixture.state.filterable = true })
    await page.locator('.native-select--filterable').waitFor()
    await single.click()
    await page.waitForFunction(() => document.querySelector('.native-select--filterable [role="combobox"]')?.getAttribute('aria-expanded') === 'true')
    await page.getByRole('option', { name: '未分类', exact: true }).click()
    assert.equal(await page.evaluate(() => window.controlsFixture.state.single), 0)
    const multi = page.getByRole('combobox', { name: '标签', exact: true })
    await multi.click()
    await page.getByRole('option', { name: '日常', exact: true }).click()
    await page.evaluate(() => { window.controlsFixture.state.disabled = true })
    await page.getByRole('listbox').waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('button', { name: /^移除/ }).count(), 0)
    assert.deepEqual(await page.evaluate(() => window.controlsFixture.state.selected), [0, 1])
    assert.equal(await multi.getAttribute('aria-disabled'), 'true')
    assert.equal(await page.getByRole('checkbox', { name: '复选', exact: true }).getAttribute('tabindex'), '-1')
    assert.equal(await page.getByRole('switch', { name: '均衡器' }).getAttribute('tabindex'), '-1')
    await page.evaluate(() => { window.controlsFixture.state.disabled = false })
    const tree = page.getByRole('combobox', { name: '树分类', exact: true })
    await tree.focus(); await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '展开 根分类', exact: true }).click()
    await page.getByRole('button', { name: '子分类', exact: true }).focus(); await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.controlsFixture.state.tree), 1)
    assert.ok(await tree.evaluate(e => e === document.activeElement))
    const date = page.locator('.native-date-range-picker__trigger')
    await date.focus(); await page.keyboard.press('Enter')
    const calendar = page.getByRole('dialog', { name: '日期范围' })
    await calendar.locator('.native-date-range-picker__day').nth(10).click()
    await calendar.locator('.native-date-range-picker__day').nth(12).click()
    await calendar.getByRole('button', { name: '确定', exact: true }).click()
    assert.equal(await page.evaluate(() => window.controlsFixture.state.dates.filter(Boolean).length), 2)
    assert.ok(await date.evaluate(e => e === document.activeElement))
    const secondTabs = page.locator('#two')
    await secondTabs.getByRole('tab', { name: 'two-a' }).focus(); await page.keyboard.press('ArrowRight')
    assert.equal(await secondTabs.getByRole('tab', { name: 'two-c' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#one').getByRole('tab', { name: 'one-a' }).getAttribute('aria-selected'), 'true')
    assert.equal(await secondTabs.getByRole('tabpanel', { name: 'two-c' }).count(), 1)
    await page.getByRole('radio', { name: '单选a', exact: true }).focus(); await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => window.controlsFixture.state.radio), 'c')
    assert.equal(await page.evaluate(() => window.controlsFixture.state.radioChanges), 1)
    await page.getByRole('button', { name: '移除 移除', exact: true }).focus(); await page.keyboard.press('Enter')
    assert.deepEqual(await page.evaluate(() => window.controlsFixture.state.tags), ['保留'])
    assert.equal(await page.getByRole('navigation', { name: '分页', exact: true }).locator('[aria-current="page"]').textContent().then(t => t.trim()), '5')
    await page.getByRole('checkbox', { name: '选择第 2 行' }).focus(); await page.keyboard.press('Space')
    assert.deepEqual(await page.evaluate(() => window.controlsFixture.state.rows), [0])
    assert.equal((await page.locator('.native-table__row--selected').innerText()).trim(), '零号项')
    const sortHeader = page.getByRole('columnheader', { name: '名称' })
    await sortHeader.focus(); await page.keyboard.press('Enter')
    assert.equal(await sortHeader.getAttribute('aria-sort'), 'descending')
    await page.keyboard.press('Space')
    assert.equal(await sortHeader.getAttribute('aria-sort'), 'ascending')
    assert.equal(await page.getByRole('progressbar', { name: '上传进度' }).getAttribute('aria-valuenow'), '100')
    await page.getByRole('button', { name: '打开编辑', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '编辑测试', exact: true })
    await dialog.getByRole('combobox', { name: '弹窗分类', exact: true }).click()
    const modalSearch = page.getByRole('textbox', { name: '搜索分类', exact: true })
    await modalSearch.fill('根')
    assert.ok(await modalSearch.evaluate(e => e === document.activeElement), 'portal search keeps keyboard focus')
    await page.getByRole('button', { name: '根分类', exact: true }).click()
    assert.ok(await dialog.isVisible())
    await dialog.getByRole('combobox', { name: '弹窗标签', exact: true }).click()
    const tagSearch = page.getByPlaceholder('搜索弹窗标签', { exact: true })
    await tagSearch.fill('日')
    assert.ok(await tagSearch.evaluate(e => e === document.activeElement), 'multi-select portal keeps keyboard focus')
    await page.keyboard.press('Escape')
    const opener = dialog.getByRole('button', { name: '删除测试', exact: true })
    await opener.focus(); await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: '删除测试', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.ok(await dialog.isVisible())
    assert.ok(await opener.evaluate(e => e === document.activeElement))
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    assert.equal(await page.evaluate(() => window.controlsFixture.state.submits), 0)
    assert.equal(await page.evaluate(() => window.controlsFixture.state.confirms), 0)
    await page.getByRole('button', { name: '打开抽屉', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: '详情测试', exact: true })
    await drawer.getByRole('button', { name: '抽屉内编辑', exact: true }).click()
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.ok(await drawer.isVisible())
    await drawer.getByRole('button', { name: '关闭', exact: true }).focus(); await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
    checks.push({ width, colorScheme, labels: true, feedback: true, uniqueIds: true, selectDisabled: true, tabs: true, radio: true, tree: true, date: true, table: true, progress: true, nestedPopover: true, nestedDrawer: true })
    await page.screenshot({ path: join(out, `${width}-${colorScheme}.png`) })
    await context.close()
  }
  assert.deepEqual(errors, [])
} finally {
  await writeFile(join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
  await browser.close()
}
console.log(JSON.stringify({ passed: checks.length, errors, out }))
