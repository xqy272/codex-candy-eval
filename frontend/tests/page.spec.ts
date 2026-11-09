import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createTheme, createThemeVars } from '@codex-proxy/ui/theme'
const asset = (name: string, type: string): string => {
  let bytes = readFileSync(new URL(`../dist/${name}`, import.meta.url))
  if (type === 'text/css') {
    let css = bytes.toString('utf8')
    for (const font of ['inter-latin-wght-normal.woff2', 'jetbrains-mono-latin-wght-normal.woff2'])
      css = css.replaceAll('./fonts/' + font, asset('fonts/' + font, 'font/woff2'))
    bytes = Buffer.from(css)
  }
  return `data:${type};base64,${bytes.toString('base64')}`
}
const csp =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8')
  .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
  .replace('./app.js', asset('app.js', 'text/javascript'))
  .replace('./app.css', asset('app.css', 'text/css'))
async function mock(
  page: Page,
  options: {
    empty?: boolean
    error?: boolean
    queued?: boolean
    paused?: boolean
    dark?: boolean
    legacy?: boolean
    loseReply?: boolean
    reject?: boolean
    uncertain?: boolean
    opaque?: boolean
    conflict?: boolean
    responseText?: string
    keys?: { id: string; name: string; enabled: boolean }[]
    soft?: boolean
    accounts?: { account_id: string; name: string; email: string | null; enabled: boolean }[]
  } = {},
) {
  await page.route('http://127.0.0.1:4173/', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  )
  await page.addInitScript((o) => {
    const applyHostTheme = () => {
      document.documentElement.dataset.theme = o.dark ? 'dark' : 'light'
      for (const [name, value] of Object.entries(o.themeVars)) document.documentElement.style.setProperty(name, value)
    }
    if (document.documentElement) applyHostTheme()
    else addEventListener('DOMContentLoaded', applyHostTheme, { once: true })
    if (o.opaque)
      Object.defineProperty(window, 'localStorage', {
        get: () => {
          throw new DOMException('Opaque origin forbids storage', 'SecurityError')
        },
      })
    const state = JSON.parse(sessionStorage.getItem('fixture-state') ?? '{"rows":[],"batches":[]}')
    const encode = (v: any, status = 200) => ({
      status,
      contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(v)).buffer,
    })
    const save = () => sessionStorage.setItem('fixture-state', JSON.stringify(state))
    ;(window as any).__requests = []
    ;(window as any).__fixture = state
    Object.defineProperty(window, 'codexProxyPlugin', {
      value: {
        theme: o.dark ? 'dark' : 'light',
        request: async (input: any) => {
          const d = input.body ? JSON.parse(new TextDecoder().decode(input.body)) : null
          ;(window as any).__requests.push({ path: input.path, data: d })
          if (o.error) return encode({ error: { message: '模拟读取失败' } }, 502)
          switch (input.path) {
            case 'api/workspace':
              if (!d)
                return encode({ draft: state.workspace ?? null, version: state.version ?? null })
              if (o.conflict || d.expectedVersion !== (state.version ?? null))
                return encode({ error: { message: '页面草稿已在其他页面变化，请刷新读取' } }, 409)
              state.workspace = d.draft
              state.version = (state.version ?? 0) + 1
              save()
              return encode({ version: state.version })
            case 'api/snapshot':
              return encode({
                accounts: o.empty
                  ? []
                  : (o.accounts ?? [
                      { account_id: 'a1', name: '测试账号 A', enabled: true },
                      { account_id: 'a2', name: '测试账号 B', enabled: true },
                      { account_id: 'a3', name: '停用账号', enabled: false },
                    ]),
                keys: o.empty ? [] : (o.keys ?? [{ id: 'k1', name: 'personal-codex', enabled: true }]),
              })
            case 'api/models':
              return encode({ models: ['gpt-test', 'other-model'] })
            case 'api/tasks':
              if (state.failPoll) return encode({ error: { message: '模拟轮询中断' } }, 502)
              return encode({ records: state.rows })
            case 'api/history':
              return encode({ records: [] })
            case 'api/batches':
              return encode({ records: state.batches, concurrency: 2 })
            case 'api/batch-submit': {
              if (o.reject) return encode({ error: { message: '未结束检测最多 16 份' } }, 409)
              let batch = state.batches.find((b: any) => b.request.id === d.id)
              if (!batch) {
                batch = {
                  request: d,
                  taskIds: [],
                  startedAt: Date.now(),
                  ready: true,
                  stopped: false,
                }
                state.batches.unshift(batch)
                for (const [i, accountId] of d.accountIds.entries())
                  for (let n = 0; n < d.repeats; n++) {
                    const id = `${d.id}-${i}-${n}`,
                      paused = o.paused && d.kind === 'fingerprint'
                    const count = paused ? 1 : d.kind === 'fingerprint' ? 3 : 1
                    const attempts = o.queued
                      ? []
                      : Array.from({ length: count }, (_, step) => ({
                          key: id + '-' + step,
                          step,
                          status: 'completed',
                          valid: true,
                        }))
                    const r = {
                      ...d,
                      id,
                      accountId,
                      accountName:
                        o.accounts?.find((a) => a.account_id === accountId)?.name ??
                        (accountId === 'a1' ? '测试账号 A' : '测试账号 B'),
                      batchId: d.id,
                      task: true,
                      requestProfile: d.profile,
                      status: o.queued ? 'running' : paused ? 'paused' : 'completed',
                      reason: paused ? (o.uncertain ? 'uncertain' : 'invalid_sample') : null,
                      verdict:
                        d.kind === 'candy'
                          ? 'wrong'
                          : d.kind === 'fingerprint'
                            ? 'ranked'
                            : d.kind === 'ciallo' ? 'responded' : 'output',
                      validSamples: count,
                      expectedSamples: d.kind === 'fingerprint' ? 3 : 1,
                      canResume: paused,
                      startedAt: batch.startedAt + 1000 + i,
                      updatedAt: batch.startedAt + 7000 + i * 1000 + n,
                      durationMs: 100,
                      attempts,
                      samples: [],
                      answerPreview: d.kind === 'ciallo' ? (o.responseText ?? '你好，今天有什么可以帮你？') : undefined,
                      attribution:
                        d.kind === 'fingerprint' && !paused
                          ? {
                              prediction_name: '参考候选 A',
                              probability: 0.7,
                              results: [
                                { display_name: '参考候选 A', score: 1, probability: 0.7 },
                                { display_name: '参考候选 B', score: 0, probability: 0.3 },
                              ],
                            }
                          : null,
                      progress: o.queued
                        ? {
                            phase: 'receiving_text',
                            step: 0,
                            startedAt: Date.now() - 5000,
                            lastEventAt: Date.now(),
                            textBytes: 32,
                            partialText: '正在生成的真实片段',
                            partialTruncated: false,
                          }
                        : undefined,
                    }
                    state.rows.push(r)
                    batch.taskIds.push(id)
                  }
                save()
              }
              if (o.loseReply && !sessionStorage.getItem('reply-lost')) {
                sessionStorage.setItem('reply-lost', '1')
                throw Error('连接已中断')
              }
              return encode({ batch })
            }
            case 'api/task':
              return encode({ record: state.rows.find((r: any) => r.id === d.id) })
            case 'api/sample': {
              const r = state.rows.find((r: any) => r.id === d.id)
              const text =
                r.kind === 'pelican'
                  ? o.legacy
                    ? '<html><body>旧版动画原文</body></html>'
                    : '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><defs><linearGradient id="paint"><stop stop-color="#e6edf4"/></linearGradient></defs><rect width="360" height="200" fill="url(#paint)"/><text x="20" y="90">Pelican</text><script>parent.__unsafe=true</script><image href="https://example.invalid/leak"/></svg>'
                  : r.kind === 'candy'
                    ? o.responseText ?? '22'
                    : r.kind === 'ciallo' ? '你好，今天有什么可以帮你？' : '1, 2, 3'
              return encode({
                sample: {
                  step: 0,
                  valid: true,
                  status: 'completed',
                  prompt: r.kind === 'ciallo' ? 'ciallo' : '冻结测试题',
                  instructions: '',
                  durationMs: 100,
                  requestId: 'fixture-only',
                  answer: { text, completed: true, usage: { input_tokens: 12, output_tokens: 24, reasoning_tokens: 10, total_tokens: 36 } },
                },
              })
            }
            case 'api/resume': {
              const r = state.rows.find((r: any) => r.id === d.id)
              r.status = 'queued'
              r.canResume = false
              save()
              return encode({})
            }
            case 'api/stop': {
              const r = state.rows.find((r: any) => r.id === d.id)
              r.status = 'stopped'
              save()
              return encode({})
            }
            case 'api/account-stop': {
              const b = state.batches.find((b: any) => b.request.id === d.id)
              b.stoppedAccounts = [d.account_id]
              state.rows
                .filter((r: any) => r.batchId === d.id && r.accountId === d.account_id)
                .forEach((r: any) => (r.status = 'stopped'))
              save()
              return encode({})
            }
            case 'api/batch-stop': {
              const b = state.batches.find((b: any) => b.request.id === d.id)
              b.stopped = true
              state.rows
                .filter((r: any) => r.batchId === d.id)
                .forEach((r: any) => (r.status = 'stopped'))
              save()
              return encode({})
            }
            default:
              throw Error('Unexpected route ' + input.path)
          }
        },
      },
    })
  }, { ...options, themeVars: createThemeVars(createTheme({ scheme: options.dark ? 'dark' : 'light', preset: options.soft ? 'soft' : 'default' }).tokens) })
}
async function choose(page: Page, name: string, option: string) {
  await page.getByRole('combobox', { name, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
async function kind(page: Page, name: string) {
  await page.getByRole('radio', { name, exact: true }).click()
}
async function navigate(page: Page, name: string) {
  await page.getByRole('radiogroup', { name: '插件导航' }).getByRole('radio', { name, exact: true }).click()
}
async function selectAccount(page: Page, name: string, checked = true) {
  const input = page.getByLabel('选择 ' + name, { exact: true })
  if (await input.isChecked() !== checked) await input.locator('..').click()
  await expect(input).toBeChecked({ checked })
}
async function prepare(page: Page, name = '模型指纹', two = false) {
  await page.goto('/')
  await kind(page, name)
  await choose(page, '模型', 'gpt-test')
  await selectAccount(page, '测试账号 A')
  if (two) await selectAccount(page, '测试账号 B')
}
const start = (page: Page) => page.getByRole('button', { name: /^(开始检测|新建检测) ·/ }).click()
const calls = (page: Page) => page.evaluate(() => (window as any).__requests)
const submissions = async (page: Page) => (await calls(page)).filter((r: any) => r.path === 'api/batch-submit')
const openAccount = (page: Page, name = '测试账号 A') => page.locator('.desktop-results').getByRole('button', { name: '查看 ' + name + ' 结果', exact: true }).click()
const closeResult = (page: Page) => page.getByRole('button', { name: '关闭结果', exact: true }).click()

test('official components keep all request fields visible and explain readiness', async ({ page }) => {
  await mock(page)
  await page.goto('/')
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '推理强度', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '请求语境', exact: true })).toBeVisible()
  await expect(page.getByText('personal-codex', { exact: true })).toBeVisible()
  await expect(page.getByText('请选择模型', { exact: true }).last()).toBeVisible()
  expect(await submissions(page)).toHaveLength(0)
  await choose(page, '模型', 'gpt-test')
  await expect(page.getByText('请选择至少一个可用账号', { exact: true })).toBeVisible()
})

test('opaque host storage restores drafts and completed single-account results without requests', async ({ page }) => {
  await mock(page, { opaque: true })
  await prepare(page, '糖果题')
  await start(page)
  await expect(page.getByLabel('实际回答', { exact: true })).toContainText('22')
  await page.reload()
  await openAccount(page)
  await expect(page.getByLabel('实际回答', { exact: true })).toContainText('22')
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toContainText('gpt-test')
  expect(await submissions(page)).toHaveLength(0)
})

test('conflicting drafts cannot start a request', async ({ page }) => {
  await mock(page, { conflict: true })
  await prepare(page)
  await expect(page.getByRole('alert')).toContainText('页面草稿已在其他页面变化')
  await expect(page.getByRole('button', { name: /^(开始检测|新建检测) ·/ })).toBeDisabled()
  expect(await submissions(page)).toHaveLength(0)
})

test('empty accounts and read failures remain actionable', async ({ page }) => {
  await mock(page, { empty: true })
  await page.goto('/')
  await expect(page.getByText('暂无 OpenAI 账号')).toBeVisible()
  await expect(page.getByRole('button', { name: /^(开始检测|新建检测) ·/ })).toBeDisabled()
})

test('read error has refresh and a separate message', async ({ page }) => {
  await mock(page, { error: true })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('模拟读取失败')
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
})

test('blank account names retain email and stable-ID fallback with original enabled values', async ({ page }) => {
  await mock(page, { accounts: [
    { account_id: 'named', name: '  自定义名称  ', email: 'named@example.invalid', enabled: true },
    { account_id: 'email-only', name: '', email: ' mailbox@example.invalid ', enabled: true },
    { account_id: 'stable-account-id', name: ' \u3000 ', email: ' ', enabled: true },
    { account_id: 'disabled-id', name: '', email: 'disabled@example.invalid', enabled: false },
  ] })
  await page.goto('/')
  await expect(page.locator('.account-row strong')).toHaveText(['自定义名称', 'mailbox@example.invalid', 'stable-account-id', 'disabled@example.invalid'])
  await expect(page.getByLabel('选择 disabled@example.invalid', { exact: true })).toBeDisabled()
  await page.getByLabel('搜索账号', { exact: true }).fill(' MAILBOX@EXAMPLE.INVALID ')
  await page.getByRole('button', { name: '选择筛选结果', exact: true }).click()
  await page.getByLabel('搜索账号', { exact: true }).fill('stable-account-id')
  await expect(page.locator('.account-row strong')).toHaveText(['stable-account-id'])
  await page.getByLabel('搜索账号', { exact: true }).fill('missing')
  await expect(page.getByText('未找到匹配账号', { exact: true })).toBeVisible()
  await page.getByLabel('搜索账号', { exact: true }).fill('')
  await kind(page, '糖果题')
  await choose(page, '模型', 'gpt-test')
  await start(page)
  await expect(page.locator('.result-heading h2')).toHaveText('mailbox@example.invalid')
  expect((await submissions(page))[0].data.accountIds).toEqual(['email-only'])
  await page.reload()
  await openAccount(page, 'mailbox@example.invalid')
  await expect(page.locator('.result-heading h2')).toHaveText('mailbox@example.invalid')
})

test('multi-account repeats open an overview, detail returns focus to the same row', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题', true)
  await choose(page, '每账号次数', '3 次')
  await start(page)
  await expect(page.getByLabel('本批次总览')).toBeVisible()
  await expect(page.locator('.test-result')).toHaveCount(0)
  await openAccount(page)
  await expect(page.locator('.big-answer')).toHaveText('0 / 3')
  await expect(page.getByLabel('每次回答').getByRole('button')).toHaveCount(3)
  await closeResult(page)
  await expect(page.locator('.desktop-results').getByRole('button', { name: '查看 测试账号 A 结果', exact: true })).toBeFocused()
  const c = await submissions(page)
  expect(c).toHaveLength(1)
  expect(c[0].data.accountIds).toEqual(['a1', 'a2'])
  expect(c[0].data.repeats).toBe(3)
})

test('single candy displays the actual wrong answer with error semantics', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题')
  await start(page)
  await expect(page.getByLabel('实际回答', { exact: true })).toContainText('22')
  await expect(page.getByLabel('实际回答', { exact: true })).toContainText('标准答案 21')
  await expect(page.locator('.big-answer')).toHaveCount(0)
  await expect(page.locator('.result-state')).toContainText('答错')
  expect(await page.locator('.result-state').evaluate(e => getComputedStyle(e).color)).not.toBe('')
})

test('partial fingerprint resumes only missing samples', async ({ page }) => {
  await mock(page, { paused: true })
  await prepare(page)
  await start(page)
  await expect(page.getByText('已保留 1 / 3 个有效样本', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '补测 2 个样本' }).click()
  expect(await submissions(page)).toHaveLength(1)
  expect((await calls(page)).filter((r: any) => r.path === 'api/resume')).toHaveLength(1)
})

test('unknown consumption still requires explicit confirmation', async ({ page }) => {
  await mock(page, { paused: true, uncertain: true })
  await prepare(page)
  await start(page)
  await page.getByRole('button', { name: '补测 2 个样本' }).click()
  expect((await calls(page)).filter((r: any) => r.path === 'api/resume')).toHaveLength(0)
  await page.getByRole('button', { name: '确认补测，可能再次消耗额度' }).click()
  expect((await calls(page)).filter((r: any) => r.path === 'api/resume')).toHaveLength(1)
})

test('polling preserves expanded evidence and exposes real progress', async ({ page }) => {
  await mock(page, { queued: true })
  await prepare(page)
  await start(page)
  await page.getByText('查看正在接收的正文', { exact: true }).click()
  await expect(page.getByText('正在生成的真实片段')).toBeVisible()
  await page.waitForTimeout(1400)
  await expect(page.getByText('正在生成的真实片段')).toBeVisible()
  await page.getByRole('button', { name: '停止此账号', exact: true }).click()
  expect((await calls(page)).filter((r: any) => r.path === 'api/account-stop')).toHaveLength(1)
})

test('draft edits and left-side selection never change the frozen batch', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题', true)
  await start(page)
  await choose(page, '模型', 'other-model')
  await selectAccount(page, '测试账号 A', false)
  await expect(page.getByLabel('本批次冻结条件')).toContainText('gpt-test')
  await expect(page.getByLabel('本批次冻结条件')).not.toContainText('other-model')
  await expect(page.locator('.desktop-results tbody tr')).toHaveCount(2)
  expect(await submissions(page)).toHaveLength(1)
})

test('history details return to the filtered list without replacing test drafts', async ({ page }) => {
  await mock(page)
  await prepare(page)
  await start(page)
  await closeResult(page)
  await choose(page, '模型', 'other-model')
  await navigate(page, '记录')
  await choose(page, '筛选测试', '模型指纹')
  await page.locator('.history-table').getByRole('button', { name: '查看结果' }).click()
  await expect(page.locator('.ranking')).toBeVisible()
  await closeResult(page)
  await expect(page.getByRole('combobox', { name: '筛选测试', exact: true })).toContainText('模型指纹')
  await expect(page.locator('.history-table').getByRole('button', { name: '查看结果' })).toBeFocused()
  await navigate(page, '测试')
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toContainText('other-model')
  await openAccount(page)
  await expect(page.getByLabel('请求概况', { exact: true })).toContainText('gpt-test')
})

test('execution and result filters match batches independently', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题')
  await start(page)
  await closeResult(page)
  await navigate(page, '记录')
  await choose(page, '筛选状态', '全部完成')
  await choose(page, '筛选结果', '糖果答错')
  await expect(page.locator('.history-table tbody tr')).toHaveCount(1)
  await choose(page, '筛选结果', '糖果答对')
  await expect(page.getByText('暂无符合筛选条件的记录')).toBeVisible()
})

test('lost submission restores and reuses its original batch ID', async ({ page }) => {
  await mock(page, { loseReply: true })
  await prepare(page, '糖果题')
  await start(page)
  await expect(page.getByRole('alert')).toContainText('未确认的提交已保留')
  const id = (await submissions(page))[0].data.id
  await page.reload()
  await page.getByRole('button', { name: '核对提交状态' }).click()
  const c = await submissions(page)
  expect(c).toHaveLength(1)
  expect(c[0].data.id).toBe(id)
  expect(await page.evaluate(() => (window as any).__fixture.batches.length)).toBe(1)
})

test('definitive rejection allows correction without an unresolved submission', async ({ page }) => {
  await mock(page, { reject: true })
  await prepare(page)
  await start(page)
  await expect(page.getByRole('alert')).toContainText('可修改条件后重试')
  await expect(page.getByRole('button', { name: '核对提交状态' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(开始检测|新建检测) ·/ })).toBeEnabled()
})

test('safe SVG previews keep internal gradients, code and downloadable output', async ({ page }) => {
  await mock(page)
  let external = 0
  page.on('request', r => { if (r.url().includes('example.invalid')) external++ })
  await prepare(page, '画鹈鹕', true)
  await start(page)
  await expect(page.getByAltText('已生成作品缩略图')).toHaveCount(2)
  await openAccount(page)
  const image = page.getByAltText('鹈鹕绘图预览')
  await expect(image).toBeVisible()
  expect(await image.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true)
  const src = decodeURIComponent((await image.getAttribute('src'))!)
  expect(src).not.toContain('<script')
  expect(src).not.toContain('example.invalid')
  expect(src).toContain('url(#paint)')
  expect(src).toContain('linearGradient')
  expect(external).toBe(0)
  await page.getByRole('radiogroup', { name: '作品视图' }).getByRole('radio', { name: '代码', exact: true }).click()
  await expect(page.locator('.artwork-view>pre')).toContainText('<svg')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 SVG' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.svg$/)
})

test('third comparison requires explicit replacement and cancel preserves A/B', async ({ page }) => {
  await mock(page, { accounts: ['a1','a2','a4'].map((account_id, i) => ({ account_id, name: '作品账号 ' + (i+1), email: null, enabled: true })) })
  await page.goto('/')
  await kind(page, '画鹈鹕')
  await choose(page, '模型', 'gpt-test')
  await page.getByRole('button', { name: '选择筛选结果' }).click()
  await start(page)
  for (let i = 1; i <= 3; i++) {
    await openAccount(page, '作品账号 ' + i)
    await page.getByRole('button', { name: '加入作品对比' }).click()
    if (i < 3) await closeResult(page)
  }
  await expect(page.getByRole('dialog', { name: '替换哪一份作品' })).toBeVisible()
  await expect(page.getByAltText('对比中的鹈鹕作品')).toHaveCount(2)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '加入作品对比' }).click()
  await page.getByRole('button', { name: '替换 B', exact: true }).click()
  await expect(page.locator('.comparison')).toContainText('作品账号 3')
  await expect(page.locator('.comparison')).not.toContainText('作品账号 2')
  expect(await submissions(page)).toHaveLength(1)
})

test('artwork zoom uses an official dialog, keyboard escape restores trigger focus', async ({ page }) => {
  await mock(page)
  await prepare(page, '画鹈鹕')
  await start(page)
  await page.getByRole('button', { name: '放大查看' }).click()
  await expect(page.getByRole('dialog', { name: '作品预览' })).toBeVisible()
  await choose(page, '预览缩放', '150%')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '作品预览' })).not.toBeVisible()
  await expect(page.getByRole('button', { name: '放大查看' })).toBeFocused()
  expect(await submissions(page)).toHaveLength(1)
})

test('legacy HTML preserves source with an honest preview limitation', async ({ page }) => {
  await mock(page, { legacy: true })
  await prepare(page, '画鹈鹕')
  await choose(page, '绘图题目', '旧版 HTML 动画题')
  await start(page)
  await expect(page.getByText(/旧版 HTML 格式无法完整预览/)).toBeVisible()
  await page.getByRole('radiogroup', { name: '作品视图' }).getByRole('radio', { name: '代码', exact: true }).click()
  await expect(page.locator('.artwork-view>pre')).toContainText('旧版动画原文')
})

test('mobile and dark themes keep configuration and selection usable at 320px', async ({ page }) => {
  await mock(page, { dark: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择账号', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '选择账号', exact: true }).click()
  await expect(page.getByLabel('选择 测试账号 A', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await selectAccount(page, '测试账号 A')
  await choose(page, '模型', 'gpt-test')
  await start(page)
  await expect(page.getByAltText('鹈鹕绘图预览')).toHaveCount(0)
  await page.screenshot({ path: '../.runtime/mobile-dark-1.4.0.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.screenshot({ path: '../.runtime/desktop-dark-1.4.0.png', fullPage: true })
})

test('stopping repeated account preserves its sibling batch work', async ({ page }) => {
  await mock(page, { queued: true })
  await prepare(page, '糖果题', true)
  await choose(page, '每账号次数', '3 次')
  await start(page)
  await openAccount(page)
  await page.getByRole('button', { name: '停止此账号', exact: true }).click()
  const c = (await calls(page)).filter((r: any) => r.path === 'api/account-stop')
  expect(c).toHaveLength(1)
  expect(c[0].data.account_id).toBe('a1')
  expect(await page.evaluate(() => (window as any).__fixture.rows.filter((r: any) => r.accountId === 'a1').every((r: any) => r.status === 'stopped'))).toBe(true)
  expect(await page.evaluate(() => (window as any).__fixture.rows.filter((r: any) => r.accountId === 'a2').every((r: any) => r.status === 'running'))).toBe(true)
})

test('synchronization errors retain results and recover without model requests', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题')
  await start(page)
  await expect(page.getByLabel('实际回答', { exact: true })).toContainText('22')
  await page.evaluate(() => { (window as any).__fixture.failPoll = true })
  await expect(page.getByText('同步未完成，已保存结果仍保留', { exact: false })).toBeVisible()
  await expect(page.getByLabel('实际回答', { exact: true })).toContainText('22')
  await page.evaluate(() => { (window as any).__fixture.failPoll = false })
  await page.getByRole('button', { name: '重新读取' }).click()
  await expect(page.getByRole('button', { name: '重新读取' })).toHaveCount(0)
  expect(await submissions(page)).toHaveLength(1)
})

test('readable summary and complete debug export have separate clipboard fallbacks', async ({ page }) => {
  await mock(page)
  await prepare(page)
  await start(page)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(Error('denied')) } }))
  await page.getByRole('button', { name: '复制结果', exact: true }).click()
  await expect(page.getByLabel('可选中复制的结果文本')).toHaveValue(/参考库候选/)
  await page.getByText('完整诊断数据', { exact: true }).click()
  await page.getByRole('button', { name: '复制调试 JSON', exact: true }).click()
  const value = JSON.parse(await page.getByLabel('可选中复制的结果文本').inputValue())
  expect(value[0].samples).toHaveLength(3)
  expect(await submissions(page)).toHaveLength(1)
})

test('host theme tokens change actual controls and surfaces without resetting drafts', async ({ page }) => {
  await mock(page)
  await prepare(page)
  const before = await page.locator('.start-button').evaluate(e => getComputedStyle(e).backgroundColor)
  const tokens = createThemeVars(createTheme({ scheme: 'dark', colorId: 'custom', primaryColor: '#8a3ec4', customization: { seed: { fontSize: 15, borderRadius: 14, controlHeight: 44 } } }).tokens)
  await page.evaluate((vars) => {
    document.documentElement.dataset.theme = 'dark'
    for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
    dispatchEvent(new CustomEvent('codex-proxy-themechange', { detail: { theme: 'dark' } }))
  }, tokens)
  const after = await page.locator('.start-button').evaluate(e => getComputedStyle(e).backgroundColor)
  expect(after).not.toBe(before)
  expect(await page.locator('.start-button').evaluate(e => e.getBoundingClientRect().height)).toBe(44)
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toContainText('gpt-test')
  await expect(page.getByLabel('选择 测试账号 A', { exact: true })).toBeChecked()
  expect(await submissions(page)).toHaveLength(0)
})

test('official segmented controls support arrow keys', async ({ page }) => {
  await mock(page)
  await page.goto('/')
  const tabs = page.getByRole('radiogroup', { name: '测试类型', exact: true })
  await tabs.getByRole('radio', { name: '模型指纹', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('radio', { name: '画鹈鹕', exact: true })).toBeChecked()
  await expect(page.getByRole('combobox', { name: '绘图题目', exact: true })).toBeVisible()
})

test('help popovers have readable padding and stay inside narrow and wide viewports', async ({ page }) => {
  await mock(page, { soft: true })
  await page.goto('/')
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [button, label] of [['额度说明', '额度说明内容'], ['保留规则', '保留规则说明']]) {
      const trigger = page.getByRole('button', { name: button, exact: true })
      await trigger.click()
      const content = page.getByLabel(label, { exact: true })
      await expect(content).toBeVisible()
      const bounds = await content.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
      expect(await content.evaluate(e => parseFloat(getComputedStyle(e).paddingLeft))).toBeGreaterThanOrEqual(12)
      expect(await content.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(content).not.toBeVisible()
      await expect(trigger).toBeFocused()
    }
  }
  expect(await submissions(page)).toHaveLength(0)
})

test('Markdown, math, tables and code render directly while raw copy stays byte-identical', async ({ page }) => {
  const text = '**最少取出 \\(21\\) 颗。 ** 这里利用题目条件\n\n### 推导\n\n- 五角星糖果\n- 圆形糖果\n\n| 形状 | 数量 |\n| --- | --- |\n| 圆形 | 21 |\n\n\\[6+4=10\\]\n\n```text\n**literal ** \\(code\\)\n```\n\n<script>window.__unsafe=true</script>\n[unsafe](javascript:alert(1))'
  await mock(page, { responseText: text })
  await prepare(page, '糖果题')
  await start(page)
  const dialog = page.getByRole('dialog', { name: '检测结果', exact: true })
  await expect(dialog).toBeVisible()
  const answer = dialog.getByLabel('实际回答', { exact: true })
  await expect(answer.locator('.answer-markdown strong')).toContainText('最少取出')
  await expect(answer.locator('.answer-markdown h3')).toHaveText('推导')
  await expect(answer.locator('.answer-markdown table')).toBeVisible()
  await expect(answer.locator('.answer-markdown math')).toHaveCount(2)
  await expect(answer.locator('.answer-markdown pre code')).toHaveText('**literal ** \\(code\\)\n')
  expect(await page.evaluate(() => (window as any).__unsafe)).toBeUndefined()
  await expect(answer.locator('a[href^="javascript:"]')).toHaveCount(0)
  expect(await answer.evaluate(e => !!e.closest('details'))).toBe(false)
  const facts = dialog.getByLabel('请求详情', { exact: true })
  await expect(facts.getByRole('heading', { name: '请求详情', exact: true })).toBeVisible()
  await expect(facts).toContainText('冻结测试题')
  expect(await facts.evaluate(e => !!e.closest('details'))).toBe(false)
  await answer.getByRole('radio', { name: '原文', exact: true }).click()
  expect(await answer.locator('.answer-source').textContent()).toBe(text)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(Error('denied')) } }))
  await answer.getByRole('button', { name: '复制尝试 1 回答', exact: true }).click()
  await expect(dialog.getByLabel('可选中复制的结果文本')).toHaveValue(text)
  expect(await submissions(page)).toHaveLength(1)
})

test('repeat selectors show verdicts and keep the selected response visible across polling', async ({ page }) => {
  await mock(page, { responseText: '**21**\n\n### 完整解释\n\n正文' })
  await prepare(page, '糖果题', true)
  await choose(page, '每账号次数', '3 次')
  await start(page)
  await openAccount(page)
  const selector = page.getByLabel('每次回答', { exact: true })
  expect(await selector.innerText()).not.toMatch(/\*\*|###|完整解释/)
  await selector.getByRole('button', { name: /^第 2 次/ }).click()
  await expect(page.getByLabel('实际回答', { exact: true }).getByRole('heading').first()).toContainText('第 2 次')
  await expect(page.locator('.answer-markdown h3')).toHaveText('完整解释')
  await page.waitForTimeout(1400)
  await expect(selector.getByRole('button', { name: /^第 2 次/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('请求详情', { exact: true })).toContainText('冻结测试题')
  expect(await submissions(page)).toHaveLength(1)
})

test('long email identities have a wider sidebar and remain selectable through scrolling', async ({ page }) => {
  const accounts = Array.from({ length: 18 }, (_, i) => ({ account_id: 'long-' + i, name: '', email: 'fictional.long.mailbox.' + i + '@example.invalid', enabled: i !== 17 }))
  await mock(page, { accounts })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  const sidebar = page.getByLabel('下一次检测账号', { exact: true })
  expect((await sidebar.boundingBox())!.width).toBeGreaterThanOrEqual(288)
  const identity = page.locator('.account-row strong').first()
  await expect(identity).toHaveAttribute('title', accounts[0]!.email)
  expect(await identity.evaluate(e => e.clientHeight <= parseFloat(getComputedStyle(e).lineHeight) + 1)).toBe(true)
  const last = page.getByLabel('选择 ' + accounts[16]!.email, { exact: true })
  await last.locator('..').click()
  await expect(last).toBeChecked()
  await expect(page.getByLabel('选择 ' + accounts[17]!.email, { exact: true })).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('one available Key still uses a full searchable selector', async ({ page }) => {
  await mock(page)
  await page.goto('/')
  const key = page.getByRole('combobox', { name: '客户端 Key', exact: true })
  await expect(key).toContainText('personal-codex')
  await expect(key).not.toContainText('k1')
  expect((await key.boundingBox())!.height).toBeGreaterThanOrEqual(30)
  await key.click()
  await page.getByRole('combobox', { name: '搜索选项', exact: true }).fill('personal')
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.getByRole('option').click()
  expect(await submissions(page)).toHaveLength(0)
})

test('Key search excludes disabled keys and sends only the selected stable ID', async ({ page }) => {
  await mock(page, { keys: [
    { id: 'key-alpha', name: '同名 Key', enabled: true },
    { id: 'key-beta', name: '同名 Key', enabled: true },
    { id: 'key-disabled', name: '已禁用 Key', enabled: false },
  ] })
  await page.goto('/')
  await page.getByRole('combobox', { name: '客户端 Key', exact: true }).click()
  await expect(page.getByRole('option')).toHaveCount(2)
  await page.getByRole('combobox', { name: '搜索选项', exact: true }).fill('key-beta')
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('option')).toContainText('key-beta')
  await page.getByRole('option').click()
  await choose(page, '模型', 'gpt-test')
  await selectAccount(page, '测试账号 A')
  await start(page)
  expect((await submissions(page))[0].data.clientKeyId).toBe('key-beta')
  expect((await calls(page)).filter((r: any) => r.path === 'api/models').at(-1).data.clientKeyId).toBe('key-beta')
})

test('result dialogs fit 320px and Escape closes only the top artwork dialog', async ({ page }) => {
  await mock(page)
  await prepare(page, '画鹈鹕')
  await start(page)
  const result = page.getByRole('dialog', { name: '检测结果', exact: true })
  await page.getByRole('button', { name: '放大查看' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '作品预览' })).not.toBeVisible()
  await expect(result).toBeVisible()
  await page.setViewportSize({ width: 320, height: 844 })
  const box = await result.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(321)
  expect(await result.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(result).not.toBeVisible()
  await expect(page.getByLabel('本批次总览', { exact: true })).toBeVisible()
  expect(await submissions(page)).toHaveLength(1)
})

test('dialog footer stays in the visible host viewport when the iframe is taller', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题')
  await start(page)
  const result = page.getByRole('dialog', { name: '检测结果', exact: true })
  for (const height of [520, 380]) {
    await page.evaluate(value => document.documentElement.style.setProperty('--plugin-viewport-height', value + 'px'), height)
    const box = await result.boundingBox()
    const footer = await result.getByRole('button', { name: '关闭结果', exact: true }).boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(height)
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(height)
    await expect(result.getByRole('button', { name: '关闭结果', exact: true })).toBeInViewport()
    const scrim = await result.evaluate(e => {
      const bounds = e.previousElementSibling!.getBoundingClientRect()
      return { height: bounds.height, viewport: innerHeight, coversBottom: document.elementFromPoint(5, innerHeight - 2) === e.previousElementSibling }
    })
    expect(scrim.height).toBe(scrim.viewport)
    expect(scrim.coversBottom).toBe(true)
  }
  await closeResult(page)
  expect(await submissions(page)).toHaveLength(1)
})

test('test batch shows its last saved completion, account time stays bold and history keeps its submission time', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题', true)
  await start(page)
  const time = page.locator('.current-batch time')
  const timestamps = await page.evaluate(() => {
    const state = (window as any).__fixture
    const batch = state.batches[0]
    const finish = Math.max(...state.rows.map((row: any) => row.updatedAt))
    return { start: new Date(batch.startedAt).toLocaleString(), finish: new Date(finish).toISOString(), account: new Date(state.rows[0].startedAt).toISOString() }
  })
  await expect(time).toHaveCount(1)
  await expect(time).toHaveAttribute('datetime', timestamps.finish)
  await expect(page.locator('.current-batch')).toContainText('完成于')
  const timestampStyle = (node: Element) => { const style = getComputedStyle(node); return { weight: Number(style.fontWeight), class: node.className } }
  const batchStyle = await time.evaluate(timestampStyle)
  await openAccount(page)
  const result = page.getByRole('dialog', { name: '检测结果' })
  const detected = result.locator('.detection-time time')
  await expect(detected).toHaveAttribute('datetime', timestamps.account)
  expect(await detected.evaluate(timestampStyle)).toEqual(batchStyle)
  expect(batchStyle.weight).toBeGreaterThanOrEqual(600)
  await expect(result.getByLabel('请求概况')).toContainText('36 Token')
  await expect(result.getByLabel('请求概况')).toContainText('推理 10')
  await expect(result.getByLabel('请求详情')).toContainText('fixture-only')
  await closeResult(page)
  await navigate(page, '记录')
  await expect(page.locator('.history-table')).toContainText(timestamps.start)
  expect(await submissions(page)).toHaveLength(1)
})

test('incomplete and missing batches never label a submission or surviving sample as completion', async ({ page }) => {
  await mock(page, { queued: true })
  await prepare(page, '糖果题', true)
  await start(page)
  await expect(page.locator('.current-batch')).toContainText('发起于')
  await page.evaluate(() => {
    const state = (window as any).__fixture
    state.rows.forEach((row: any) => { row.status = 'completed'; delete row.progress; delete row.updatedAt })
  })
  await expect(page.locator('.current-batch')).toContainText('完成时间 未记录')
  await expect(page.locator('.current-batch time')).toHaveCount(0)
  await page.evaluate(() => { (window as any).__fixture.rows.pop() })
  await expect(page.locator('.current-batch')).toContainText('部分记录已淘汰')
  await expect(page.locator('.current-batch')).not.toContainText('完成于')
})

test('history keeps six accounts in one compact row and opens the searched account directly', async ({ page }) => {
  const accounts = Array.from({ length: 6 }, (_, i) => ({
    account_id: 'a' + (i + 1), name: i < 2 ? '测试账号 ' + 'AB'[i] : 'long.fixture.mailbox.' + (i + 1) + '@example.invalid',
    email: null, enabled: true,
  }))
  await mock(page, { accounts })
  await prepare(page, '糖果题', true)
  await page.getByRole('button', { name: '选择筛选结果', exact: true }).click()
  await start(page)
  await expect(page.locator('.current-batch')).toContainText('完成 6 / 6 个账号')
  await page.getByRole('button', { name: '取消选择', exact: true }).click()
  await selectAccount(page, '测试账号 A')
  await start(page)
  await expect(page.getByRole('dialog', { name: '检测结果', exact: true })).toBeVisible()
  await closeResult(page)
  await navigate(page, '记录')
  const table = page.locator('.history-table')
  const picker = table.getByRole('button', { name: '查看批次账号 · 6 个账号', exact: true })
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(2)
  const rowHeights = await rows.evaluateAll(els => els.map(el => el.getBoundingClientRect().height))
  expect(Math.abs(rowHeights[0]! - rowHeights[1]!)).toBeLessThanOrEqual(4)
  await expect(table).not.toContainText('@example.invalid')
  await picker.click()
  const menu = page.getByRole('dialog', { name: '查看批次账号', exact: true })
  const search = menu.getByRole('textbox', { name: '搜索批次账号', exact: true })
  await expect(search).toBeFocused()
  await expect(menu.getByRole('button')).toHaveCount(6)
  await expect(menu.getByText(accounts[5]!.name, { exact: true })).toBeVisible()
  await search.fill('a2')
  await expect(menu.getByRole('button')).toHaveCount(1)
  await menu.getByRole('button', { name: '查看 测试账号 B 结果', exact: true }).click()
  const detail = page.getByRole('dialog', { name: '检测结果', exact: true })
  await expect(detail.getByRole('heading', { name: '测试账号 B' })).toBeVisible()
  await choose(page, '切换批次账号', '测试账号 A')
  await expect(detail.getByRole('heading', { name: '测试账号 A' })).toBeVisible()
  await page.keyboard.press('Escape')
  const batch = page.getByRole('dialog', { name: '批次结果', exact: true })
  await expect(batch.getByRole('button', { name: '查看 测试账号 A 结果', exact: true })).toBeFocused()
  await expect(batch.getByLabel('请求概况')).toHaveCount(0)
  await expect(batch.locator('time')).toHaveCount(0)
  await batch.getByRole('button', { name: '查看 测试账号 B 结果', exact: true }).click()
  await detail.getByRole('button', { name: '返回批次' }).click()
  await expect(batch).toBeVisible()
  await batch.getByRole('button', { name: '关闭批次' }).click()
  await expect(picker).toBeFocused()
  await choose(page, '筛选账号', '测试账号 B')
  await page.locator('.history-table').getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(detail.getByRole('heading', { name: '测试账号 B' })).toBeVisible()
  expect(await submissions(page)).toHaveLength(2)
})

test('Ciallo uses one fixed request per account and displays completed text without grading', async ({ page }) => {
  await mock(page)
  await prepare(page, 'Ciallo')
  await expect(page.getByLabel('下一次检测配置')).toContainText('ciallo')
  await expect(page.getByRole('combobox', { name: '请求语境', exact: true })).toHaveCount(0)
  await expect(page.getByText('1 次计划请求', { exact: true })).toBeVisible()
  await start(page)
  const detail = page.getByRole('dialog', { name: '检测结果', exact: true })
  await expect(detail).toContainText('完整返回')
  await expect(detail.getByLabel('实际回答')).toContainText('你好，今天有什么可以帮你？')
  await expect(detail.getByLabel('请求详情')).toContainText('ciallo')
  await expect(detail.getByLabel('请求概况')).toContainText('100 毫秒')
  await expect(detail.getByLabel('请求概况')).toContainText('36 Token')
  await expect(detail).not.toContainText('标准答案')
  await closeResult(page)
  const overview = page.locator('.batch-results .desktop-results')
  await expect(overview.getByRole('columnheader')).toHaveText(['账号', '执行情况', '检测结果', '耗时', '操作'])
  await expect(overview.locator('[data-execution-account="a1"]')).toHaveText('完整返回')
  await expect(overview.locator('[data-result-account="a1"]')).toHaveText('你好，今天有什么可以帮你？')
  await navigate(page, '记录')
  await choose(page, '筛选测试', 'Ciallo')
  await choose(page, '筛选结果', 'Ciallo 完整返回')
  await expect(page.locator('.history-table')).toContainText('Ciallo · 测试账号 A')
  await page.locator('.history-table').getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(detail).toContainText('完整返回')
  const submitted = await submissions(page)
  expect(submitted).toHaveLength(1)
  expect(submitted[0].data).toMatchObject({ kind: 'ciallo', profile: 'simple-v1', repeats: 1, accountIds: ['a1'] })
})

test('Ciallo overview previews each reply without loading full samples and keeps partial responses distinct', async ({ page }) => {
  await mock(page)
  await prepare(page, 'Ciallo', true)
  await start(page)
  const table = page.locator('.batch-results .desktop-results')
  await expect(table.locator('[data-result-account="a2"]')).toContainText('你好，今天有什么可以帮你？')
  expect((await calls(page)).filter(call => ['api/task', 'api/sample'].includes(call.path))).toHaveLength(0)
  await page.evaluate(() => {
    const [first, second] = (window as any).__fixture.rows
    Object.assign(first, { status: 'paused', reason: 'incomplete', verdict: null, validSamples: 0, answerPreview: 'Ciallo <img src=x onerror="window.__unsafe=true"> 已收到的片段' })
    Object.assign(second, { status: 'running', progress: { phase: 'receiving_text', partialText: '正在接收的回复', startedAt: Date.now(), textBytes: 21 } })
  })
  await expect(table.locator('[data-execution-account="a1"]')).toContainText('未完成')
  await expect(table.locator('[data-result-account="a1"]')).toContainText('已收到的片段')
  await expect(table.locator('[data-result-account="a1"]')).toContainText('未完整结束')
  await expect(table.locator('[data-execution-account="a2"]')).toContainText('执行中')
  await expect(table.locator('[data-result-account="a2"]')).toContainText('正在接收的回复')
  await expect(table.locator('[data-result-account="a2"]')).not.toContainText('你好，今天')
  await expect(table.locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__unsafe)).toBeUndefined()
  await page.setViewportSize({ width: 320, height: 900 })
  const mobile = page.locator('.batch-results .mobile-results')
  await expect(mobile.locator('[data-result-account="a1"]')).toContainText('已收到的片段')
  expect(await mobile.locator('.reply-preview').first().evaluate(el => getComputedStyle(el).webkitLineClamp)).toBe('2')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await submissions(page)).toHaveLength(1)
})

test('split batch columns keep completion separate from wrong candy and incomplete repeats', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题', true)
  await start(page)
  const table = page.locator('.batch-results .desktop-results')
  await expect(table.locator('[data-execution-account="a1"]')).toHaveText('已完成')
  await expect(table.locator('[data-result-account="a1"]')).toHaveText('答错')
  await expect(table).not.toContainText('1 / 1')
  await choose(page, '每账号次数', '3 次')
  await start(page)
  await page.evaluate(() => {
    const fixture = (window as any).__fixture
    const id = fixture.batches[0].request.id
    const account = fixture.rows.filter((row: any) => row.batchId === id && row.accountId === 'a1')
    account[0].verdict = 'correct'
    Object.assign(account[2], { status: 'paused', verdict: null, canResume: true, validSamples: 0 })
  })
  await expect(table.locator('[data-execution-account="a1"]')).toContainText('等待处理')
  await expect(table.locator('[data-result-account="a1"]')).toContainText('1 / 2 答对')
  await expect(table.locator('[data-result-account="a1"]')).toContainText('1 次未完成')
  await expect(table.locator('[data-execution-account="a2"]')).toHaveText('已完成')
})
