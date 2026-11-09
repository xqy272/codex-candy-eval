import { chromium } from '../frontend/node_modules/playwright/index.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hostVersion = process.argv[2]
if (!['3.43.1', '3.44.0'].includes(hostVersion)) throw Error('An explicitly verified host version is required')
const root = new URL('../.runtime/integration/', import.meta.url)
const control = JSON.parse(readFileSync(new URL('control.json', root)))
const state = JSON.parse(readFileSync(new URL('state.json', root)))
if (control.base !== 'http://127.0.0.1:18380' || control.username !== 'eval-admin') throw Error('Only the disposable loopback host is accepted')
const output = new URL('ui141-' + hostVersion + '/', root)
mkdirSync(output, { recursive: true })
const path = name => fileURLToPath(new URL(name, output))
const ledger = () => JSON.parse(readFileSync(new URL('upstream-observations.json', root))).models
let before = ledger().length
const checks = [], errors = [], themes = []
const check = (value, message) => { if (!value) throw Error(message); checks.push(message); console.log('PASS: ' + message) }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
await context.request.post(control.base + '/api/auth/login', { headers: { Origin: control.base }, data: { mode: 'admin', username: control.username, password: control.password } })
async function admin(endpoint, data) {
  const response = await context.request.post(control.base + endpoint, { headers: { Origin: control.base }, data })
  if (!response.ok()) throw Error('Isolated fixture operation failed: ' + endpoint)
  const value = await response.json()
  return value.data ?? value
}
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.on('pageerror', error => errors.push(error.message))
const f = page.frameLocator('iframe')
let inner
const result = () => f.getByRole('dialog', { name: /^(检测|批次)结果$/ })
async function plugin(endpoint) {
  return inner.evaluate(async path => {
    const response = await window.codexProxyPlugin.request({ method: 'GET', path })
    if (response.status !== 200) throw Error('Controlled plugin read failed')
    return JSON.parse(new TextDecoder().decode(response.body))
  }, endpoint)
}
async function choose(name, option) {
  await f.getByRole('combobox', { name, exact: true }).click()
  await f.getByRole('option', { name: option, exact: true }).click()
}
async function closeResult() {
  await f.getByRole('button', { name: '关闭结果', exact: true }).click()
  await result().waitFor({ state: 'hidden' })
}
async function openAccount(scope = f) {
  await scope.locator('.desktop-results').getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
  await result().waitFor()
}
async function theme(config) {
  const applied = await page.evaluate(value => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('theme').setThemeConfiguration(value), config)
  check(applied, 'Host accepts ' + config.name + ' theme through its own store')
  await page.waitForTimeout(200)
  const tokens = () => {
    const css = getComputedStyle(document.documentElement)
    return Object.fromEntries(['color-bg-layout', 'color-bg-container', 'color-primary', 'font-size', 'border-radius', 'control-height'].map(key => [key, css.getPropertyValue('--z-' + key).trim()]))
  }
  const outer = await page.evaluate(tokens), embedded = await inner.evaluate(tokens)
  check(JSON.stringify(outer) === JSON.stringify(embedded), 'Actual iframe inherits host theme tokens for ' + config.name)
  themes.push({ name: config.name, hostTokens: outer, pluginTokens: embedded })
}
const warm = { name: 'warm-soft', mode: 'light', preset: 'soft', color: 'custom', customColor: '#a94635', customization: { seed: { colorBgBase: '#fbf7ec', colorTextBase: '#302a25' } } }
try {
  await page.goto(control.base + '/plugins/' + state.instanceId + '/codex-candy-eval')
  await f.getByRole('combobox', { name: '客户端 Key', exact: true }).waitFor()
  inner = page.frames().find(frame => frame !== page.mainFrame())
  const idle = await inner.evaluate(async () => {
    const response = await window.codexProxyPlugin.request({ method: 'GET', path: 'api/tasks' })
    return JSON.parse(new TextDecoder().decode(response.body)).records.every(row => !['queued', 'running', 'scoring'].includes(row.status))
  })
  check(idle, 'Browser verification starts only after controlled business tasks are quiescent')
  before = ledger().length
  if (!state.reviewKeyId) {
    const existing = await inner.evaluate(async () => {
      const response = await window.codexProxyPlugin.request({ method: 'GET', path: 'api/snapshot' })
      return JSON.parse(new TextDecoder().decode(response.body)).keys.find(key => key.name === 'Review client two')?.id
    })
    if (existing) { state.reviewKeyId = existing; writeFileSync(new URL('state.json', root), JSON.stringify(state)) }
  }
  check(await inner.evaluate(() => { try { void localStorage.length; return false } catch (error) { return error.name === 'SecurityError' } }), 'Native opaque iframe preserves private drafts without Web Storage')
  await inner.evaluate(async () => { await Promise.all([document.fonts.load('13px "Inter Variable"'), document.fonts.load('13px "JetBrains Mono Variable"')]); await document.fonts.ready })
  check(await inner.evaluate(() => document.fonts.check('13px "Inter Variable"') && document.fonts.check('13px "JetBrains Mono Variable"')), 'Declared font resources load in the actual host')

  if (!state.reviewKeyId) {
    await f.getByRole('combobox', { name: '客户端 Key', exact: true }).click()
    check(await f.getByRole('option').count() === 1, 'Only one enabled Key exists in the initial native fixture')
    await f.getByRole('combobox', { name: '搜索选项', exact: true }).fill('Eval client')
    check(await f.getByRole('option').count() === 1, 'A single enabled Key still has the full searchable native selector')
    await f.getByRole('option').click()
    const key = await admin('/api/admin/client-keys/create', { name: 'Review client two', groupIds: [], maxConcurrency: 2, requestsPerMinute: 0 })
    state.reviewKeyId = key.id
    for (const n of [1, 2]) await admin('/api/admin/accounts/import', { provider: 'openai', data: { authentication_kind: 'api_key', name: 'fictional.long.mailbox.' + n + '@example.invalid', base_url: 'http://127.0.0.1:18381/v1', api_key: 'fixture-long-mailbox-' + n, transport: 'http' } })
    writeFileSync(new URL('state.json', root), JSON.stringify(state))
  }
  await f.getByRole('button', { name: '刷新', exact: true }).click()
  await f.getByRole('combobox', { name: '客户端 Key', exact: true }).click()
  await f.getByRole('combobox', { name: '搜索选项', exact: true }).fill('Review client two')
  await f.getByRole('option').filter({ hasText: 'Review client two' }).waitFor()
  check(await f.getByRole('option').count() === 1, 'Key search narrows to the selected account-independent client Key')
  await f.getByRole('option').click()
  check(!(await f.getByRole('combobox', { name: '客户端 Key', exact: true }).innerText()).includes(state.reviewKeyId), 'Unique Key selection shows its readable name without internal ID clutter')
  await f.getByLabel('搜索账号', { exact: true }).fill('@example.invalid')
  const sidebar = await f.getByLabel('下一次检测账号', { exact: true }).boundingBox()
  check(sidebar.width >= 288, 'Account sidebar is at least 18rem wide in the native desktop frame')
  check(await f.locator('.account-row strong').first().evaluate(e => e.title.includes('@example.invalid') && e.clientHeight <= parseFloat(getComputedStyle(e).lineHeight) + 1), 'Long email has an intact full label and a single readable line')
  await theme(warm)
  await f.getByRole('button', { name: '额度说明', exact: true }).click()
  const help = f.getByLabel('额度说明内容', { exact: true })
  check(await help.evaluate(e => parseFloat(getComputedStyle(e).paddingLeft) >= 12 && e.scrollWidth <= e.clientWidth), 'Native help popover has padding and wrapped content')
  await page.screenshot({ path: path('accounts-key-help.png'), fullPage: false })
  await page.keyboard.press('Escape')
  await f.getByLabel('搜索账号', { exact: true }).fill('')
  await f.getByRole('radiogroup', { name: '测试类型' }).getByRole('radio', { name: '糖果题', exact: true }).click()
  await choose('模型', 'eval-markdown')
  await choose('每账号次数', '3 次')
  const previousBatches = new Set((await plugin('api/batches')).records.map(batch => batch.request.id))
  await f.getByRole('button', { name: /^(开始检测|新建检测) ·/ }).click()
  const deadline = Date.now() + 180000
  let created
  while (Date.now() < deadline) {
    created = (await plugin('api/batches')).records.find(batch => !previousBatches.has(batch.request.id))
    if (created?.ready && created.taskIds.length === 6) {
      const rows = (await plugin('api/tasks')).records.filter(row => created.taskIds.includes(row.id))
      if (rows.length === 6 && rows.every(row => row.status === 'completed')) break
    }
    await page.waitForTimeout(250)
  }
  check(!!created && Date.now() < deadline, 'UI completion is correlated with the newly created batch ID and all six durable tasks')
  await f.locator('.current-batch').filter({ hasText: '完成 2 / 2 个账号' }).waitFor({ timeout: 150000 })
  await page.waitForTimeout(1200)
  check(ledger().length - before === 6, 'Two-account repeated-candy UI run sends exactly six controlled requests')
  const batches = await inner.evaluate(async () => {
    const response = await window.codexProxyPlugin.request({ method: 'GET', path: 'api/batches' })
    return JSON.parse(new TextDecoder().decode(response.body)).records
  })
  const latest = batches.find(batch => batch.request.id === created.request.id)
  check(latest.request.clientKeyId === state.reviewKeyId, 'Frozen batch uses the stable ID chosen in the Key selector')
  await openAccount()
  const desktopBox = await result().boundingBox()
  const desktopFooter = await f.getByRole('button', { name: '关闭结果', exact: true }).boundingBox()
  check(desktopBox.y >= 0 && desktopBox.y + desktopBox.height <= 1000 && desktopFooter.y + desktopFooter.height <= 1000, 'Result panel and close button fit the actual host viewport height')
  const answer = f.getByLabel('实际回答', { exact: true })
  await answer.locator('.answer-markdown math').first().waitFor()
  check(await answer.locator('.answer-markdown strong').count() > 0 && await answer.locator('.answer-markdown table').count() === 1 && await answer.locator('.answer-markdown math').count() === 2, 'Actual final-archive Markdown renders emphasis, tables and inline/display MathML')
  check(await answer.evaluate(e => !e.closest('details')), 'Original answers and attempts are directly displayed outside disclosure widgets')
  check(await f.getByLabel('请求详情', { exact: true }).evaluate(e => !e.closest('details')), 'Request facts, IDs, prompts and instructions are directly displayed')
  check(!/\*\*|###|最少取出/.test(await f.getByLabel('每次回答', { exact: true }).innerText()), 'Repeat selectors use short verdict labels without raw Markdown')
  await f.getByLabel('每次回答', { exact: true }).getByRole('button', { name: /^第 2 次/ }).click()
  await answer.getByRole('heading').first().filter({ hasText: '第 2 次' }).waitFor()
  await page.screenshot({ path: path('result-warm.png'), fullPage: false })

  await inner.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(Error('Controlled clipboard denial')) } }))
  await answer.getByRole('radio', { name: '原文', exact: true }).click()
  const original = await answer.locator('.answer-source').textContent()
  await answer.getByRole('button', { name: '复制尝试 1 回答', exact: true }).click()
  check(await f.getByLabel('可选中复制的结果文本').inputValue() === original && original.includes('\\(21\\)'), 'Raw response and copy fallback preserve the exact original Markdown and math delimiters')
  await answer.getByRole('radio', { name: '阅读', exact: true }).click()
  await f.getByText('完整诊断数据', { exact: true }).click()
  await f.getByRole('button', { name: '复制调试 JSON', exact: true }).click()
  const exported = JSON.parse(await f.getByLabel('可选中复制的结果文本').inputValue())
  check(exported.length === 3 && exported.every(row => row.samples.length === 1 && row.pluginVersion === '1.4.1'), 'Diagnostics retain all original repeated responses in the native clipboard fallback')
  await f.getByText('完整诊断数据', { exact: true }).click()
  for (const config of [
    { name: 'dark', mode: 'dark', preset: 'default', color: 'relay-blue', customColor: '#5983F4', customization: {} },
    { name: 'custom', mode: 'dark', preset: 'soft', color: 'custom', customColor: '#8a3ec4', customization: { seed: { fontSize: 15, borderRadius: 14, controlHeight: 44 } } },
  ]) {
    await theme(config)
    if (config.name === 'custom') check(await f.locator('.start-button').evaluate(e => e.getBoundingClientRect().height) === 44, 'Customized host control height reaches the embedded official controls')
    await inner.evaluate(() => { for (const element of document.querySelectorAll('*')) if (element.scrollHeight > element.clientHeight) element.scrollTop = 0 })
    await page.screenshot({ path: path('result-' + config.name + '.png'), fullPage: false })
  }
  await theme(warm)
  await closeResult()
  check(await inner.evaluate(() => document.activeElement?.getAttribute('data-return-account')) === state.accounts.find(account => account.name.endsWith('A')).account_id, 'Result close returns focus to the original account row')

  await f.getByRole('radiogroup', { name: '插件导航' }).getByRole('radio', { name: '记录', exact: true }).click()
  await choose('筛选测试', '糖果题')
  await f.locator('.history-table').getByRole('button', { name: '查看结果', exact: true }).first().click()
  await result().waitFor()
  await openAccount(result())
  await f.getByRole('button', { name: '返回批次总览', exact: true }).click()
  await result().getByLabel('本批次总览', { exact: true }).waitFor()
  await closeResult()
  check((await f.getByRole('combobox', { name: '筛选测试', exact: true }).innerText()).includes('糖果题'), 'History modal preserves filters and returns to the original list')
  await choose('筛选测试', '画鹈鹕')
  await f.locator('.history-table').getByRole('button', { name: '查看结果', exact: true }).first().click()
  await openAccount(result())
  await f.getByRole('button', { name: '放大查看', exact: true }).click()
  await f.getByRole('dialog', { name: '作品预览', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  check(await result().isVisible() && !(await f.getByRole('dialog', { name: '作品预览', exact: true }).isVisible()), 'Escape closes the artwork preview and leaves its parent result dialog open')
  await closeResult()
  await page.reload()
  await f.getByRole('combobox', { name: '客户端 Key', exact: true }).waitFor()
  inner = page.frames().find(frame => frame !== page.mainFrame())
  await f.getByLabel('本批次总览', { exact: true }).waitFor()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await f.locator('.mobile-results').getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
    await result().waitFor()
    const footer = await f.getByRole('button', { name: '关闭结果', exact: true }).boundingBox()
    check(footer.y + footer.height <= 900, 'Close button stays in the visible ' + width + 'px host viewport')
    check(await result().evaluate(e => { const box = e.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1 && e.scrollWidth <= e.clientWidth }), 'Actual result dialog fits ' + width + 'px host viewport without horizontal overflow')
    await page.screenshot({ path: path('result-mobile-' + width + '.png'), fullPage: false })
    await closeResult()
    check(await inner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Native workbench has no horizontal overflow at ' + width + 'px')
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await f.getByLabel('搜索账号', { exact: true }).fill('@example.invalid')
  await page.screenshot({ path: path('overview-warm.png'), fullPage: false })
  check(ledger().length - before === 6, 'Viewing, themes, history, previews, export and reload issue no extra model requests')
  check(errors.length === 0, 'Actual host and final plugin have no JavaScript page errors')
  writeFileSync(path('verification.json'), JSON.stringify({ hostVersion, archiveSha256: state.artifactSha256, checks, themes, controlledUiCalls: 6, realModelRequests: 0, javascriptErrors: errors }, null, 2))
} finally {
  await browser.close()
}
