export interface WorkspaceDraft {
  kind: string
  model: string
  keyId: string
  selected: string[]
  focus: string
  batchId: string
  drafts: Record<
    string,
    {
      effort: string
      profile: string
      repeats: number
      outputVersion: string
      batchId: string
      focus: string
    }
  >
  pending: BatchRequest | null
  effort: string
  profile: string
  repeats: number
  outputVersion: string
}
export interface Account {
  account_id: string
  name: string
  email: string | null
  enabled: boolean
}
export interface ClientKey {
  id: string
  name: string
  enabled: boolean
}
export interface Progress {
  phase: string
  step: number
  startedAt: number
  lastEventAt: number | null
  requestId: string | null
  textBytes: number
  partialText: string
  partialTruncated: boolean
}
export interface BatchRequest {
  id: string
  accountIds: string[]
  clientKeyId: string
  model: string
  effort: string
  kind: string
  profile: string
  repeats: number
  concurrency: number
  outputVersion: string
}
export interface Batch {
  request: BatchRequest
  taskIds: string[]
  startedAt: number
  ready: boolean
  stopped: boolean
  stoppedAccounts?: string[]
}
export interface Sample {
  valid?: boolean
  step?: number
  error?: {
    code: string
    kind?: string | null
    httpStatus?: number | null
    sendState?: string
    timeoutMs?: number
    origin?: string
  }
  status: string
  prompt: string
  instructions: string
  expectedCount: number | null
  requestId: string | null
  answer: { text: string; completed?: boolean; usage: Record<string, number | null> } | null
  durationMs: number
}
export interface RecordEntry {
  batchId?: string | null
  outputVersion?: string | null
  progress?: Progress
  task?: boolean
  accountName?: string
  validSamples?: number
  verdict?: string
  reason?: string | null
  canResume?: boolean
  updatedAt?: number
  stopRequested?: boolean
  attempts?: { key: string; step: number; status: string; valid: boolean }[]
  sourceHashes?: unknown
  pluginVersion?: string
  summaryOnly?: boolean
  id: string
  accountId: string
  kind: string
  model: string
  effort: string
  status: string
  requestProfile?: string
  startedAt: number
  durationMs: number
  samples: Sample[]
  detectorVersion: string
  expectedSamples?: number
  gradingAnswer?: number
  attribution: null | {
    prediction?: string
    family_prediction_name?: string
    used_outputs?: number
    evidence?: { reason: string }
    prediction_name: string
    probability: number | null
    decision: string
    diagnostics?: { parsed_numbers: number; accepted: boolean }[]
    results: { display_name: string; score: number; probability: number | null }[]
  }
}
interface Bridge {
  readonly theme: 'light' | 'dark'
  request(input: {
    method: string
    path: string
    contentType?: string
    body?: ArrayBuffer
  }): Promise<{ status: number; contentType: string; body: ArrayBuffer }>
}
declare global {
  interface Window {
    readonly codexProxyPlugin?: Bridge
  }
}
export const isPreview = !window.codexProxyPlugin
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function request<T>(path: string, data?: unknown): Promise<T> {
  const bridge = window.codexProxyPlugin
  if (!bridge) throw new Error('当前为独立预览，测试需从 CPR 插件页面打开')
  const response = await bridge.request({
    method: data === undefined ? 'GET' : 'POST',
    path,
    ...(data === undefined
      ? {}
      : {
          contentType: 'application/json',
          body: new TextEncoder().encode(JSON.stringify(data)).buffer as ArrayBuffer,
        }),
  })
  const result = JSON.parse(new TextDecoder().decode(response.body))
  if (response.status < 200 || response.status >= 300)
    throw new ApiError(result.error?.message || '操作未完成', response.status)
  return result as T
}
export const api = {
  workspace: () =>
    request<{ draft: WorkspaceDraft | null; version: number | null }>('api/workspace'),
  saveWorkspace: (draft: unknown, expectedVersion: number | null) =>
    request<{ version: number }>('api/workspace', { draft, expectedVersion }),
  batches: () => request<{ records: Batch[]; concurrency: number }>('api/batches'),
  batchSubmit: (data: BatchRequest) =>
    request<{ batch: Batch; duplicate: boolean }>('api/batch-submit', data),
  accountStop: (id: string, accountId: string) =>
    request('api/account-stop', { id, account_id: accountId }),
  batchStop: (id: string) => request('api/batch-stop', { id }),
  tasks: () => request<{ records: RecordEntry[] }>('api/tasks'),
  submit: (data: {
    id: string
    accountId: string
    clientKeyId: string
    model: string
    effort: string
    kind: string
    profile: string
    step: number
  }) => request<{ record: RecordEntry }>('api/submit', data),
  task: (id: string) => request<{ record: RecordEntry | null }>('api/task', { id }),
  sample: (id: string, key: string) => request<{ sample: Sample }>('api/sample', { id, key }),
  action: (action: 'resume' | 'stop' | 'delete', id: string) => request(`api/${action}`, { id }),
  snapshot: () =>
    request<{
      accounts: Account[]
      keys: ClientKey[]
      detectorVersion: string
      activeId?: string | null
    }>('api/snapshot'),
  models: (clientKeyId: string) => request<{ models: string[] }>('api/models', { clientKeyId }),
  history: () => request<{ records: RecordEntry[] }>('api/history'),
  run: (data: {
    summaryOnly?: boolean
    id: string
    accountId: string
    clientKeyId: string
    model: string
    effort: string
    kind: string
    profile: string
    step: number
  }) =>
    request<{ record: RecordEntry; persisted: boolean; nextStep: number | null }>('api/run', data),
  detail: (id: string) => request<{ record: RecordEntry | null }>('api/detail', { id }),
  clear: (account_id: string | null, kind: string | null) =>
    request('api/clear', { account_id, kind }),
  cancel: (id: string) =>
    request<{ cancelled: boolean; record?: RecordEntry }>('api/cancel', { id }),
}
