import { chromium } from '../frontend/node_modules/playwright/index.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const hostVersion = process.argv[2]
if (!['3.43.1', '3.44.0'].includes(hostVersion)) throw Error('Explicit official CPR version required')
const version = process.argv[3] ?? '1.4.2'
if (!['1.4.2', '1.4.3'].includes(version)) throw Error('Unsupported report check version')
const compactHistory = version === '1.4.3'
const existingCiallo = process.argv[4] === '--verify-existing-ciallo'
if (existingCiallo && !compactHistory) throw Error('Existing Ciallo verification requires 1.4.3')
const work = new URL('../.runtime/integration/', import.meta.url)
const read = name => JSON.parse(readFileSync(new URL(name, work)))
const control = read('control.json'), state = read('state.json')
if (control.base !== 'http://127.0.0.1:18380' || control.username !== 'eval-admin') throw Error('Only the disposable loopback host is accepted')
const output = new URL(`ui${version.replaceAll('.', '')}-${hostVersion}/`, work)
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
const direct = (batch, account) => f.locator(`.history-table [data-return-history="${batch}:${compactHistory ? 'accounts' : account}"]`)
const detailName = name => detail.locator('.result-identity').getByText(name, { exact: true })
const accountMenu = f.getByRole('dialog', { name: '查看批次账号', exact: true })
async function selectHistoryAccount(origin, search, name) {
  await origin.click()
  if (!compactHistory) return
  await accountMenu.getByRole('textbox', { name: '搜索批次账号', exact: true }).fill(search)
  await accountMenu.getByRole('button', { name: `查看 ${name} 结果`, exact: true }).click()
}
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
  if (compactHistory) await page.getByText('糖果题、模型指纹、画鹈鹕与 Ciallo', { exact: true }).waitFor()
  await f.getByLabel('本批次总览', { exact: true }).waitFor()
  let inner = await (await outerFrame.elementHandle()).contentFrame()
  const plugin = (path, data) => inner.evaluate(async ({ path, data }) => {
    const reply = await window.codexProxyPlugin.request(data === undefined ? { method: 'GET', path } : {
      method: 'POST', path, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(data)).buffer,
    })
    if (reply.status !== 200) throw Error('Controlled plugin read failed')
    return JSON.parse(new TextDecoder().decode(reply.body))
  }, { path, data })
  const restoredCialloId = existingCiallo ? (await plugin('api/workspace')).draft?.batchId : undefined
  if (compactHistory) await f.getByRole('radio', { name: '糖果题', exact: true }).click()
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
  await selectHistoryAccount(source, b, 'Eval account B')
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
  await selectHistoryAccount(direct(state.fingerprintBatchId, a), a, 'Eval account A')
  await detail.locator('.ranking').waitFor()
  check(await detail.locator('.sample-strip > div').count() === 3, 'Fingerprint report retains three sample statuses and the ranking')
  await page.keyboard.press('Escape')
  await overview.getByRole('button', { name: '关闭批次', exact: true }).click()
  await choose(f, '筛选测试', '画鹈鹕')
  await selectHistoryAccount(direct(state.drawingBatchId, a), a, 'Eval account A')
  await detail.getByRole('button', { name: '放大查看', exact: true }).click()
  const artwork = f.getByRole('dialog', { name: '作品预览', exact: true })
  await artwork.waitFor()
  await page.keyboard.press('Escape')
  await artwork.waitFor({ state: 'hidden' })
  check(await detail.isVisible(), 'Escape closes a nested artwork preview and leaves the account report open')
  await detail.getByRole('button', { name: '返回批次', exact: true }).click()
  await overview.getByRole('button', { name: '关闭批次', exact: true }).click()
  if (compactHistory) {
    await choose(f, '筛选测试', 'Ciallo')
    await f.locator(`.history-table [data-return-history="${state.incompleteCialloBatchId}"]`).click()
    const partial = overview.locator('.desktop-results')
    await partial.locator(`[data-result-account="${a}"]`).getByText('Partial Ciallo fixture.', { exact: true }).waitFor()
    check((await partial.locator(`[data-execution-account="${a}"]`).innerText()) === '未完成'
      && !(await partial.innerText()).includes('完整返回'), 'Incomplete Ciallo stays incomplete while its saved partial reply is visible outside account details')
    await screenshot('ciallo-incomplete')
    await overview.getByRole('button', { name: '关闭批次', exact: true }).click()
  }
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
  check(read('upstream-observations.json').models.length === before && errors.length === 0, 'Navigation and report viewing cause no model calls or page errors')
  let controlledUiCalls = 0
  if (compactHistory) {
    await page.setViewportSize({ width: 1440, height: 960 })
    await scrollHost(-10000)
    const longName = 'fictional.long.mailbox.with-a-very-long-account-name@example.invalid'
    if (!(await plugin('api/snapshot')).accounts.some(account => account.name === longName)) {
      const imported = await context.request.post(control.base + '/api/admin/accounts/import', { headers: { Origin: control.base }, data: {
        provider: 'openai', data: { authentication_kind: 'api_key', name: longName, base_url: 'http://127.0.0.1:18381/v1', api_key: 'controlled-fixture-F', transport: 'http' },
      } })
      if (!imported.ok()) throw Error('Controlled long-name fixture was not imported')
      await f.getByRole('button', { name: '刷新', exact: true }).click()
    }
    await f.getByLabel(`选择 ${longName}`, { exact: true }).waitFor()
    await f.getByRole('radio', { name: 'Ciallo', exact: true }).click()
    await choose(f, '模型', 'eval-ciallo')
    await f.getByRole('button', { name: '选择筛选结果', exact: true }).click()
    const configuration = f.getByLabel('下一次检测配置', { exact: true })
    check((await configuration.innerText()).includes('6 次计划请求') && (await configuration.locator('.fixed-message').innerText()) === 'ciallo', 'Native UI previews a fixed ciallo message and exactly one planned request per account')
    const oldBatches = new Set((await plugin('api/batches')).records.map(batch => batch.request.id))
    if (!existingCiallo) await f.getByRole('button', { name: /^(开始检测|新建检测) ·/ }).click()
    const deadline = Date.now() + 150000
    let fresh, done = []
    while (Date.now() < deadline) {
      fresh = (await plugin('api/batches')).records.find(batch => batch.request.kind === 'ciallo' && (existingCiallo ? batch.request.id === restoredCialloId : !oldBatches.has(batch.request.id)))
      if (fresh?.ready && fresh.taskIds.length === 6) {
        done = (await plugin('api/tasks')).records.filter(row => fresh.taskIds.includes(row.id) && row.status === 'completed' && row.verdict === 'responded')
        if (done.length === 6) break
      }
      await page.waitForTimeout(350)
    }
    const reports = await Promise.all(done.map(row => plugin('api/task', { id: row.id })))
    check(done.length === 6 && new Set(done.map(row => row.accountId)).size === 6 && reports.every(({ record }) => record.attempts.length === 1), 'Six distinct Ciallo accounts return text without grading or repeated attempts')
    await f.locator('.current-batch').filter({ hasText: '完成 6 / 6 个账号' }).waitFor()
    const currentOverview = f.locator('.batch-results .desktop-results')
    const headers = await currentOverview.getByRole('columnheader').allTextContents()
    check(JSON.stringify(headers) === JSON.stringify(['账号', '执行情况', '检测结果', '耗时', '操作']), 'Batch overview uses the selected separate execution and result columns without a Samples column')
    await poll(async () => await currentOverview.locator('.reply-preview').count() === 6, 'Six outside reply previews did not appear')
    check((await currentOverview.locator('.reply-preview').allTextContents()).every(text => text === 'Hello from the Ciallo fixture.')
      && (await currentOverview.locator('[data-execution-account]').allTextContents()).every(text => text === '完整返回'), 'Every Ciallo account shows its actual reply and completion status before opening a result dialog')
    await screenshot('ciallo-overview')
    const sendStart = existingCiallo ? before - 6 : before
    await poll(() => read('upstream-observations.json').models.length === sendStart + 6, 'Ciallo ledger did not match six sends')
    const sends = read('upstream-observations.json').timeline.slice(sendStart)
    check(sends.length === 6 && new Set(sends.map(item => item.account)).size === 6 && sends.every(item => item.model === 'eval-ciallo' && item.plainCiallo), 'Actual upstream receives only the one-word ciallo user message on each pinned account')
    controlledUiCalls = sends.length

    await f.getByRole('radio', { name: '记录', exact: true }).click()
    await choose(f, '筛选测试', '全部测试')
    const picker = direct(fresh.request.id)
    await picker.waitFor()
    check(await picker.evaluate(button => {
      const cell = button.closest('td')
      return cell.querySelectorAll('button').length === 1 && !cell.innerText.includes('@')
    }), 'Six-account history row renders one compact control and no inline emails')
    await screenshot('compact-history')
    await picker.click()
    await accountMenu.getByText(longName, { exact: true }).waitFor()
    const menuSearch = accountMenu.getByRole('textbox', { name: '搜索批次账号', exact: true })
    await menuSearch.fill('very-long-account')
    check(await accountMenu.getByRole('button').count() === 1, 'Account popup searches a long email without truncating its identity')
    await screenshot('history-account-menu')
    await accountMenu.getByRole('button', { name: `查看 ${longName} 结果`, exact: true }).click()
    await detailName(longName).waitFor()
    await detail.getByLabel('实际回答', { exact: true }).getByText('Hello from the Ciallo fixture.', { exact: true }).waitFor()
    await detail.getByLabel('请求概况', { exact: true }).getByText('25 Token', { exact: true }).waitFor()
    await detail.getByLabel('请求详情', { exact: true }).getByText('ciallo', { exact: true }).waitFor()
    check(true, 'Account report displays the real fixture reply, usage and original prompt')
    await screenshot('ciallo')
    await detail.getByRole('button', { name: '返回批次', exact: true }).click()
    await overview.getByRole('button', { name: '关闭批次', exact: true }).click()
    await poll(() => picker.evaluate(el => document.activeElement === el), 'Six-account picker did not regain focus')
    await page.setViewportSize({ width: 390, height: 800 })
    const narrowPicker = f.locator(`.mobile-results [data-return-history="${fresh.request.id}:accounts"]`)
    await narrowPicker.click()
    await menuSearch.fill('very-long-account')
    check(await accountMenu.evaluate(el => {
      const rect = el.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth && document.documentElement.scrollWidth <= innerWidth
    }), 'Narrow native history keeps the full account menu inside the plugin width')
    await page.keyboard.press('Escape')
    await accountMenu.waitFor({ state: 'hidden' })
    await page.reload()
    await f.locator('.current-batch').filter({ hasText: '本批次 · Ciallo' }).waitFor()
    inner = await (await outerFrame.elementHandle()).contentFrame()
    await f.locator('.mobile-results .reply-preview').first().getByText('Hello from the Ciallo fixture.', { exact: true }).waitFor()
    check(await f.locator('.mobile-results .reply-preview').first().evaluate(el => getComputedStyle(el).webkitLineClamp === '2' && document.documentElement.scrollWidth <= innerWidth), 'Native mobile Ciallo overview keeps its two-line reply preview without horizontal overflow')
    await screenshot('ciallo-overview-mobile')
    check((await plugin('api/workspace')).draft.batchId === fresh.request.id && read('upstream-observations.json').models.length === sendStart + 6 && errors.length === 0, 'Reload restores the Ciallo batch, with no extra model calls from account browsing')
  }
  writeFileSync(new URL('verification.json', output), JSON.stringify({ hostVersion, archiveSha256: state.artifactSha256, checks, controlledUiCalls, ...(existingCiallo ? { continuedAfterSubmission: true } : {}), realModelRequests: 0, javascriptErrors: errors }, null, 2))
} finally {
  await browser.close()
}
