import type { Account, RecordEntry } from './api'

export function accountDisplayName(account: Account): string {
  return account.name.trim() || account.email?.trim() || account.account_id
}
export const kinds = [
  { label: '糖果题', value: 'candy' },
  { label: '模型指纹', value: 'fingerprint' },
  { label: '画鹈鹕', value: 'pelican' },
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
