// Synthetic owner API only: never connects to a real notes database.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output=process.env.NOTES_TEST_OUTPUT
if(!output) throw new Error('NOTES_TEST_OUTPUT must point to an isolated evidence directory')
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true,...(process.env.NOTES_BROWSER_PATH?{executablePath:process.env.NOTES_BROWSER_PATH}:{})})
const context=await browser.newContext({viewport:{width:1440,height:1000}})
const base=process.env.NOTES_TEST_URL || 'http://127.0.0.1:5182'
let notes=Array.from({length:35},(_,i)=>({id:i+1,title:i?'测试笔记 '+(i+1):'留给未来的一页：整理工作与生活',content:i?'合成笔记正文 '+i:'# 每周整理\n\n把值得留存的想法写下来。\n\n## 下次继续\n\n- 阅读摘录\n- 项目记录\n\n<img src=x onerror="window.fixtureXss=true">',tags:['记录','想法'],category_id:1,category_name:'工作与生活',revision:0,is_top:i===0,updated_at:'2026-09-19 14:00:00'}))
let nextId=36,listFail=false,saveFail=false,loseReply=false,slowDetail=false, loggedOut=false, createRequests=0
const receipts=new Map(),checks=[],errors=[],writes=[]
await context.route('**/api/**',async route=>{
 const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method()
 if(!path.startsWith('/api/')) return route.continue()
 const json=(data,status=200)=>route.fulfill({json:data,status})
 if(path==='/api/auth/check') return json({authenticated:!loggedOut,user:{id:1,username:'fixture',principal:'owner',isGuest:false}})
 if(path==='/api/auth/logout'){loggedOut=true;return json({success:true})}
 if(path==='/api/blog/categories/all'||path==='/api/blog/categories') return json({data:[{id:1,name:'工作与生活',parent_id:null,post_count:notes.length}]})
 if(path==='/api/blog/tags') return json({data:[{id:1,name:'记录'},{id:2,name:'想法'},{id:3,name:'读书'}]})
 if(path==='/api/blog/posts'&&method==='GET'){
  if(listFail)return json({message:'合成列表故障'},503)
  const q=url.searchParams.get('keyword')||'',p=Number(url.searchParams.get('page')||1),s=Number(url.searchParams.get('pageSize')||30)
  const found=notes.filter(n=>!n.deleted&&[n.title,n.content].some(t=>t.includes(q)))
  return json({data:found.slice((p-1)*s,p*s).map(n=>({...n,content:undefined,excerpt:n.content.slice(0,100)})),total:found.length})
 }
 if(path==='/api/blog/posts'&&method==='POST'){
  writes.push(method+' '+path);createRequests++
  const body=req.postDataJSON()
  if(saveFail)return json({message:'模拟断网保存失败'},503)
  if(receipts.has(body.mutationId))return json({data:receipts.get(body.mutationId)})
  const note={...body,id:nextId++,revision:0,updated_at:'2026-09-19 15:00:00',category_name:'工作与生活'};notes.unshift(note);receipts.set(body.mutationId,note)
  if(loseReply){loseReply=false;return route.abort('failed')}
  return json({data:note})
 }
 const match=path.match(/^\/api\/blog\/posts\/(\d+)$/)
 if(match){
  const n=notes.find(n=>n.id===Number(match[1])&&!n.deleted)
  if(!n)return json({message:'笔记不存在或已移入回收站'},404)
  if(method==='GET'){if(slowDetail&&n.id===2)await new Promise(r=>setTimeout(r,500));return json({data:n})}
  writes.push(method+' '+path)
  if(method==='DELETE'){n.deleted=true;return json({data:{id:n.id}})}
  if(method==='PUT'){
   if(saveFail)return json({message:'模拟断网保存失败'},503)
   const b=req.postDataJSON()
   if(b.baseRevision!==n.revision)return json({message:'笔记已在其他位置修改，请比较后再决定',current:n},409)
   Object.assign(n,b,{revision:n.revision+1});return json({data:n})
  }
 }
 return json({data:[],total:0,success:true})
})
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text())})
page.on('dialog',dialog=>dialog.accept())
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name)}
const editBody=()=>page.locator('.note-md-editor [contenteditable=true]').first()
const save=()=>page.getByRole('button',{name:'保存',exact:true}).click()
try{
 await page.goto(base+'/blog')
 await page.locator('.note-row').first().waitFor()
 await check('PC list, reading, sanitized Markdown and shared metadata',async()=>{
  await page.locator('.note-row').first().click();await page.locator('.note-article > h1').waitFor();assert.equal(await page.evaluate(()=>window.fixtureXss),undefined)
  assert.equal(await page.getByText('工作与生活 · 2026-09-19 14:00').count(),1)
  await page.screenshot({path:join(output,'pc-notes-reading.png')})
 })
 await check('explicit save, suggestions, dirty state and local draft protection',async()=>{
  await page.getByRole('button',{name:'编辑',exact:true}).click();await editBody().fill('# 本机编辑\n\n保留段落')
  await page.getByRole('button',{name:/标签与置顶/}).click();await page.getByRole('button',{name:'+ 读书',exact:true}).click()
  await page.getByText('本机草稿已保留',{exact:true}).waitFor()
  assert.equal(notes.find(n=>n.id===1).content.startsWith('# 每周整理'),true)
  await page.screenshot({path:join(output,'pc-notes-editor.png')})
  await save();await page.getByText('已保存到 NAS',{exact:true}).waitFor();assert.equal(notes.find(n=>n.id===1).revision,1);assert.ok(notes.find(n=>n.id===1).tags.includes('读书'))
 })
 await check('failed save preserves content; retry succeeds without leaving editor',async()=>{
  saveFail=true;await editBody().fill('失败后仍保留的正文');await save();await page.getByRole('alert').filter({hasText:'模拟断网保存失败'}).waitFor()
  assert.equal(await editBody().innerText(),'失败后仍保留的正文');saveFail=false
  await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.getByText('已保存到 NAS',{exact:true}).waitFor()
 })
 await check('cross-device conflict preserves local text and permits safe copy',async()=>{
  await editBody().fill('PC 尚未保存的段落');const server=notes.find(n=>n.id===1);server.content='手机已经保存的段落';server.revision++
  await save();await page.getByText('检测到另一份修改 · 本机内容已保留').waitFor();assert.equal(await editBody().innerText(),'PC 尚未保存的段落')
  await page.getByRole('button',{name:'本机内容另存副本',exact:true}).click();await page.getByText('已保存到 NAS',{exact:true}).waitFor();assert.equal(server.content,'手机已经保存的段落');assert.ok(notes.some(n=>n.title.endsWith('（副本）')&&n.content==='PC 尚未保存的段落'))
 })
 await check('reload retains draft and original revision; resume is explicit',async()=>{
  await editBody().fill('刷新后恢复的正文');await page.getByText('本机草稿已保留',{exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:'继续草稿',exact:true}).waitFor();await page.getByRole('button',{name:'继续草稿',exact:true}).click();assert.equal(await editBody().innerText(),'刷新后恢复的正文');await save();await page.getByText('已保存到 NAS',{exact:true}).waitFor()
 })
 await check('create retry after lost response is idempotent',async()=>{
  await page.getByRole('button',{name:'新建笔记',exact:true}).click();await page.locator('#note-title').fill('幂等新笔记');await editBody().fill('新建内容');const count=notes.length;loseReply=true;await save();await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.getByText('已保存到 NAS',{exact:true}).waitFor();assert.equal(notes.length,count+1)
 })
 await check('rapid detail requests only render newest note',async()=>{
  slowDetail=true;await page.locator('.note-row').filter({hasText:'测试笔记 2'}).first().click();await page.locator('.note-row').filter({hasText:'测试笔记 3'}).first().click();await page.locator('.note-article > h1').filter({hasText:'测试笔记 3'}).waitFor();await page.waitForTimeout(600);assert.equal(await page.locator('.note-article > h1').innerText(),'测试笔记 3');slowDetail=false
 })
 await check('list failure preserves rows; search and retry remain usable',async()=>{
  listFail=true;await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByRole('alert').filter({hasText:'合成列表故障'}).waitFor();assert.ok(await page.locator('.note-row').count()>0);listFail=false;await page.getByRole('button',{name:'重试',exact:true}).click();await page.locator('.note-message').waitFor({state:'hidden'})
  await page.getByPlaceholder('搜索标题与正文').fill('手机已经保存');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.note-row').length===1);assert.ok(page.url().includes('q='))
 })
 await check('reversible deletion removes selected note and exposes unified trash shortcut',async()=>{
  await page.locator('.note-row').first().click();await page.getByRole('button',{name:'移入回收站',exact:true}).click();await page.getByText('没有匹配的笔记',{exact:true}).waitFor();assert.equal(notes.find(n=>n.id===1).deleted,true);await page.getByRole('button',{name:'清除筛选',exact:true}).click()
 })
 await check('mobile reading and full-screen editing fit 390 and 320 widths',async()=>{
  await page.setViewportSize({width:390,height:844});await page.goto(base+'/blog');await page.locator('.note-row').first().waitFor();assert.equal(await page.getByRole('button',{name:'分类管理',exact:true}).count(),0)
  await page.waitForTimeout(700);await page.screenshot({path:join(output,'mobile-notes.png')});await page.locator('.note-row').first().click();await page.getByRole('button',{name:'编辑',exact:true}).click();await editBody().fill('手机编辑内容');await page.getByText('本机草稿已保留',{exact:true}).waitFor();await page.screenshot({path:join(output,'mobile-notes-editor.png')})
  for(const width of [390,320,768]) {await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);const rect=await page.locator('.note-content-header').boundingBox();assert.ok(rect.width<=width)}
  await page.setViewportSize({width:390,height:844});await save();await page.getByText('已保存到 NAS',{exact:true}).waitFor();await page.getByRole('button',{name:'返回笔记列表',exact:true}).click()
 })
 await check('logout clears local draft content and owner isolation',async()=>{
  await page.getByRole('button',{name:'新建笔记',exact:true}).click();await page.locator('#note-title').fill('退出前草稿');await editBody().fill('私有草稿');await page.getByText('本机草稿已保留',{exact:true}).waitFor();await page.getByRole('button',{name:'返回笔记列表',exact:true}).click();await page.getByRole('button',{name:/退出/}).first().click();await page.waitForFunction(()=>!Object.keys(localStorage).some(k=>k.startsWith('pr-manager:note-draft:')))
 })
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,errors,writes,createRequests},null,2));await writeFile(join(output,'results.json'),JSON.stringify({checks,errors,writes},null,2))
}catch(error){await page.screenshot({path:join(output,'failure.png'),fullPage:true});console.error(await page.locator('body').innerText());throw error}finally{await browser.close()}
