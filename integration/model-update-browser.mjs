import { chromium } from '../frontend/node_modules/playwright/index.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const work = new URL('../.runtime/integration/', import.meta.url)
const read = name => JSON.parse(readFileSync(new URL(name, work)))
const control = read('control.json')
const state = read('state.json')
assert.equal(control.base, 'http://127.0.0.1:18380')
assert.equal(control.username, 'eval-admin')
const before = read('upstream-observations.json').models.length
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
  const login = await context.request.post(control.base + '/api/auth/login', {
    headers: { Origin: control.base },
    data: { mode: 'admin', username: control.username, password: control.password },
  })
  assert(login.ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(control.base + '/plugins/' + state.instanceId + '/codex-candy-eval')
  const frame = page.frameLocator('iframe')
  const configuration = frame.getByRole('combobox', { name: '绘图题目', exact: true })
  await configuration.getByText('经典 SVG（原题）', { exact: true }).waitFor()
  await frame.getByLabel('本批次总览', { exact: true }).getByRole('table').getByText('标准 SVG v1', { exact: true }).waitFor()
  await frame.getByRole('radio', { name: '记录', exact: true }).click()
  await frame.locator(`.history-table [data-return-history="${state.modelUpdateDrawingBatch}"]`).click()
  const overview = frame.getByRole('dialog', { name: '批次结果', exact: true })
  await overview.getByRole('button', { name: '查看 Eval account A 结果', exact: true }).click()
  const result = frame.getByRole('dialog', { name: '检测结果', exact: true })
  await result.getByText('Generate an SVG of a pelican riding a bicycle', { exact: true }).waitFor()
  const image = result.getByAltText('鹈鹕绘图预览')
  assert.deepEqual(await image.evaluate(async img => {
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 120
    const context = canvas.getContext('2d')
    context.drawImage(img, 0, 0, 240, 120)
    return [45, 195].map(x => context.getImageData(x, 49, 1, 3).data.some((value, i) => i % 4 === 3 && value > 64))
  }), [true, true])
  await page.setViewportSize({ width: 390, height: 820 })
  assert(await result.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1))
  assert.deepEqual(errors, [])
  assert.equal(read('upstream-observations.json').models.length, before)
  const checks = [
    'A restored draft defaults to the classic prompt while the saved batch keeps its v1 label',
    'The native result shows the classic source prompt and renders pixels from both local wheel references',
    '390px viewport fits the report; viewing adds zero model calls and raises zero page errors',
  ]
  writeFileSync(new URL('model-update-browser.json', work), JSON.stringify({ checks, archiveSha256: state.artifactSha256 }, null, 2))
  for (const check of checks) console.log('PASS: ' + check)
} finally {
  await browser.close()
}
