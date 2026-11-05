import {chromium} from '../frontend/node_modules/playwright/index.mjs'
import {readFileSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
const root = new URL('../.runtime/integration/',import.meta.url)
const mode=process.argv[2] ?? 'before'
assert(['before','after'].includes(mode))
const control=JSON.parse(readFileSync(new URL('control.json',root)))
assert.equal(control.base,'http://127.0.0.1:18380')
const state=JSON.parse(readFileSync(new URL('state.json',root)))
const browser=await chromium.launch({channel:'chrome',headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1050}})
const snapshotPath=name=>fileURLToPath(new URL(name,root))
const checks=[]
try {
 const login=await context.request.post(control.base+'/api/auth/login',{headers:{Origin:control.base},data:{mode:'admin',username:control.username,password:control.password}})
 assert(login.ok(),'Isolated login failed')
 const page=await context.newPage(),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.goto(control.base+'/plugins/'+state.instanceId+'/codex-candy-eval')
 const frame=page.frameLocator('iframe')
 await frame.locator('.account-row').nth(6).waitFor()
 const rows=await frame.locator('.account-row').evaluateAll(elements=>elements.map(e=>({
   name:e.querySelector('strong').textContent,
   nameHeight:e.querySelector('strong').getBoundingClientRect().height,
   enabled:!e.querySelector('input').disabled,
   id:e.querySelector('input').value,
   status:e.querySelector('small').textContent,
 })))
 assert.equal(rows.length,7)
 assert.deepEqual(rows.map(r=>r.enabled),state.accounts.map(a=>a.enabled))
 assert.equal(rows.filter(r=>!r.enabled).length,6)
 const selected=frame.locator('.account-row input:not([disabled])')
 if(mode==='before') {
   assert(rows.every(r=>r.name==='' && r.nameHeight===0))
   await selected.check()
   checks.push('Released 1.3.0 reproduces seven blank labels with actual typed host metadata')
 } else {
   assert(rows.every(r=>r.name.trim() && r.nameHeight>0))
   assert.deepEqual(rows.map(r=>r.name),state.accounts.map(a=>a.email || a.account_id))
   assert(await selected.isChecked(),'Old selection was not preserved on upgrade')
   checks.push('Exact final 1.3.1 archive shows six email labels and one stable ID in the actual native iframe')
   const search=frame.getByLabel('搜索账号')
   for(const a of [state.accounts[0],state.accounts[6]]) {
     await search.fill(a.email || a.account_id)
     assert.equal(await frame.locator('.account-row').count(),1)
     assert.equal(await frame.locator('.account-row input').inputValue(),a.account_id)
   }
   await search.fill('unmatched-account')
   await frame.getByText('未找到匹配账号',{exact:true}).waitFor()
   await search.fill('')
   checks.push('Search locates an email-only account, an ID-only account, and reports an empty match')
 }
 await page.waitForTimeout(900)
 await page.reload()
 await frame.locator('.account-row').nth(6).waitFor()
 assert(await selected.isChecked(),'Selected stable account ID did not survive reload')
 assert.equal(await selected.inputValue(),state.accounts.find(a=>a.enabled).account_id)
 checks.push('Enabled flags, disabled checkboxes and selected stable ID are unchanged; selection survives reload')
 await frame.locator('.accounts').screenshot({path:snapshotPath('accounts-'+mode+'.png')})
 if(mode==='after') {
   await page.getByRole('button',{name:'切换暗黑模式'}).click()
   await frame.locator('html[data-eval-theme="dark"]').waitFor()
   await frame.locator('.accounts').screenshot({path:snapshotPath('accounts-dark.png')})
   await page.setViewportSize({width:390,height:844})
   await frame.getByRole('button',{name:'选择账号',exact:true}).click()
   await frame.locator('.accounts.expanded').waitFor()
   assert(await frame.locator('html').evaluate(e=>e.scrollWidth<=innerWidth))
   assert(await frame.locator('.account-row strong').nth(6).isVisible())
   await frame.locator('.eval-page').screenshot({path:snapshotPath('accounts-mobile.png')})
   checks.push('Native dark theme and 390px account selector retain visible labels without horizontal overflow')
 }
 assert.deepEqual(errors,[])
 const ledger=JSON.parse(readFileSync(new URL('upstream-observations.json',root)))
 assert.equal(ledger.models.length,0,'Account inspection must not consume model calls')
 writeFileSync(new URL('accounts-'+mode+'.json',root),JSON.stringify({archiveSha256:state.artifactSha256,rows,checks,pageErrors:errors,controlledModelCalls:0,realModelRequests:0},null,2))
 console.log('PASS: '+mode+' account labels; '+checks.length+' native checks, no model calls')
} finally {await browser.close()}
