// Synthetic visual/theme regression against a local Vite dev server; no real backend.
// PLAYWRIGHT_MODULE and THEME_BROWSER_PATH optionally select an isolated browser runtime.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const base=process.env.THEME_TEST_URL || 'http://127.0.0.1:5178'
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname),'Use an isolated local Vite server')
const out=process.env.THEME_TEST_OUTPUT || await mkdtemp(join(tmpdir(),'theme-browser-'))
await mkdir(out,{recursive:true})
const browser=await chromium.launch({headless:true,...(process.env.THEME_BROWSER_PATH?{executablePath:process.env.THEME_BROWSER_PATH}:{})})
const book={id:701,title:'山间书信：关于生活与观察的长篇记录',author:'合成作者',fileType:'txt',fileSize:2048,progress:24,categoryName:'随笔',chapterCount:1}
const document={id:702,title:'项目设计与日常记录',fileType:'txt',fileSize:2048,currentVersion:1,version:1,tags:['设计'],updatedAt:'2026-09-20T08:00:00Z',createdAt:'2026-09-20T08:00:00Z'}
const requests=new Set(), errors=[], results=[]
function contrastAudit(){
 const failures=[]
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true})
 const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);const p=ctx.getImageData(0,0,1,1).data;return [p[0],p[1],p[2],p[3]/255]}
 const blend=(front,back)=>front.slice(0,3).map((v,i)=>v*front[3]+back[i]*(1-front[3]))
 const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)
 for(const e of document.querySelectorAll('body *')){
  const text=[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('');if(!text||e.namespaceURI.includes('svg')||e.closest('[disabled],[aria-disabled="true"]'))continue
  const r=e.getBoundingClientRect(),s=getComputedStyle(e);if(!r.width||!r.height||r.top>innerHeight||r.bottom<0||r.left>innerWidth||s.visibility==='hidden')continue
  let bg=[255,255,255],chain=[],n=e,skip=false
  while(n){const st=getComputedStyle(n);if(Number(st.opacity)<.99||st.backgroundImage!=='none'){skip=true;break}chain.unshift(st.backgroundColor);n=n.parentElement}
  if(skip)continue;for(const color of chain)bg=blend(rgba(color),bg)
  const fg=blend(rgba(s.color),bg),a=lum(fg),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05)
  const min=Number.parseFloat(s.fontSize)>=24||(Number.parseFloat(s.fontSize)>=18.66&&Number(s.fontWeight)>=700)?3:4.5
  if(ratio<min-.05)failures.push({text:text.slice(0,45),class:e.className,ratio:Number(ratio.toFixed(2)),color:s.color,bg:bg.map(Math.round)})
 }
 return failures
}
async function fixture(route){
 const u=new URL(route.request().url()),p=u.pathname;requests.add(p)
 let body={success:true,data:[],total:0,pagination:{page:1,pageSize:20,total:0,totalPages:0}}
 if(p==='/api/auth/check')body={authenticated:true,user:{username:'owner',principal:'owner',isGuest:false}}
 else if(p==='/api/health')body={status:'ok',database:{status:'ok'},redis:{connected:true}}
 else if(p==='/api/stats')body={data:{documents:19,books:18,music:24,code:3,bookmarks:6,games:4,anime:2}}
 else if(p==='/api/rag/status')body={data:{enabled:true,worker:{online:false},coverage:{total:10,indexed:8}}}
 else if(p==='/api/rag/coverage'||p==='/api/trash')body={data:{data:[],items:[],total:0}}
 else if(p==='/api/bookmarks/metadata')body={data:{categories:[],tags:[]}}
 else if(p==='/api/documents')body={data:[document],total:1}
 else if(p==='/api/ebooks')body={data:[book,{...book,id:703,title:'另一本书',progress:0}],pagination:{page:1,pageSize:24,total:2,totalPages:1},total:2}
 else if(p==='/api/ebooks/701/detail')body={data:book}
 else if(p==='/api/ebooks/701/content')body={content:'山间书信\n\n'+('这是一段用于验证阅读排版与主题独立性的合成文字。\n\n'.repeat(30))}
 else if(p==='/api/ebooks/701/progress')body={data:{revision:0,position:null,progress:0}}
 else if(p==='/api/games'||p==='/api/anime')body={data:[{id:704,name:'遥远的海岸',title:'遥远的海岸',status:'planned',personalVersion:'test-version',favorite:false,rating:0}],total:1,counts:[{status:'planned',count:1}]}
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})
}
try{
 for(const width of [1440,390])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:960},colorScheme:theme,reducedMotion:'reduce',isMobile:width<768,hasTouch:width<768})
  await context.route(`${base}/api/**`,fixture)
  const page=await context.newPage();page.on('pageerror',e=>errors.push({width,theme,error:e.message}))
  for(const path of ['dashboard','documents','books','music','code','blog','bookmarks','games','anime','trash','search','tasks',width<768?'more':'system']){
   console.log('checking',width,theme,path)
   await page.goto(base+'/'+path);await page.waitForFunction(()=>document.body.innerText.trim().length>35,null,{timeout:15000});await page.waitForTimeout(300)
   await page.locator('.global-loading-overlay').waitFor({state:'hidden',timeout:10000})
   assert.equal(await page.locator('html').getAttribute('data-theme'),theme)
   const state=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+2,text:document.body.innerText.trim().length,background:getComputedStyle(document.body).backgroundColor}))
   if(state.text<=30)console.log({path,errors,body:await page.locator('body').innerText()})
   assert.ok(state.text>30,`${path} blank`);assert.equal(state.overflow,false,`${path} ${width} overflow`)
   results.push({width,theme,path,...state,contrast:await page.evaluate(contrastAudit)})
   if(['documents','books','games'].includes(path)||path==='more')await page.screenshot({path:`${out}/${width}-${theme}-${path}.png`,fullPage:true})
   if(path==='documents'&&width===1440){
    await page.getByRole('button',{name:'上传文档',exact:true}).click()
    const dialog=page.getByRole('dialog');await dialog.waitFor();await page.waitForTimeout(100)
    results.push({width,theme,path:'document-upload-dialog',contrast:await page.evaluate(contrastAudit)})
    await dialog.getByRole('button',{name:'关闭',exact:true}).click()
   }
   if(path==='blog'){
    await page.getByRole('button',{name:'新建笔记',exact:true}).first().click()
    await page.locator('.md-editor').waitFor()
    assert.equal(await page.locator('.md-editor').first().evaluate(e=>e.classList.contains('md-editor-dark')),theme==='dark')
    results.push({width,theme,path:'note-editor',contrast:await page.evaluate(contrastAudit)})
    await page.screenshot({path:`${out}/${width}-${theme}-note-editor.png`})
   }
  }
  const picker=page.getByRole('combobox',{name:'应用主题'}).first()
  await picker.focus();await page.keyboard.press('Enter')
  await page.getByRole('option',{name:'跟随系统',exact:true}).waitFor();await page.waitForTimeout(100)
  results.push({width,theme,path:'theme-options',contrast:await page.evaluate(contrastAudit)})
  await page.getByRole('option',{name:theme==='dark'?'浅色':'深色',exact:true}).click()
  const selected=theme==='dark'?'light':'dark'
  assert.equal(await page.locator('html').getAttribute('data-theme'),selected)
  await page.reload();assert.equal(await page.locator('html').getAttribute('data-theme'),selected)
  await page.getByRole('combobox',{name:'应用主题'}).first().click();await page.getByRole('option',{name:'跟随系统',exact:true}).click()
  await page.emulateMedia({colorScheme:selected});await page.waitForFunction(t=>document.documentElement.dataset.theme===t,selected);assert.equal(await page.locator('html').getAttribute('data-theme'),selected)
  await page.goto(base+'/books');
  if(width<768)await page.locator('.mobile-book__cover').first().click()
  else {await page.locator('.ebook-card').first().hover();await page.locator('.ebook-card__read').first().click()}
  await page.locator('.ebook-reader__paper').waitFor()
  assert.equal(await page.locator('.ebook-reader__paper').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 253, 249)')
  await page.getByRole('button',{name:'阅读设置',exact:true}).click()
  await page.locator('.ebook-reader__settings').getByRole('button',{name:'深色',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.ebook-reader--dark'))
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.ebook-reader__paper')).backgroundColor==='rgb(35, 40, 50)',null,{timeout:5000})
  assert.equal(await page.locator('.ebook-reader__paper').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(35, 40, 50)')
  const labels=await page.locator('.ebook-reader__settings button:not(:disabled)').evaluateAll(nodes=>nodes.map(e=>({text:e.innerText,fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor})))
  assert.ok(labels.every(x=>x.fg!=='rgb(32, 41, 56)'),JSON.stringify(labels))
  results.push({width,theme,path:'reader-dark',contrast:await page.evaluate(contrastAudit)})
  await page.screenshot({path:`${out}/${width}-${theme}-reader-dark.png`})
  await page.locator('.ebook-reader__settings').getByRole('button',{name:'暖色',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.ebook-reader--warm'))
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.ebook-reader__paper')).backgroundColor==='rgb(251, 243, 228)',null,{timeout:5000})
  assert.equal(await page.locator('.ebook-reader__paper').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(251, 243, 228)')
  await page.getByRole('button',{name:'关闭阅读器',exact:true}).click()
  await page.emulateMedia({colorScheme:theme})
  await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme,{timeout:5000})
  await page.evaluate(async()=>{
   const source=await(await fetch('/src/main.js')).text(),vueUrl=source.match(/from\s+["']([^"']*\/vue\.js[^"']*)["']/)[1]
   const {createApp,h}=await import(vueUrl)
   const names=['NativeButton','NativeTag','NativeCheckbox','NativeSwitch'], components={}
   for(const name of names)components[name]=(await import(`/src/components/native/${name}.vue`)).default
   const Source=(await import('/src/components/CodeSourcePreview.vue')).default
   document.getElementById('app').style.display='none'
   const target=document.createElement('div');target.id='control-matrix';document.body.appendChild(target)
   createApp({render:()=>h('main',{style:'padding:24px;background:var(--color-surface-raised);min-height:100vh'},[
    h('h1',{style:'font-size:20px;margin-bottom:24px'},'统一控件状态'),
    ...['default','primary','success','warning','danger'].map(theme=>h('section',{style:'display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:24px'},[
     ...['base','outline','text'].map(variant=>h(components.NativeButton,{theme,variant},{default:()=>`${theme} ${variant}`})),
     ...['light','solid','outline'].map(variant=>h(components.NativeTag,{theme,variant},{default:()=>`${theme} ${variant}`}))
    ])),h(components.NativeCheckbox,{modelValue:true},{default:()=> '已选择'}),h(components.NativeSwitch,{modelValue:true}),
    h(Source,{content:'const message = "hello"; // note',html:'<span class="hljs-keyword">const</span> message = <span class="hljs-string">"hello"</span>; <span class="hljs-comment">// note</span>',style:'height:80px;margin-top:24px'})
   ])}).mount(target)
  })
  await page.waitForTimeout(200)
  results.push({width,theme,path:'native-controls',contrast:await page.evaluate(contrastAudit)})
  for(const btn of await page.locator('#control-matrix .native-btn:not(:disabled)').all()){
   await btn.hover();await page.waitForTimeout(30)
   results.push({width,theme,path:'native-hover',contrast:await page.evaluate(contrastAudit)})
  }
  await page.screenshot({path:`${out}/${width}-${theme}-controls.png`,fullPage:true})
  await context.close()
 }
 for(const width of [360,768,3840]){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:'dark',reducedMotion:'reduce',isMobile:width<=768,hasTouch:width<=768})
  await context.route(`${base}/api/**`,fixture);const page=await context.newPage();page.on('pageerror',e=>errors.push({width,error:e.message}))
  for(const path of ['documents','books','blog']){
   await page.goto(base+'/'+path);await page.waitForFunction(()=>document.body.innerText.trim().length>35,null,{timeout:15000});await page.locator('.global-loading-overlay').waitFor({state:'hidden',timeout:10000});await page.waitForTimeout(300)
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,`${path} ${width} overflow`)
   results.push({width,theme:'dark',path,contrast:await page.evaluate(contrastAudit)})
  }
  await context.close()
 }
 assert.deepEqual(errors,[])
 const failures=results.flatMap(row=>(row.contrast||[]).map(failure=>({width:row.width,theme:row.theme,path:row.path,...failure})))
 console.log(JSON.stringify({checks:results.length,themeControls:4,errors,contrastFailures:failures.length,output:out},null,2))
 await writeFile(`${out}/results.json`,JSON.stringify({results,errors,requests:[...requests]},null,2))
 assert.deepEqual(failures,[],'Visible text contrast regression')
}finally{await browser.close()}
