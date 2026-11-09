import type { Account, Batch, RecordEntry } from './api'

export function accountDisplayName(account: Account): string {
  return account.name.trim() || account.email?.trim() || account.account_id
}

export function batchCompletionTime(batch: Batch, records: RecordEntry[]): number | undefined {
  if (!batch.ready || batch.stopped || !batch.taskIds.length) return
  const rows = new Map(records.map(row => [row.id, row]))
  let latest = 0
  for (const id of batch.taskIds) {
    const row = rows.get(id)
    const time = row?.updatedAt
    if (row?.status !== 'completed' || !time || !Number.isFinite(time) || time < batch.startedAt) return
    latest = Math.max(latest, time)
  }
  return latest
}
export const kinds = [
  { label: '糖果题', value: 'candy' },
  { label: '模型指纹', value: 'fingerprint' },
  { label: '画鹈鹕', value: 'pelican' },
  { label: 'Ciallo', value: 'ciallo' },
]
export const profiles: Record<string, string> = {
  'simple-v1': '简洁请求',
  'codex-context-v1': 'Codex 上下文 v1',
}
export const reasons: Record<string, string> = {
  uncertain: '上次请求的结果无法确认，未自动重发。继续检测可能再次消耗额度。',
  invalid_sample: '响应已完整结束，但数字样本未通过算法校验。已有有效样本保留。',
  identity_changed: '上游身份或无法核实身份的凭据已变化，请新建检测。',
  baseline_changed: '算法或参考资源已变化，请新建检测。',
  account_unavailable: '无法读取账号，或账号已不可用。',
  scoring_failed: '样本已经保存，评分未完成。继续检测将先重新评分。',
  attempt_limit: '本次已达到九次尝试上限，请新建检测。',
  timeout: '模型请求超时，未取得完整回答。',
  incomplete: '未取得完整成功终态，回答不参与评分。',
  permission_denied: '客户端 Key 权限或账号资格被拒绝。',
  queue_full: '宿主等待队列已满。',
  queue_timeout: '宿主排队超时。',
  capacity: '宿主返回容量类错误，未提供具体原因。',
  account_capacity: '所选账号暂时没有可用并发容量。',
  rate_limited: '宿主返回限流。',
  execution_failed: '模型执行失败，请查看请求诊断。',
  cancelled: '执行已取消。',
  user_stopped: '用户已停止本次检测。',
  empty_answer: '未取得可用正文。',
  no_provider: '没有可用 Provider。',
  answer_too_large: '回答超过保存上限，未作为有效样本。',
  event_too_large: '单个响应事件超过读取上限。',
}
export function label(r: RecordEntry): string {
  if (r.kind === 'ciallo' && r.status === 'completed') return '完整返回'
  if (r.status === 'completed' && r.task) {
    if (r.kind === 'candy') return r.verdict === 'correct' ? '答对' : '答错'
    if (r.kind === 'fingerprint')
      return r.verdict === 'ranked' ? '已生成候选排名' : '未形成候选结论'
    return '作品已生成'
  }
  return (
    (
      {
        queued: '排队中',
        running: '执行中',
        scoring: '正在分析',
        deleting: '正在清理',
        paused: '等待处理',
        stopped: '已停止',
        correct: '答对',
        wrong: '答错',
        completed: '已完成',
        failed: '执行失败',
        cancelled: '已取消',
        interrupted: '已中断',
        partial: '未完成',
        unscorable: '无法评分',
      } as Record<string, string>
    )[r.status] ?? r.status
  )
}
export function active(r: RecordEntry) {
  return r.task && ['queued', 'running', 'scoring', 'deleting'].includes(r.status)
}

export function duration(ms: number) {
  if (ms > 0 && ms < 1000) return Math.round(ms) + ' 毫秒'
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds >= 60
    ? Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒'
    : seconds + ' 秒'
}

export function verdict(r: RecordEntry) {
  if (r.verdict) return r.verdict
  if (r.status === 'correct') return 'correct'
  if (r.status === 'wrong') return 'wrong'
  if (r.kind === 'fingerprint' && r.attribution?.results.length) return 'ranked'
  if (r.kind === 'pelican' && r.status === 'completed') return 'output'
  if (r.kind === 'ciallo' && r.status === 'completed') return 'responded'
  return ''
}

export function executionState(r: RecordEntry) {
  if (active(r)) return 'active'
  if (r.status === 'paused') return 'paused'
  if (['stopped', 'cancelled'].includes(r.status)) return 'stopped'
  if (['completed', 'correct', 'wrong'].includes(r.status)) return 'completed'
  return 'failed'
}

export function recordTone(r: RecordEntry): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  if (active(r)) return 'info'
  if (r.status === 'paused') return 'warning'
  if (verdict(r) === 'wrong' || ['failed', 'partial', 'interrupted', 'unscorable'].includes(r.status))
    return 'danger'
  if (executionState(r) === 'completed') return 'success'
  return 'default'
}

export const phases: Record<string, string> = {
  requesting: '正在请求',
  waiting_events: '等待响应事件',
  receiving_events: '正在接收事件',
  receiving_text: '正在接收正文',
}

export const executionOptions = [
  { label: '全部状态', value: '' },
  { label: '检测中', value: 'active' },
  { label: '全部完成', value: 'completed' },
  { label: '部分完成 / 等待处理', value: 'paused' },
  { label: '已停止', value: 'stopped' },
  { label: '执行失败', value: 'failed' },
  { label: '待确认提交', value: 'uncertain' },
  { label: '部分记录已淘汰', value: 'evicted' },
]

export const verdictOptions = [
  { label: '全部结果', value: '' },
  { label: '糖果答对', value: 'correct' },
  { label: '糖果答错', value: 'wrong' },
  { label: '指纹候选排名', value: 'ranked' },
  { label: '绘图已生成', value: 'output' },
  { label: 'Ciallo 完整返回', value: 'responded' },
]
