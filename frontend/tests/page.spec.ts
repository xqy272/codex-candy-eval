import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
const asset = (name: string, type: string) =>
  `data:${type};base64,${readFileSync(new URL(`../dist/${name}`, import.meta.url)).toString('base64')}`
const csp =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
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
    accounts?: { account_id: string; name: string; email: string | null; enabled: boolean }[]
  } = {},
) {
  await page.route('http://127.0.0.1:4173/', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  )
  await page.addInitScript((o) => {
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
                keys: o.empty ? [] : [{ id: 'k1', name: 'personal-codex', enabled: true }],
              })
            case 'api/models':
              return encode({ models: ['gpt-test', 'other-model'] })
            case 'api/tasks':
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
                            : 'output',
                      validSamples: count,
                      expectedSamples: d.kind === 'fingerprint' ? 3 : 1,
                      canResume: paused,
                      startedAt: Date.now() - 5000,
                      updatedAt: 1,
                      durationMs: 100,
                      attempts,
                      samples: [],
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
                    ? '22'
                    : '1, 2, 3'
              return encode({
                sample: {
                  step: 0,
                  valid: true,
                  status: 'completed',
                  prompt: '冻结测试题',
                  instructions: '',
                  durationMs: 100,
                  requestId: 'fixture-only',
                  answer: { text, completed: true, usage: { inputTokens: 12 } },
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
  }, options)
}
async function prepare(page: Page, kind = '模型指纹', two = false) {
  await page.goto('/')
  await page.getByRole('tab', { name: kind, exact: true }).click()
  await page.getByLabel('模型', { exact: true }).selectOption('gpt-test')
  await page.getByLabel('选择 测试账号 A', { exact: true }).check()
  if (two) await page.getByLabel('选择 测试账号 B', { exact: true }).check()
}
const start = (page: Page) => page.getByRole('button', { name: /开始检测 ·/ }).click()
const calls = (page: Page) => page.evaluate(() => (window as any).__requests)

test('opaque host storage can submit and restore drafts through private state', async ({
  page,
}) => {
  await mock(page, { opaque: true })
  await prepare(page, '糖果题')
  await start(page)
  await expect(page.locator('.big-answer')).toHaveText('22')
  await page.reload()
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('gpt-test')
  await expect(page.locator('.big-answer')).toHaveText('22')
  expect((await calls(page)).filter((r: any) => r.path === 'api/batch-submit')).toHaveLength(0)
})

test('a conflicting shared draft cannot overwrite pending state or start requests', async ({
  page,
}) => {
  await mock(page, { conflict: true })
  await prepare(page)
  await expect(page.getByRole('alert')).toContainText('页面草稿已在其他页面变化')
  await expect(page.getByRole('button', { name: /开始检测 ·/ })).toBeDisabled()
  expect((await calls(page)).filter((r: any) => r.path === 'api/batch-submit')).toHaveLength(0)
})
test('parameters stay visible, defaults do not consume requests', async ({ page }) => {
  await mock(page)
  await page.goto('/')
  await expect(page.getByLabel('请求语境')).toBeVisible()
  await expect(page.getByLabel('推理强度')).toBeVisible()
  await expect(page.getByText('personal-codex', { exact: true })).toBeVisible()
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: /开始检测 ·/ })).toBeDisabled()
  expect((await calls(page)).filter((r: any) => r.path === 'api/batch-submit')).toHaveLength(0)
})
test('empty and failure states are visible', async ({ page }) => {
  await mock(page, { empty: true })
  await page.goto('/')
  await expect(page.getByText('暂无 OpenAI 账号')).toBeVisible()
  await expect(page.getByRole('button', { name: /开始检测 ·/ })).toBeDisabled()
})
test('read errors are actionable', async ({ page }) => {
  await mock(page, { error: true })
  await page.goto('/')
  await expect(page.getByRole('alert')).toHaveText('模拟读取失败')
})
test('unnamed accounts stay identifiable without changing enabled state or selected IDs', async ({
  page,
}) => {
  await mock(page, {
    accounts: [
      {
        account_id: 'named',
        name: '  自定义名称  ',
        email: 'named@example.invalid',
        enabled: true,
      },
      { account_id: 'email-only', name: '', email: '  mailbox@example.invalid  ', enabled: true },
      { account_id: 'stable-account-id', name: ' \u3000 ', email: ' ', enabled: true },
      { account_id: 'disabled-id', name: '', email: 'disabled@example.invalid', enabled: false },
    ],
  })
  await page.goto('/')
  await expect(page.locator('.account-row strong')).toHaveText([
    '自定义名称',
    'mailbox@example.invalid',
    'stable-account-id',
    'disabled@example.invalid',
  ])
  await expect(page.getByLabel('选择 disabled@example.invalid', { exact: true })).toBeDisabled()
  await expect(
    page.locator('.account-row').filter({ hasText: 'disabled@example.invalid' }),
  ).toContainText('已停用')
  await expect(page.getByLabel('选择 mailbox@example.invalid', { exact: true })).toBeEnabled()
  await page.getByLabel('搜索账号').fill('  MAILBOX@EXAMPLE.INVALID  ')
  await expect(page.locator('.account-row')).toHaveCount(1)
  await page.getByRole('button', { name: '选择筛选结果', exact: true }).click()
  await page.getByLabel('搜索账号').fill('stable-account-id')
  await expect(page.locator('.account-row strong')).toHaveText(['stable-account-id'])
  await page.getByLabel('搜索账号').fill('not-found')
  await expect(page.getByText('未找到匹配账号', { exact: true })).toBeVisible()
  await page.getByLabel('搜索账号').fill('named@example.invalid')
  await expect(page.locator('.account-row strong')).toHaveText(['自定义名称'])
  await page.getByLabel('搜索账号').fill('')
  await page.getByRole('tab', { name: '糖果题', exact: true }).click()
  await page.getByLabel('模型', { exact: true }).selectOption('gpt-test')
  await page.getByRole('button', { name: /开始检测 ·/ }).click()
  await expect(page.locator('.result-heading h2')).toHaveText('mailbox@example.invalid')
  const submit = (await calls(page)).find((r: any) => r.path === 'api/batch-submit')
  expect(submit.data.accountIds).toEqual(['email-only'])
  expect(await page.evaluate(() => (window as any).__fixture.rows[0].accountName)).toBe('')
  await page.reload()
  await expect(page.locator('.result-heading h2')).toHaveText('mailbox@example.invalid')
  await expect(page.getByLabel('选择 mailbox@example.invalid', { exact: true })).toBeChecked()
  expect((await calls(page)).filter((r: any) => r.path === 'api/batch-submit')).toHaveLength(0)
  await page.getByRole('button', { name: '记录', exact: true }).click()
  await expect(page.getByLabel('筛选账号').locator('option')).toHaveText([
    '全部账号',
    '自定义名称',
    'mailbox@example.invalid',
    'stable-account-id',
    'disabled@example.invalid',
  ])
})
test('one batch groups accounts and repeats, candy shows actual wrong answer', async ({ page }) => {
  await mock(page)
  await prepare(page, '糖果题', true)
  await page.getByLabel('每账号次数').selectOption('3')
  await start(page)
  await expect(page.getByText('0 / 3', { exact: true })).toBeVisible()
  const c = (await calls(page)).filter((r: any) => r.path === 'api/batch-submit')
  expect(c).toHaveLength(1)
  expect(c[0].data.accountIds).toEqual(['a1', 'a2'])
  expect(c[0].data.repeats).toBe(3)
  await page.getByRole('tab', { name: '糖果题', exact: true }).click()
  await page.getByLabel('每账号次数').selectOption('1')
  await start(page)
  await expect(page.locator('.big-answer')).toHaveText('22')
})
test('fingerprint keeps samples, retry only resumes its missing plan', async ({ page }) => {
  await mock(page, { paused: true })
  await prepare(page)
  await start(page)
  await expect(page.getByText('已保留 1 / 3 个有效样本')).toBeVisible()
  await page.getByRole('button', { name: '补测 2 个样本' }).click()
  const c = await calls(page)
  expect(c.filter((r: any) => r.path === 'api/batch-submit')).toHaveLength(1)
  expect(c.filter((r: any) => r.path === 'api/resume')).toHaveLength(1)
  expect(c.filter((r: any) => r.path === 'api/run')).toHaveLength(0)
})
test('uncertain consumption requires an explicit second click', async ({ page }) => {
  await mock(page, { paused: true, uncertain: true })
  await prepare(page)
  await start(page)
  await page.getByRole('button', { name: '补测 2 个样本' }).click()
  expect((await calls(page)).filter((r: any) => r.path === 'api/resume')).toHaveLength(0)
  await page.getByRole('button', { name: '确认补测，可能再次消耗额度' }).click()
  expect((await calls(page)).filter((r: any) => r.path === 'api/resume')).toHaveLength(1)
})
test('polling preserves evidence expansion and exposes observed progress', async ({ page }) => {
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
test('draft changes cannot rewrite a frozen result and history returns to work', async ({
  page,
}) => {
  await mock(page)
  await prepare(page)
  await start(page)
  await page.getByLabel('模型', { exact: true }).selectOption('other-model')
  await expect(page.locator('.result-heading')).toContainText('gpt-test')
  await page.getByRole('button', { name: '记录', exact: true }).click()
  await expect(page.locator('.history-row')).toHaveCount(1)
  await page.getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(page.getByText('参考候选 A', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '测试', exact: true }).click()
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('other-model')
  await expect(page.locator('.result-heading')).toContainText('gpt-test')
})
test('lost submission survives reload using the same id', async ({ page }) => {
  await mock(page, { loseReply: true })
  await prepare(page, '糖果题')
  await start(page)
  await expect(page.getByRole('alert')).toContainText('未确认的提交已保留')
  const id = (await calls(page)).find((r: any) => r.path === 'api/batch-submit').data.id
  await page.reload()
  await page.getByRole('button', { name: '重试提交原批次' }).click()
  const c = (await calls(page)).filter((r: any) => r.path === 'api/batch-submit')
  expect(c).toHaveLength(1)
  expect(c[0].data.id).toBe(id)
  expect(await page.evaluate(() => (window as any).__fixture.batches.length)).toBe(1)
})
test('definitively rejected submissions can be corrected', async ({ page }) => {
  await mock(page, { reject: true })
  await prepare(page)
  await start(page)
  await expect(page.getByRole('alert')).toContainText('可修改条件后重试')
  await expect(page.getByRole('button', { name: '重试提交原批次' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /开始检测 ·/ })).toBeEnabled()
})
test('drawings preview inert SVG, expose code and compare saved accounts', async ({ page }) => {
  await mock(page)
  let external = 0
  page.on('request', (r) => {
    if (r.url().includes('example.invalid')) external++
  })
  await prepare(page, '画鹈鹕', true)
  await start(page)
  const image = page.getByAltText('鹈鹕绘图预览')
  await expect(image).toBeVisible()
  expect(await image.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true)
  const src = await image.getAttribute('src')
  expect(decodeURIComponent(src!)).not.toContain('<script')
  expect(decodeURIComponent(src!)).not.toContain('example.invalid')
  expect(decodeURIComponent(src!)).toContain('url(#paint)')
  expect(decodeURIComponent(src!)).toContain('linearGradient')
  expect(external).toBe(0)
  expect(await page.evaluate(() => (window as any).__unsafe)).toBeUndefined()
  await expect(page.getByAltText('已生成作品缩略图')).toHaveCount(2)
  await page.getByRole('button', { name: '加入作品对比' }).click()
  await page
    .getByLabel('本批次账号')
    .getByRole('button', { name: /测试账号 B/ })
    .click()
  await page.getByRole('button', { name: '加入作品对比' }).click()
  await expect(page.getByAltText('对比中的鹈鹕作品')).toHaveCount(2)
  await page.getByRole('button', { name: '代码', exact: true }).click()
  await expect(page.locator('.result-body>pre')).toContainText('<svg')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 SVG' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.svg$/)
  expect((await calls(page)).filter((r: any) => r.path === 'api/batch-submit')).toHaveLength(1)
})
test('legacy generated HTML preserves source with an explicit preview limitation', async ({
  page,
}) => {
  await mock(page, { legacy: true })
  await prepare(page, '画鹈鹕')
  await page.getByLabel('绘图题目').selectOption('legacy-animation-v1')
  await start(page)
  await expect(page.getByText(/旧版 HTML 格式无法完整预览/)).toBeVisible()
  await page.getByRole('button', { name: '代码', exact: true }).click()
  await expect(page.locator('.result-body>pre')).toContainText('旧版动画原文')
  await expect(page.getByRole('button', { name: '重新生成 · 1 次请求' })).toHaveCount(0)
})
test('mobile and dark layout keep request fields and start controls usable', async ({ page }) => {
  await mock(page, { dark: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByLabel('模型', { exact: true })).toBeVisible()
  await expect(page.getByLabel('请求语境')).toBeVisible()
  await expect(page.getByRole('button', { name: '开始检测', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '选择账号', exact: true }).click()
  await expect(page.getByLabel('选择 测试账号 A', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '../.runtime/mobile-dark.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.getByLabel('模型', { exact: true }).selectOption('gpt-test')
  await page.getByLabel('选择 测试账号 A', { exact: true }).check()
  await start(page)
  await page.screenshot({ path: '../.runtime/desktop-dark.png', fullPage: true })
})

test('stopping a repeated account covers every repeat without stopping its sibling', async ({
  page,
}) => {
  await mock(page, { queued: true })
  await prepare(page, '糖果题', true)
  await page.getByLabel('每账号次数').selectOption('3')
  await start(page)
  await page.getByRole('button', { name: '停止此账号', exact: true }).click()
  const c = (await calls(page)).filter((r: any) => r.path === 'api/account-stop')
  expect(c).toHaveLength(1)
  expect(c[0].data.account_id).toBe('a1')
  expect(
    await page.evaluate(() =>
      (window as any).__fixture.rows
        .filter((r: any) => r.accountId === 'a1')
        .every((r: any) => r.status === 'stopped'),
    ),
  ).toBe(true)
  expect(
    await page.evaluate(() =>
      (window as any).__fixture.rows
        .filter((r: any) => r.accountId === 'a2')
        .every((r: any) => r.status === 'running'),
    ),
  ).toBe(true)
})
