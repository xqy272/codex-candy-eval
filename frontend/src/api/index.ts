export interface Account { account_id: string; name: string; email: string | null; enabled: boolean }
export interface ClientKey { id: string; name: string; enabled: boolean }
export interface Sample { status: string; prompt: string; instructions: string; expectedCount: number | null; requestId: string | null; answer: { text: string; usage: Record<string, number | null> } | null; durationMs: number }
export interface RecordEntry {
  id: string; accountId: string; kind: string; model: string; effort: string; status: string
  startedAt: number; durationMs: number; samples: Sample[]; detectorVersion: string; expectedSamples?: number; gradingAnswer?: number
  attribution: null | { prediction_name: string; probability: number | null; decision: string; diagnostics?: { parsed_numbers: number; accepted: boolean }[]; results: { display_name: string; score: number; probability: number | null }[] }
}
interface Bridge {
  readonly theme: 'light' | 'dark'
  request(input: { method: string; path: string; contentType?: string; body?: ArrayBuffer }): Promise<{ status: number; contentType: string; body: ArrayBuffer }>
}
declare global { interface Window { readonly codexProxyPlugin?: Bridge } }
export const isPreview = !window.codexProxyPlugin

export async function request<T>(path: string, data?: unknown): Promise<T> {
  const bridge = window.codexProxyPlugin
  if (!bridge) throw new Error('当前为独立预览，测试需从 CPR 插件页面打开')
  const response = await bridge.request({ method: data === undefined ? 'GET' : 'POST', path, ...(data === undefined ? {} : { contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(data)).buffer as ArrayBuffer }) })
  const result = JSON.parse(new TextDecoder().decode(response.body))
  if (response.status < 200 || response.status >= 300) throw new Error(result.error?.message || '操作未完成')
  return result as T
}
export const api = {
  snapshot: () => request<{ accounts: Account[]; keys: ClientKey[]; detectorVersion: string; activeId?: string | null }>('api/snapshot'),
  models: (clientKeyId: string) => request<{ models: string[] }>('api/models', { clientKeyId }),
  history: () => request<{ records: RecordEntry[] }>('api/history'),
  run: (data: { id: string; accountId: string; clientKeyId: string; model: string; effort: string; kind: string; step: number }) => request<{ record: RecordEntry; persisted: boolean; nextStep: number | null }>('api/run', data),
  cancel: (id: string) => request<{ cancelled: boolean; record?: RecordEntry }>('api/cancel', { id }),
}
