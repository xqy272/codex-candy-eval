import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
const asset = (name:string,type:string) => `data:${type};base64,${readFileSync(new URL(`../dist/${name}`,import.meta.url)).toString('base64')}`
const csp = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const html = readFileSync(new URL('../dist/index.html',import.meta.url),'utf8').replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="${csp}">`).replace('./app.js',asset('app.js','text/javascript')).replace('./app.css',asset('app.css','text/css'))
async function mock(page:Page,options:{empty?:boolean;error?:boolean;queued?:boolean;paused?:boolean;dark?:boolean;pelican?:boolean;timeout?:boolean;resumedDrawing?:boolean}={}) {
  await page.route('http://127.0.0.1:4173/',route => route.fulfill({contentType:'text/html',body:html}))
  await page.addInitScript(options => {
    document.addEventListener('DOMContentLoaded',()=>{document.body.style.background=options.dark?'#151b25':'#f6f8fb'})
    const saved=new Map<string,any>()
    const attempts=(id:string) => options.resumedDrawing ? [{key:id+'-0',step:0,status:'timeout',valid:false},{key:id+'-1',step:0,status:'completed',valid:true}] : [{key:id+'-0',step:0,status:'completed',valid:!options.paused}]
    if(options.paused || options.pelican) saved.set('seed',{task:true,id:'seed',accountId:'a1',accountName:'测试账号 A',kind:options.pelican?'pelican':'fingerprint',model:'gpt-test',effort:'',requestProfile:'simple-v1',status:options.paused?'paused':'completed',reason:options.paused?'invalid_sample':null,verdict:'output',startedAt:Date.now(),updatedAt:1,durationMs:100,validSamples:options.paused?0:1,expectedSamples:options.paused?3:1,attempts:attempts('seed'),samples:[],attribution:null,canResume:!!options.paused})
    const encode=(value:any,status=200) => ({status,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify(value)).buffer})
    ;(window as any).__requests=[]
    Object.defineProperty(window,'codexProxyPlugin',{value:{theme:options.dark?'dark':'light',request:async(input:any)=>{
      const data=input.body?JSON.parse(new TextDecoder().decode(input.body)):null
      ;(window as any).__requests.push({path:input.path,data})
      if(options.error) return encode({error:{message:'模拟读取失败'}},502)
      if(input.path==='api/snapshot') return encode({accounts:options.empty?[]:[{account_id:'a1',name:'测试账号 A',email:'a@example.invalid',enabled:true},{account_id:'a2',name:'测试账号 B',enabled:false}],keys:options.empty?[]:[{id:'k1',name:'测试 Key',enabled:true}]})
      if(input.path==='api/models') return encode({models:['gpt-test','other-model']})
      if(input.path==='api/history') return encode({records:[]})
      if(input.path==='api/tasks') return encode({records:[...saved.values()]})
      if(input.path==='api/submit') {
        const record={...data,task:true,accountName:'测试账号 A',requestProfile:data.profile,status:options.queued?'queued':'completed',verdict:'correct',validSamples:options.queued?0:1,expectedSamples:1,startedAt:Date.now(),updatedAt:1,durationMs:100,attempts:options.queued?[]:attempts(data.id),samples:[],attribution:null}
        saved.set(data.id,record);return encode({record})
      }
      if(input.path==='api/task') return encode({record:saved.get(data.id)})
      if(input.path==='api/sample' && options.resumedDrawing && data.key.endsWith('-0')) return encode({sample:{status:'timeout',valid:false,step:0,prompt:'固定题目',instructions:'',durationMs:150000,requestId:'first-timeout',answer:null}})
      if(input.path==='api/sample') return encode({sample:{status:options.timeout?'timeout':'completed',valid:!options.paused,step:0,prompt:'固定题目',instructions:'',durationMs:options.timeout?600000:100,requestId:'mock-request',error:options.timeout?{code:'plugin_deadline',kind:'request_deadline',origin:'plugin',timeoutMs:600000}:null,answer:options.timeout?null:{text:options.pelican?'<svg width="300" height="180"><text x="20" y="80">Pelican</text><script>parent.__unsafe=true</script><image href="https://example.invalid/leak"/></svg>':'21',usage:{inputTokens:12}}}})
      if(input.path==='api/resume') {saved.get(data.id).status='queued';saved.get(data.id).canResume=false;return encode({})}
      if(input.path==='api/stop') {saved.get(data.id).status='stopped';saved.get(data.id).stopRequested=true;return encode({})}
      if(input.path==='api/delete') {saved.delete(data.id);return encode({})}
      throw Error('Unexpected route '+input.path)
    }}})
  },options)
}
test('empty state and read errors are actionable',async({page})=>{
  await mock(page,{empty:true});await page.goto('/');await expect(page.getByText('暂无 OpenAI 账号')).toBeVisible();await expect(page.getByRole('button',{name:'测试所选账号'})).toBeDisabled()
})
test('read failure is visible',async({page})=>{await mock(page,{error:true});await page.goto('/');await expect(page.getByRole('alert')).toHaveText('模拟读取失败')})
test('submission only enqueues and page departure does not cancel',async({page})=>{
  await mock(page,{queued:true});await page.goto('/');await page.getByRole('button',{name:'测试',exact:true}).first().click()
  await expect(page.getByRole('article').getByText('排队中',{exact:true})).toBeVisible()
  const calls=await page.evaluate(()=>(window as any).__requests)
  expect(calls.filter((r:any)=>r.path==='api/submit')).toHaveLength(1);expect(calls.some((r:any)=>r.path==='api/run'||r.path==='api/stop')).toBe(false)
  expect(calls.find((r:any)=>r.path==='api/submit').data.profile).toBe('simple-v1')
  await page.getByRole('button',{name:'停止',exact:true}).click();await page.getByRole('button',{name:'历史',exact:true}).click();await expect(page.getByRole('article').getByText('已停止',{exact:true})).toBeVisible()
})
test('candy report, export, condition filtering and disabled account',async({page},info)=>{
  await mock(page);await page.goto('/');await expect(page.getByLabel('选择 测试账号 B')).toBeDisabled()
  await page.getByRole('button',{name:'测试',exact:true}).first().click();await page.getByRole('button',{name:'历史',exact:true}).click()
  await page.getByRole('button',{name:'查看报告'}).click();await expect(page.getByText('答案标准：21。未取得有效回答不记为答错。')).toBeVisible()
  await page.getByRole('button',{name:'导出本次报告'}).click();await expect(page.getByLabel('报告 JSON，下载受限时可选中复制')).toHaveValue(/mock-request/)
  await page.getByLabel('模型',{exact:true}).selectOption('other-model');await expect(page.getByText('未测试',{exact:true}).first()).toBeVisible()
  await page.screenshot({path:info.outputPath('candy-report.png'),fullPage:true})
})
test('fingerprint failure has its own statistics and resumes existing task',async({page})=>{
  await mock(page,{paused:true});await page.goto('/');await page.getByLabel('测试类型',{exact:true}).selectOption('fingerprint')
  await expect(page.getByRole('columnheader',{name:'糖果正确 / 有效'})).toHaveCount(0)
  await page.getByRole('button',{name:'查看报告'}).click();await expect(page.getByText('已取得 0 / 3 个有效样本 · 共 1 次尝试')).toBeVisible()
  await page.getByRole('button',{name:'继续检测',exact:true}).first().click();await expect(page.getByRole('article').getByText('排队中',{exact:true})).toBeVisible()
  const calls=await page.evaluate(()=>(window as any).__requests);expect(calls.find((r:any)=>r.path==='api/resume').data.id).toBe('seed');expect(calls.some((r:any)=>r.path==='api/submit')).toBe(false)
})
test('dark narrow layout remains bounded',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await mock(page,{dark:true,paused:true});await page.goto('/');await page.getByRole('button',{name:'查看报告'}).click()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.screenshot({path:info.outputPath('dark-mobile.png'),fullPage:true})
})
test('drawing report isolates generated SVG',async({page},info)=>{
  const outbound:string[]=[];page.on('request',r=>{if(r.url().startsWith('https://'))outbound.push(r.url())})
  await mock(page,{pelican:true});await page.goto('/');await page.getByRole('button',{name:'历史',exact:true}).click();await page.getByRole('button',{name:'查看报告'}).click()
  await expect(page.getByAltText('鹈鹕绘图预览')).toBeVisible();expect(await page.evaluate(()=>(window as any).__unsafe)).toBeUndefined();expect(outbound).toEqual([])
  await page.screenshot({path:info.outputPath('drawing.png'),fullPage:true})
})
test('drawing explains its wait limit and identifies a plugin deadline',async({page})=>{
  await mock(page,{pelican:true,paused:true,timeout:true});await page.goto('/')
  await page.getByLabel('测试类型',{exact:true}).selectOption('pelican')
  await expect(page.getByText(/每次最多等待 10 分钟/)).toBeVisible()
  await page.getByRole('button',{name:'查看报告'}).click()
  await page.locator('.report .sample > summary').click()
  await expect(page.getByText(/已达到插件的 600 秒等待上限/)).toBeVisible()
  await expect(page.getByText(/未取得最终用量，不代表未消耗额度/)).toBeVisible()
  await expect(page.getByText(/宿主错误码/)).toHaveCount(0)
  await expect(page.getByAltText('鹈鹕绘图预览')).toHaveCount(0)
})
test('drawing preview uses the successful resumed attempt after an initial timeout',async({page})=>{
  await mock(page,{pelican:true,resumedDrawing:true});await page.goto('/')
  await page.getByRole('button',{name:'历史',exact:true}).click()
  await page.getByRole('button',{name:'查看报告'}).click()
  await expect(page.locator('.report .sample')).toHaveCount(2)
  await expect(page.getByAltText('鹈鹕绘图预览')).toBeVisible()
  expect(await page.getByAltText('鹈鹕绘图预览').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0)
})
test('deleting history requires explicit selection confirmation',async({page})=>{
  await mock(page,{pelican:true});await page.goto('/');await page.getByRole('button',{name:'历史',exact:true}).click();await page.getByRole('button',{name:'删除',exact:true}).click()
  let calls=await page.evaluate(()=>(window as any).__requests);expect(calls.some((r:any)=>r.path==='api/delete')).toBe(false)
  await page.getByRole('button',{name:'确认删除'}).click();await expect(page.getByText('暂无历史记录')).toBeVisible()
})
