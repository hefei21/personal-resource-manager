// Isolated component interaction check; synthetic data only, no Owner API.
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.RAG_TEST_URL || 'http://127.0.0.1:5189'
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
const browser = await chromium.launch({ headless: true,
  ...(process.env.RAG_BROWSER_PATH ? { executablePath: process.env.RAG_BROWSER_PATH } : {}) })
try {
  for (const width of [390, 1280]) for (const dark of [false, true]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.route(`${base}/`, route => route.fulfill({ contentType: 'text/html', body: `
      <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body {margin:16px;background:${dark ? '#232833' : '#fff'};--color-text-primary:${dark ? '#eee' : '#202530'};
      --color-text-secondary:${dark ? '#bbc3d0' : '#526070'};--color-surface-subtle:${dark ? '#303846' : '#eef1f5'};--color-primary:${dark ? '#b3b5ff' : '#5055bf'};}
      </style></head><body><div id="app"></div><script type="module">
      import {createApp} from '/node_modules/.vite_cache/deps/vue.js';
      import View from '/src/components/RagEvidenceResult.vue';
      createApp(View, {result:{partial:true,answer:'有据正文 C1',missingRequirements:['最大层数','<img src=x onerror=alert(1)>'],citations:[{label:'C1',title:'合成来源'}],evidence:[{label:'E1',title:'合成来源',excerpt:'默认值为1',openUrl:'/documents'}]},onOpenCitation:()=>window.opened=true}).mount('#app');
      </script></body></html>` }))
    await page.goto(base)
    await page.getByText('部分回答 · 尚有缺证项', { exact: true }).waitFor({ timeout: 10000 }).catch(error => {
      throw new Error(`${error.message}\n${errors.join('\n')}`)
    })
    assert.equal(await page.getByText('最大层数', { exact: true }).isVisible(), true)
    assert.equal(await page.locator('.answer').isVisible(), false)
    assert.equal(await page.locator('img').count(), 0, 'Missing requirements must be escaped text')
    await page.locator('summary').click()
    assert.equal(await page.locator('.answer').isVisible(), true)
    await page.getByRole('button', { name: '打开来源' }).click()
    assert.equal(await page.evaluate(() => window.opened), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
    await page.unroute(`${base}/`)
    await page.route(`${base}/`, route => route.fulfill({ contentType: 'text/html', body: `
      <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module">
      import {createApp,h} from '/node_modules/.vite_cache/deps/vue.js';
      import View from '/src/components/RagEvidenceResult.vue';
      import {useRagQuery} from '/src/composables/useRagQuery.js';
      createApp({components:{View},setup(){
        const response=data=>({status:200,data:{data}});
        const api={createQuery:async(payload,options)=>{
          if(payload.phase==='evidence') return response({status:'evidence',enhancementRequired:true,evidence:[{label:'E1',title:'合成来源',excerpt:'等待时原文仍可阅读'}],citations:[]});
          window.waitSignal=options.signal;
          return new Promise(resolve=>window.finishWait=()=>resolve(response({status:'answered',answer:'迟到总结不应显示',evidence:[],citations:[]})));
        }};
        const query=useRagQuery({api,errorLabel:()=> '失败',normalizeResult:x=>x});
        query.submit({q:'合成问题'});
        return ()=>h('main',[h('p',{role:'status'},query.state.value),h('button',{onClick:query.cancel,disabled:!query.cancellable.value},'取消增强'),query.result.value?h(View,{result:query.result.value}):null]);
      }}).mount('#app');
      </script></body></html>` }))
    await page.goto(base)
    await page.getByText('enhancing', { exact: true }).waitFor()
    assert.equal(await page.getByText('等待时原文仍可阅读', { exact: true }).isVisible(), true)
    assert.equal(await page.locator('summary').count(), 0)
    await page.getByRole('button', { name: '取消增强' }).click()
    assert.equal(await page.evaluate(() => window.waitSignal.aborted), true)
    await page.evaluate(() => window.finishWait())
    await page.getByText('cancelled', { exact: true }).waitFor()
    assert.equal(await page.getByText('等待时原文仍可阅读', { exact: true }).isVisible(), true)
    assert.equal(await page.locator('summary').count(), 0)
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('Partial component and enhancement cancellation: desktop/mobile × light/dark; visible gaps, collapsed answer, escaping, citation interaction and retained preview passed')
} finally { await browser.close() }
