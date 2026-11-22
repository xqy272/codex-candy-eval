import { chromium } from '../frontend/node_modules/playwright/index.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const stage = process.argv[2]
if (!['before', 'after'].includes(stage)) throw Error('Use before or after against the disposable CPR host')
const work = new URL('../.runtime/integration/', import.meta.url)
const read = name => JSON.parse(readFileSync(new URL(name, work), 'utf8'))
const control = read('control.json'), state = read('state.json'), saved = read('paused145-before.json')
if (control.base !== 'http://127.0.0.1:18380' || control.username !== 'eval-admin') throw Error('Only the controlled loopback host is accepted')
const output = new URL('paused145-ui/', work)
mkdirSync(output, { recursive: true })
const checks = [], errors = [], startCalls = read('upstream-observations.json').models.length
const check = (value, message) => { if (!value) throw Error(message); checks.push(message); console.log('PASS: ' + message) }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
const page = await context.newPage()
page.setDefaultTimeout(12000)
page.on('pageerror', error => errors.push(error.message))
const f = page.frameLocator('iframe')
const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name + '.png', output)) })
async function waitFor(fn, message, seconds = 30) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(200) }
  throw Error(message)
}
try {
  const login = await context.request.post(control.base + '/api/auth/login', { headers: { Origin: control.base }, data: { mode: 'admin', username: control.username, password: control.password } })
  if (!login.ok()) throw Error('Loopback login failed')
  await page.goto(control.base + '/plugins/' + state.instanceId + '/codex-candy-eval')
  const allowance = f.getByLabel('队列余量', { exact: true })
  await allowance.waitFor()
  let inner = await (await page.locator('iframe').elementHandle()).contentFrame()
  const plugin = (path, data) => inner.evaluate(async ({ path, data }) => {
    const response = await window.codexProxyPlugin.request(data === undefined ? { method: 'GET', path } : {
      method: 'POST', path, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(data)).buffer,
    })
    if (response.status !== 200) throw Error('Controlled plugin request failed')
    return JSON.parse(new TextDecoder().decode(response.body))
  }, { path, data })
  const start = f.locator('.start-button')
  if (stage === 'before') {
    await waitFor(async () => (await allowance.innerText()).includes('剩余 7 / 16'), 'Old allowance not restored')
    check((await allowance.innerText()).includes('本次需要 8 个') && await start.isDisabled(), 'Released 1.4.4 visibly blocks eight accounts with seven free places despite no active work')
    check((await plugin('api/tasks')).records.every(r => !['queued', 'running', 'scoring'].includes(r.status)), 'The reproduced old screen has no queued, running or scoring tasks')
    await screenshot('before')
    check(read('upstream-observations.json').models.length === startCalls, 'Viewing the reproduced old state sends no model requests')
  } else {
    await waitFor(async () => (await allowance.innerText()).includes('剩余 16 / 16'), 'New allowance not restored')
    check((await allowance.innerText()).includes('本次需要 8 个') && await start.isEnabled(), 'Final 1.4.5 restores all sixteen places and allows the same eight selected accounts')
    check((await f.getByLabel('未完成检测', { exact: true }).innerText()).includes('另有 9 个未完成检测'), 'The native page explains that nine saved incomplete records do not occupy the queue')
    await screenshot('after')
    const oldIds = new Set((await plugin('api/batches')).records.map(b => b.request.id))
    await start.click()
    let fresh
    await waitFor(async () => {
      fresh = (await plugin('api/batches')).records.find(b => !oldIds.has(b.request.id))
      if (!fresh || fresh.taskIds.length !== 8) return false
      const rows = (await plugin('api/tasks')).records.filter(r => fresh.taskIds.includes(r.id))
      return rows.length === 8 && rows.every(r => r.status === 'completed' && r.verdict === 'responded')
    }, 'The new eight-account batch did not finish', 180)
    await waitFor(() => read('upstream-observations.json').models.length === startCalls + 8, 'Fixture ledger did not receive exactly eight requests')
    const sends = read('upstream-observations.json').timeline.slice(startCalls)
    check(sends.length === 8 && new Set(sends.map(t => t.account)).size === 8 && sends.every(t => t.model === 'eval-ciallo' && t.plainCiallo), 'One click completes exactly eight pinned Ciallo requests, one per controlled account')
    for (let n = 0; n < state.pausedTaskIds.length; n++) {
      check(JSON.stringify(await plugin('api/task', { id: state.pausedTaskIds[n] })) === JSON.stringify(saved.pausedDetails[n]), 'Original paused task ' + (n + 1) + ' remains unchanged after the new batch')
    }
    check(read('upstream-observations.json').models.filter(m => m === 'eval-incomplete').length === 1, 'The uncertain fingerprint is never automatically replayed')
    await waitFor(async () => (await f.locator('.current-batch').innerText()).includes('完成 8 / 8 个账号'), 'Native completion display did not update')
    await screenshot('eight-completed')
    await f.getByRole('radiogroup', { name: '插件导航', exact: true }).getByRole('radio', { name: '记录', exact: true }).click()
    await f.locator(`.history-table [data-return-history="${state.pausedBatchId}"]`).click()
    const overview = f.getByRole('dialog', { name: '批次结果', exact: true })
    const stop = overview.getByRole('button', { name: '停止本批次', exact: true })
    await stop.waitFor()
    check(true, 'An entirely paused old batch exposes the native batch-wide stop control')
    await stop.click()
    await waitFor(async () => !(await stop.count()), 'Batch-wide stop did not finish')
    const oldBatch = (await plugin('api/batches')).records.find(b => b.request.id === state.pausedBatchId)
    const stopped = (await plugin('api/tasks')).records.filter(r => oldBatch.taskIds.includes(r.id))
    check(stopped.length === 8 && stopped.every(r => r.status === 'stopped'), 'The native batch-wide stop covers all eight paused account tasks')
    for (let n = 1; n < state.pausedTaskIds.length; n++) {
      const id = state.pausedTaskIds[n]
      const task = (await plugin('api/task', { id })).record
      if (JSON.stringify(await plugin('api/sample', { id, key: task.attempts[0].key })) !== JSON.stringify(saved.pausedSamples[n])) throw Error('Stopping changed a saved answer')
    }
    check(true, 'Stopping the paused batch preserves every original stored answer')
    await overview.getByRole('button', { name: '关闭批次', exact: true }).click()
    await overview.waitFor({ state: 'hidden' })
    await f.getByRole('radiogroup', { name: '插件导航', exact: true }).getByRole('radio', { name: '测试', exact: true }).click()
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      check(await allowance.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Queue allowance and saved-incomplete notice fit the ' + width + 'px native viewport')
      await screenshot('after-' + width)
    }
    await page.reload()
    await f.locator('.current-batch').waitFor()
    inner = await (await page.locator('iframe').elementHandle()).contentFrame()
    check((await plugin('api/workspace')).draft.batchId === fresh.request.id && read('upstream-observations.json').models.length === startCalls + 8, 'Reload restores the new batch with no extra model requests')
    const latest = read('state.json')
    writeFileSync(new URL('state.json', work), JSON.stringify({ ...latest, newEightBatchId: fresh.request.id }, null, 2))
  }
  check(errors.length === 0, 'The native page produces no JavaScript errors')
  writeFileSync(new URL(`paused145-ui-${stage}.json`, work), JSON.stringify({ stage, archiveSha256: stage === 'after' ? state.artifactSha256 : state.baselineSha256, checks, controlledUiCalls: stage === 'after' ? 8 : 0, realModelRequests: 0, javascriptErrors: errors }, null, 2))
} finally {
  await browser.close()
}
