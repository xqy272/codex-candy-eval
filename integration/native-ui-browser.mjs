import { chromium } from '../frontend/node_modules/playwright/index.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../.runtime/integration/', import.meta.url)
const control = JSON.parse(readFileSync(new URL('control.json', root)))
const state = JSON.parse(readFileSync(new URL('state.json', root)))
if (control.base !== 'http://127.0.0.1:18380' || control.username !== 'eval-admin') throw Error('Only an isolated host is accepted')
const path = name => fileURLToPath(new URL('ui140/' + name, root))
mkdirSync(new URL('ui140/', root), { recursive: true })
const ledger = () => JSON.parse(readFileSync(new URL('upstream-observations.json', root))).models
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
const response = await context.request.post(control.base + '/api/auth/login', { headers: { Origin: control.base }, data: { mode: 'admin', username: control.username, password: control.password } })
if (!response.ok()) throw Error('Isolated login failed')
const page = await context.newPage()
page.setDefaultTimeout(30000)
const errors = [], checks = [], themes = []
const before = ledger().length
const check = (value, message) => { if (!value) throw Error(message); checks.push(message); console.log('PASS: ' + message) }
page.on('pageerror', e => errors.push(e.message))
async function choose(f, name, option) {
  await f.getByRole('combobox', { name, exact: true }).click()
  await f.getByRole('option', { name: option, exact: true }).click()
}
let controlledUiCalls = 0
try {
  await page.goto(control.base + '/plugins/' + state.instanceId + '/codex-candy-eval')
  await page.locator('iframe').waitFor()
  const f = page.frameLocator('iframe')
  await f.getByRole('radiogroup', { name: '测试类型' }).waitFor()
  let inner = page.frames().find(frame => frame !== page.mainFrame())
  await inner.evaluate(async () => {
    await Promise.all([document.fonts.load('13px "Inter Variable"'), document.fonts.load('13px "JetBrains Mono Variable"')])
    await document.fonts.ready
  })
  check(await inner.evaluate(() => document.fonts.check('13px "Inter Variable"') && document.fonts.check('13px "JetBrains Mono Variable"')), 'Declared bundled fonts load through native resource assembly')
  check(await inner.evaluate(() => { try { void localStorage.length; return false } catch (e) { return e.name === 'SecurityError' } }), 'Actual native iframe denies Web Storage while restored draft remains readable')
  await f.getByRole('radiogroup', { name: '插件导航' }).getByRole('radio', { name: '记录', exact: true }).click()
  await choose(f, '筛选测试', '糖果题')
  await f.locator('.history-table [data-return-history="' + state.preservedBatchId + '"]').click()
  await f.getByLabel('本批次总览').waitFor()
  await f.locator('.desktop-results').getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
  await f.locator('.big-answer').waitFor()
  check((await f.locator('.big-answer').innerText()).trim() === '3 / 3', 'Upgraded same-instance repeated-candy result renders with its original samples')
  await f.getByRole('button', { name: '返回本批次' }).click()
  await f.getByRole('radiogroup', { name: '插件导航' }).getByRole('radio', { name: '测试', exact: true }).click()
  await f.getByRole('radiogroup', { name: '测试类型' }).getByRole('radio', { name: '模型指纹', exact: true }).click()
  await choose(f, '模型', 'eval-fp')
  await f.getByRole('button', { name: /^(开始检测|新建检测) ·/ }).click()
  await f.locator('.current-batch').filter({ hasText: '完成 2 / 2 个账号' }).waitFor({ timeout: 150000 })
  await f.locator('.desktop-results').getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
  await f.locator('.ranking').waitFor()
  await page.waitForTimeout(1200)
  controlledUiCalls = ledger().length - before
  check(controlledUiCalls === 6, 'Two-account fingerprint started in actual native UI issues exactly six loopback requests')
  await f.locator('.eval-page').screenshot({ path: path('fingerprint-light.png') })
  await page.screenshot({ path: path('host-light.png'), fullPage: true })

  const themeCases = [
    { name: 'dark', mode: 'dark', preset: 'default', color: 'relay-blue', customColor: '#5983F4', customization: {} },
    { name: 'teal', mode: 'light', preset: 'default', color: 'deep-teal', customColor: '#5983F4', customization: {} },
    { name: 'violet-soft', mode: 'light', preset: 'soft', color: 'signal-violet', customColor: '#5983F4', customization: {} },
    { name: 'custom', mode: 'dark', preset: 'soft', color: 'custom', customColor: '#8a3ec4', customization: { seed: { fontSize: 15, borderRadius: 14, controlHeight: 44, sizeUnit: 5 }, component: { cardBorderRadius: 22 } } },
  ]
  for (const config of themeCases) {
    const applied = await page.evaluate(c => {
      const app = document.querySelector('#app').__vue_app__
      const store = app.config.globalProperties.$pinia._s.get('theme')
      return store.setThemeConfiguration(c)
    }, config)
    check(applied, 'Host accepts ' + config.name + ' through its own theme store')
    await page.waitForTimeout(250)
    const hostTokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return Object.fromEntries(['color-bg-layout', 'color-bg-container', 'color-primary', 'font-size', 'border-radius', 'control-height', 'card-border-radius'].map(k => [k, style.getPropertyValue('--z-' + k).trim()]))
    })
    const pluginTokens = await inner.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return Object.fromEntries(['color-bg-layout', 'color-bg-container', 'color-primary', 'font-size', 'border-radius', 'control-height', 'card-border-radius'].map(k => [k, style.getPropertyValue('--z-' + k).trim()]))
    })
    check(JSON.stringify(hostTokens) === JSON.stringify(pluginTokens), 'Actual bridge synchronizes surface, accent, font, radius and control tokens for ' + config.name)
    check(!!pluginTokens['color-bg-layout'] && !!pluginTokens['control-height'], 'Theme token values are populated for ' + config.name)
    if (config.name === 'custom') check(await f.locator('.start-button').evaluate(e => e.getBoundingClientRect().height) === 44, 'Customized control height is consumed by the actual official button')
    themes.push({ name: config.name, hostTokens, pluginTokens })
    await f.locator('.eval-page').screenshot({ path: path(config.name + '.png') })
  }

  await inner.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(Error('Controlled clipboard denial')) } }))
  await f.getByText('原始回答与请求详情', { exact: true }).click()
  await f.getByRole('button', { name: '复制调试 JSON', exact: true }).click()
  const exported = JSON.parse(await f.getByLabel('可选中复制的结果文本').inputValue())
  check(exported[0].samples.length === 3 && exported[0].sourceHashes.bank, 'Opaque iframe copy fallback includes all saved samples and source hashes')
  await page.reload()
  await f.getByRole('radiogroup', { name: '测试类型' }).waitFor()
  inner = page.frames().find(frame => frame !== page.mainFrame())
  await f.getByLabel('本批次总览').waitFor()
  await f.getByRole('radiogroup', { name: '插件导航' }).getByRole('radio', { name: '记录', exact: true }).click()
  await choose(f, '筛选测试', '画鹈鹕')
  await f.locator('.history-table').getByRole('button', { name: '查看结果', exact: true }).first().click()
  await f.locator('.desktop-results').getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
  const image = f.getByAltText('鹈鹕绘图预览')
  await image.waitFor()
  await image.evaluate(e => e.decode())
  check(await image.evaluate(e => e.naturalWidth > 0), 'Saved SVG decodes in the final archive under real native CSP')
  await f.getByRole('button', { name: '放大查看' }).click()
  await f.getByRole('dialog', { name: '作品预览' }).waitFor()
  await choose(f, '预览缩放', '150%')
  await f.getByRole('dialog', { name: '作品预览' }).screenshot({ path: path('artwork-zoom.png') })
  await page.keyboard.press('Escape')
  check(await f.getByRole('button', { name: '放大查看' }).evaluate(e => e === e.ownerDocument.activeElement), 'Official dialog restores focus in the real isolated iframe')
  await f.locator('.eval-page').screenshot({ path: path('drawing-dark.png') })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.waitForTimeout(200)
    check(await inner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Native plugin fits ' + width + 'px viewport')
    await f.locator('.eval-page').screenshot({ path: path('mobile-' + width + '.png') })
  }
  await page.waitForTimeout(1200)
  check(ledger().length === before + controlledUiCalls, 'History, theme changes, zoom, refresh and mobile review generate no additional model requests')
  check(errors.length === 0, 'No browser JavaScript errors')
  writeFileSync(new URL('ui140-report.json', root), JSON.stringify({ archiveSha256: state.artifactSha256, checks, themes, pageErrors: errors, realModelRequests: 0, controlledUiCalls, viewportWidths: [1440, 390, 320] }, null, 2))
} catch (e) {
  await page.screenshot({ path: path('failure.png'), fullPage: true })
  writeFileSync(new URL('ui140-error.json', root), JSON.stringify({ error: e.message, pageErrors: errors, checks }, null, 2))
  throw e
} finally {
  await browser.close()
}
