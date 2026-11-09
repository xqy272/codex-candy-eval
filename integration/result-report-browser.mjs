import { chromium } from '../frontend/node_modules/playwright/index.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hostVersion = process.argv[2]
if (!['3.43.1', '3.44.0'].includes(hostVersion)) throw Error('Explicit official CPR version required')
const work = new URL('../.runtime/integration/', import.meta.url)
const read = name => JSON.parse(readFileSync(new URL(name, work)))
const control = read('control.json'), state = read('state.json')
if (control.base !== 'http://127.0.0.1:18380' || control.username !== 'eval-admin') throw Error('Only the disposable loopback host is accepted')
const output = new URL(`ui142-${hostVersion}/`, work)
mkdirSync(output, { recursive: true })
const checks = [], errors = []
const check = (pass, label) => { if (!pass) throw Error(label); checks.push(label); console.log('PASS: ' + label) }
const before = read('upstream-observations.json').models.length
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
const page = await context.newPage()
page.setDefaultTimeout(12000)
page.on('pageerror', error => errors.push(error.message))
const outerFrame = page.locator('iframe')
const f = page.frameLocator('iframe')
const detail = f.getByRole('dialog', { name: '检测结果', exact: true })
const overview = f.getByRole('dialog', { name: '批次结果', exact: true })
const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name + '.png', output)) })
const [a, b] = ['A', 'B'].map(letter => state.accounts.find(account => account.name.endsWith(letter)).account_id)
const direct = (batch, account) => f.locator(`.history-table [data-return-history="${batch}:${account}"]`)
const detailName = name => detail.locator('.result-identity').getByText(name, { exact: true })
const choose = async (scope, name, option) => {
  await scope.getByRole('combobox', { name, exact: true }).click()
  await f.getByRole('option', { name: option, exact: true }).click()
}
async function poll(fn, label) {
  for (let i = 0; i < 60; i++) {
    if (await fn()) return
    await page.waitForTimeout(100)
  }
  throw Error(label)
}
const timestamp = locator => locator.evaluate(el => ({ value: el.dateTime, weight: Number(getComputedStyle(el).fontWeight), size: getComputedStyle(el).fontSize }))
const scrollHost = delta => outerFrame.evaluate((frame, dy) => {
  const scrollables = [document.scrollingElement]
  for (let el = frame.parentElement; el; el = el.parentElement) {
    if (['scroll', 'auto'].includes(getComputedStyle(el).overflowY)) scrollables.unshift(el)
  }
  const el = scrollables.find(el => el && el.scrollHeight > el.clientHeight + 50)
  if (el) el.scrollBy({ top: dy, behavior: 'instant' })
  return frame.getBoundingClientRect().top
}, delta)
const footerReachable = label => detail.getByRole('button', { name: label, exact: true }).boundingBox().then(async box => {
  if (!box || box.y < 0 || box.y + box.height > page.viewportSize().height + 1) return false
  return outerFrame.evaluate((frame, { x, y }) => document.elementFromPoint(x, y) === frame, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
})

try {
  const login = await context.request.post(control.base + '/api/auth/login', { headers: { Origin: control.base }, data: { mode: 'admin', username: control.username, password: control.password } })
  if (!login.ok()) throw Error('Loopback login failed')
  await page.goto(control.base + '/plugins/' + state.instanceId + '/codex-candy-eval')
  await f.getByLabel('本批次总览', { exact: true }).waitFor()
  const inner = await (await outerFrame.elementHandle()).contentFrame()
  const plugin = path => inner.evaluate(async path => {
    const reply = await window.codexProxyPlugin.request({ method: 'GET', path })
    if (reply.status !== 200) throw Error('Controlled plugin read failed')
    return JSON.parse(new TextDecoder().decode(reply.body))
  }, path)
  const [{ records: tasks }, { records: batches }] = await Promise.all([plugin('api/tasks'), plugin('api/batches')])
  check(tasks.every(row => !['queued', 'running', 'scoring'].includes(row.status)), 'Controlled tasks are quiescent before read-only UI verification')
  const oldBatch = batches.find(batch => batch.request.id === state.preservedBatchId)
  const oldTasks = oldBatch.taskIds.map(id => tasks.find(row => row.id === id))
  const reportTask = oldTasks.find(row => row.accountId === a)
  check(await page.evaluate(config => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('theme').setThemeConfiguration(config),
    { name: 'warm-soft', mode: 'light', preset: 'soft', color: 'custom', customColor: '#a94635', customization: { seed: { colorBgBase: '#fbf7ec', colorTextBase: '#302a25' } } }), 'Native CPR accepts the warm theme used for screenshots')
  const batchHeader = f.locator('.current-batch')
  const batchTime = await timestamp(batchHeader.locator('time'))
  check(await batchHeader.locator('time').count() === 1 && (await batchHeader.innerText()).includes('完成于') && batchTime.value === new Date(Math.max(...oldTasks.map(row => row.updatedAt))).toISOString(), 'Test batch shows exactly one timestamp from the last saved completion')
  await screenshot('batch')
  await f.locator('.desktop-results').getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
  const detected = await timestamp(detail.locator('.detection-time time'))
  check(detected.value === new Date(reportTask.startedAt).toISOString() && detected.weight >= 600 && detected.weight === batchTime.weight && detected.size === batchTime.size, 'Account detection time keeps its original value and uses the same full bold date and time as the batch')
  await detail.getByRole('button', { name: '关闭结果', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })

  await page.setViewportSize({ width: 1440, height: 600 })
  await f.locator('.desktop-results').getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
  const firstTop = await scrollHost(10000)
  const localTop = () => inner.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--eval-visible-top')) || 0)
  await poll(async () => await localTop() > 60 && await footerReachable('关闭结果'), 'Dialog footer did not follow the scrolled native host')
  check(firstTop < -60, 'Real host scroll clips the top of the iframe while the result is open')
  check(await detail.evaluate(panel => {
    const scrim = panel.parentElement.querySelector(':scope > button')
    const rect = scrim.getBoundingClientRect()
    const visibleTop = parseFloat(document.documentElement.style.getPropertyValue('--eval-visible-top'))
    const visibleHeight = parseFloat(document.documentElement.style.getPropertyValue('--eval-visible-height'))
    return Math.abs(rect.top) <= 1 && rect.bottom >= innerHeight - 1 && document.elementFromPoint(1, visibleTop + visibleHeight - 2) === scrim
  }), 'The native backdrop spans and blocks clicks across the full iframe height')
  const scrolledTop = await localTop()
  await scrollHost(-10000)
  await poll(async () => await localTop() < scrolledTop - 40 && await footerReachable('关闭结果'), 'Dialog footer did not follow reverse host scroll')
  check(true, 'Dialog tracks host scrolling in both directions and keeps the footer clickable')
  await page.setViewportSize({ width: 1440, height: 740 })
  await poll(() => footerReachable('关闭结果'), 'Dialog footer did not follow viewport resize')
  check(true, 'Dialog keeps the footer inside the native viewport after resizing')
  await detail.getByRole('button', { name: '关闭结果', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })

  await page.setViewportSize({ width: 1440, height: 960 })
  await scrollHost(-10000)
  await f.getByRole('radio', { name: '记录', exact: true }).click()
  await choose(f, '筛选测试', '糖果题')
  const source = direct(state.candyBatchId, b)
  await source.click()
  await detailName('Eval account B').waitFor()
  const request = detail.getByLabel('请求概况', { exact: true })
  const answer = detail.getByLabel('实际回答', { exact: true })
  const [answerBox, requestBox] = await Promise.all([answer.boundingBox(), request.boundingBox()])
  check(requestBox.x > answerBox.x && (await request.innerText()).includes('eval-markdown') && (await request.innerText()).includes('Token'), 'Named history shortcut opens the correct account directly with a side-by-side request and token summary')
  await answer.locator('.answer-markdown table').waitFor()
  check(await answer.locator('.answer-markdown math').count() === 2 && await answer.locator('.answer-markdown strong').count() >= 1 && await detail.getByLabel('请求详情', { exact: true }).isVisible() && !(await detail.locator('.evidence').evaluate(el => el.open)), 'Rendered answer preserves math and Markdown; request body is visible and full diagnostics are folded')
  await screenshot('result')
  await answer.getByRole('radio', { name: '原文', exact: true }).click()
  check((await answer.locator('.answer-source').innerText()).includes('**最少取出'), 'Source mode still exposes the original answer verbatim')
  await choose(detail, '切换批次账号', 'Eval account A')
  await detailName('Eval account A').waitFor()
  await page.keyboard.press('Escape')
  await overview.waitFor()
  check(await overview.locator('time, .request-summary, .request-evidence').count() === 0, 'Escape returns to a simple batch overview with no duplicate report details')
  await screenshot('history-batch')
  await overview.getByRole('button', { name: '查看 Eval account B 结果', exact: true }).click()
  await detailName('Eval account B').waitFor()
  await detail.getByRole('button', { name: '返回批次', exact: true }).click()
  await overview.getByRole('button', { name: '关闭批次', exact: true }).click()
  await overview.waitFor({ state: 'hidden' })
  await poll(() => source.evaluate(el => document.activeElement === el), 'History entry did not regain focus')
  check((await f.getByRole('combobox', { name: '筛选测试', exact: true }).innerText()).includes('糖果题'), 'Explicit back and close preserve the history filter and focus on the original shortcut')

  await choose(f, '筛选测试', '模型指纹')
  await direct(state.fingerprintBatchId, a).click()
  await detail.locator('.ranking').waitFor()
  check(await detail.locator('.sample-strip > div').count() === 3, 'Fingerprint report retains three sample statuses and the ranking')
  await page.keyboard.press('Escape')
  await overview.getByRole('button', { name: '关闭批次', exact: true }).click()
  await choose(f, '筛选测试', '画鹈鹕')
  await direct(state.drawingBatchId, a).click()
  await detail.getByRole('button', { name: '放大查看', exact: true }).click()
  const artwork = f.getByRole('dialog', { name: '作品预览', exact: true })
  await artwork.waitFor()
  await page.keyboard.press('Escape')
  await artwork.waitFor({ state: 'hidden' })
  check(await detail.isVisible(), 'Escape closes a nested artwork preview and leaves the account report open')
  await detail.getByRole('button', { name: '返回批次', exact: true }).click()
  await overview.getByRole('button', { name: '关闭批次', exact: true }).click()
  await f.getByRole('radio', { name: '测试', exact: true }).click()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 })
    await f.locator('.mobile-results').getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
    await poll(() => footerReachable('关闭结果'), `Footer unreachable at ${width}px`)
    check(await detail.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth && document.documentElement.scrollWidth <= innerWidth), `Report and its close button fit the ${width}px native host`)
    await screenshot('result-mobile-' + width)
    await detail.getByRole('button', { name: '关闭结果', exact: true }).click()
    await detail.waitFor({ state: 'hidden' })
  }
  const modelRequests = read('upstream-observations.json').models.length - before
  check(modelRequests === 0 && errors.length === 0, 'Navigation and report viewing cause no model calls or page errors')
  writeFileSync(new URL('verification.json', output), JSON.stringify({ hostVersion, archiveSha256: state.artifactSha256, checks, controlledUiCalls: modelRequests, realModelRequests: 0, javascriptErrors: errors }, null, 2))
} finally {
  await browser.close()
}
