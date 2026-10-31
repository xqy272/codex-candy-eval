import { test, expect, type Page } from '@playwright/test'
import { resolveTheme, DEFAULT_THEME_COLOR, DEFAULT_CUSTOM_THEME_COLOR } from '@codex-proxy/ui/theme'
import { readFileSync } from 'node:fs'

// 使用宿主同样的 data 资源与 CSP，避免普通网页测试掩盖插件 iframe 限制。
const asset = (name: string, type: string) => `data:${type};base64,${readFileSync(new URL(`../dist/${name}`, import.meta.url)).toString('base64')}`
const csp = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'"
const assembled = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8').replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`).replace('./app.js', asset('app.js', 'text/javascript')).replace('./app.css', asset('app.css', 'text/css'))

async function mock(page: Page, options: { empty?: boolean; error?: boolean; dark?: boolean; slow?: boolean } = {}) {
  await page.route('http://127.0.0.1:4173/', route => route.fulfill({ contentType: 'text/html', body: assembled }))
  const resolved = resolveTheme(options.dark ? 'dark' : 'light', DEFAULT_THEME_COLOR, DEFAULT_CUSTOM_THEME_COLOR)
  await page.addInitScript(({ options, resolved }) => {
    let finish: ((value: unknown) => void) | undefined
    const saved = new Map<string, any>()
    const encode = (value: unknown) => ({ status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(value)).buffer })
    ;(window as any).__requests = []
    const bridge = {
      theme: resolved.name,
      request: async (input: any) => {
        const data = input.body ? JSON.parse(new TextDecoder().decode(input.body)) : null
        ;(window as any).__requests.push({ path: input.path, data })
        if (options.error) return { ...encode({ error: { message: '模拟宿主读取失败' } }), status: 502 }
        if (input.path === 'api/snapshot') return encode({ accounts: options.empty ? [] : [{ account_id: 'a1', name: '测试账号 A', email: 'a@example.invalid', enabled: true }, { account_id: 'a2', name: '测试账号 B', email: null, enabled: false }], keys: options.empty ? [] : [{ id: 'k1', name: '测试 Key', enabled: true }], detectorVersion: 'fixture' })
        if (input.path === 'api/models') return encode({ models: ['gpt-test'] })
        if (input.path === 'api/history') return encode({ records: [...saved.values()] })
        if (input.path === 'api/cancel') { finish?.('cancelled'); return encode({ cancelled: true }) }
        if (input.path === 'api/run') {
          const state = options.slow ? await new Promise(resolve => { finish = resolve }) : 'completed'
          const text = data.kind === 'pelican' ? '<style>body{background:#eef5ff}</style><svg width="300" height="180"><text x="20" y="80">Pelican fixture</text></svg><script>parent.__unsafe = true;fetch("https://example.invalid/leak")</script><img src="https://example.invalid/leak" onerror="parent.__unsafe=true"><a href="https://example.invalid/">unsafe link</a>' : '21'
          const nextStep = data.kind === 'fingerprint' && data.step < 2 && state !== 'cancelled' ? data.step + 1 : null
          const sample = { status: state, prompt: '固定测试题目', instructions: '', requestId: 'mock-request', durationMs: 1250, answer: { text, usage: {} } }
          const record = { ...data, status: state === 'cancelled' ? 'cancelled' : nextStep !== null ? 'partial' : data.kind === 'candy' ? 'correct' : 'completed', startedAt: Date.now(), durationMs: 1250, detectorVersion: 'fixture', samples: [...(saved.get(data.id)?.samples ?? []), sample], attribution: data.kind === 'fingerprint' && nextStep === null ? { prediction_name: '参考候选 A', results: [{ display_name: '参考候选 A', score: 1.2345, probability: 0.8 }] } : null }
          saved.set(data.id, record)
          return encode({ persisted: true, nextStep, record })
        }
        throw new Error('Unexpected mock route')
      },
    }
    Object.defineProperty(window, 'codexProxyPlugin', { value: bridge })
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.dataset.theme = resolved.name
      for (const [key, value] of Object.entries(resolved.tokens)) document.documentElement.style.setProperty(key, value as string)
      document.body.style.background = options.dark ? '#141414' : '#f7f8fa'
      document.body.style.padding = '16px'
    })
  }, { options, resolved })
}
test('empty and failure states', async ({ page }, info) => {
  await mock(page, { empty: true }); await page.goto('/')
  await expect(page.getByText('暂无 OpenAI 账号')).toBeVisible()
  await expect(page.getByRole('button', { name: '测试所选账号' })).toBeDisabled()
  await page.screenshot({ path: info.outputPath('empty.png'), fullPage: true })
})
test('read failure is visible', async ({ page }) => {
  await mock(page, { error: true }); await page.goto('/')
  await expect(page.getByRole('alert')).toHaveText('模拟宿主读取失败')
})
test('one-account candy, export and disabled account', async ({ page }, info) => {
  await mock(page); await page.goto('/')
  await expect(page.getByLabel('选择 测试账号 B')).toBeDisabled()
  await page.getByRole('button', { name: '测试', exact: true }).first().click()
  await expect(page.getByText('答对', { exact: true })).toBeVisible()
  await expect(page.getByLabel('选择 测试账号 A')).not.toBeChecked()
  await page.getByRole('button', { name: 'JSON 导出' }).click()
  await expect(page.getByLabel('测试记录 JSON，选中后复制')).toHaveValue(/mock-request/)
  const calls = await page.evaluate(() => (window as any).__requests.filter((r: any) => r.path === 'api/run'))
  expect(calls).toHaveLength(1); expect(calls[0].data.accountId).toBe('a1')
  await page.screenshot({ path: info.outputPath('candy.png'), fullPage: true })
})
test('cancel returns page to ready', async ({ page }) => {
  await mock(page, { slow: true }); await page.goto('/')
  await page.getByRole('button', { name: '测试', exact: true }).first().click()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByText('已取消', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '测试', exact: true }).first()).toBeEnabled()
})
test('fingerprint ranking and dark narrow layout', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mock(page, { dark: true }); await page.goto('/')
  await page.getByLabel('测试类型', { exact: true }).click()
  await page.getByText('指纹检测', { exact: true }).last().click()
  await page.getByRole('button', { name: '测试', exact: true }).first().click()
  await expect(page.getByText('80.0%')).toBeVisible()
  const calls = await page.evaluate(() => (window as any).__requests.filter((r: any) => r.path === 'api/run'))
  expect(calls.map((r: any) => r.data.step)).toEqual([0, 1, 2])
  expect(new Set(calls.map((r: any) => r.data.id)).size).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('fingerprint-dark-mobile.png'), fullPage: true })
})
test('pelican preview cannot execute or load external assets', async ({ page }, info) => {
  const outbound: string[] = []; page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173')) outbound.push(request.url()) })
  await mock(page); await page.goto('/')
  await page.getByLabel('测试类型', { exact: true }).click()
  await page.getByText('画鹈鹕', { exact: true }).last().click()
  await page.getByRole('button', { name: '测试', exact: true }).first().click()
  const image = page.getByAltText('鹈鹕绘图预览')
  await expect(image).toBeVisible()
  await expect(image).toHaveJSProperty('naturalWidth', 300)
  const svg = decodeURIComponent((await image.getAttribute('src'))!.split(',').slice(1).join(','))
  expect(svg).toContain('Pelican fixture')
  expect(svg).not.toMatch(/<script|<a |<image|onerror|https:\/\/example/)
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__unsafe)).toBeUndefined()
  expect(outbound).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('pelican.png'), fullPage: true })
})
