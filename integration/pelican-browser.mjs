// Verify the first-timeout / second-success report in the actual host iframe.
import { chromium } from '../frontend/node_modules/playwright/index.mjs'
import { readFileSync,writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root=new URL('../.runtime/integration/',import.meta.url)
const control=JSON.parse(readFileSync(new URL('control.json',root),'utf8'))
const state=JSON.parse(readFileSync(new URL('state.json',root),'utf8'))
const browser=await chromium.launch({channel:'chrome',headless:true})
try {
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 const login=await context.request.post(control.base+'/api/auth/login',{headers:{Origin:control.base},data:{mode:'admin',username:control.username,password:control.password}})
 if(!login.ok())throw Error('Isolated login failed')
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(control.base+'/plugins/'+state.instanceId+'/codex-candy-eval')
 const frame=page.frameLocator('iframe')
 await frame.getByRole('button',{name:'历史',exact:true}).click()
 await frame.getByLabel('筛选测试').selectOption('pelican')
 await frame.getByRole('article').last().getByRole('button',{name:'查看报告'}).click()
 await frame.locator('.report .drawing').waitFor()
 const attempts=await frame.locator('.report .sample').count()
 if(attempts!==2)throw Error('Expected original timeout and resumed complete attempt')
 if(!await frame.locator('.report .drawing').evaluate(image=>image.naturalWidth>0))throw Error('SVG did not render')
 await frame.getByRole('button',{name:'导出本次报告'}).click()
 const report=JSON.parse(await frame.getByLabel('报告 JSON，下载受限时可选中复制').inputValue())
 if(!['timeout','incomplete'].includes(report.samples[0].status)||report.samples[1].status!=='completed'||!report.samples[1].answer.text.includes('<svg'))throw Error('Attempt evidence was not retained')
 if(errors.length)throw Error(errors.join(';'))
 await frame.locator('.report').screenshot({path:fileURLToPath(new URL('pelican-resumed-native.png',root))})
 writeFileSync(new URL('pelican-ui.json',root),JSON.stringify({archiveSha256:state.artifactSha256,firstAttempt:report.samples[0].status,secondAttempt:'completed',svgRendered:true,attemptsPreservedInExport:2,actualHostIframeAndCsp:true,errors},null,2))
 console.log('PASS: resumed drawing preview, both attempts and export under actual host CSP')
} finally {await browser.close()}
