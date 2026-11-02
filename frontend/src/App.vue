<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { api, isPreview, type Account, type ClientKey, type RecordEntry, type Sample } from './api'
import { kinds, profiles, reasons, label, active } from './presentation'
import ResultDetails from './components/ResultDetails.vue'

const accounts = ref<Account[]>([]), keys = ref<ClientKey[]>([]), records = ref<RecordEntry[]>([])
const selected = ref<string[]>([]), keyId = ref(''), model = ref(''), models = ref<string[]>([])
const kind = ref('candy'), profile = ref('simple-v1'), effort = ref(''), repeats = ref(1)
const busy = ref(false), modelLoading = ref(false), error = ref(''), notice = ref('')
const accountFilter = ref(''), kindFilter = ref(''), tab = ref('tasks'), deleteId = ref('')
const report = ref<RecordEntry | null>(null), reportLoading = ref(false), exportText = ref('')
const sampleCache = new Map<string, Sample>()
type Submission = Parameters<typeof api.submit>[0]
const retrySubmission = ref<Submission[]>([])
let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, modelSequence = 0, polling = false
const usable = computed(() => accounts.value.filter(a => a.enabled))
const running = computed(() => records.value.filter(active))
const visible = computed(() => records.value.filter(r => (!accountFilter.value || r.accountId === accountFilter.value) && (!kindFilter.value || r.kind === kindFilter.value) && (tab.value === 'tasks' ? active(r) || r.status === 'paused' : !active(r) && r.status !== 'paused')))
const ready = computed(() => !isPreview && !busy.value && !modelLoading.value && !!keyId.value && !!model.value && !retrySubmission.value.length)
const expected = computed(() => selected.value.length * (kind.value === 'candy' ? repeats.value : 1) * (kind.value === 'fingerprint' ? 3 : 1))
const accountName = (r: RecordEntry) => r.accountName ?? accounts.value.find(a => a.account_id === r.accountId)?.name ?? r.accountId
const date = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
const latest = (id:string) => records.value.find(r => r.task && r.accountId === id && r.kind === kind.value && r.model === model.value && r.effort === effort.value && r.requestProfile === profile.value)
function candyStats(id:string) {
  const graded = records.value.filter(r => r.task && r.accountId === id && r.kind === 'candy' && r.model === model.value && r.effort === effort.value && r.requestProfile === profile.value && r.status === 'completed')
  return graded.length ? `${graded.filter(r => r.verdict === 'correct').length} / ${graded.length}` : '—'
}
async function poll() {
  if (disposed || polling || isPreview) return
  polling = true
  try {
    const [tasks, legacy] = await Promise.all([api.tasks(), api.history()])
    if (disposed) return
    records.value = [...tasks.records, ...legacy.records].sort((a,b) => b.startedAt - a.startedAt)
    if (report.value?.task && records.value.some(r => r.id === report.value?.id && r.updatedAt !== report.value?.updatedAt)) await openReport(report.value.id, false)
  } catch(e) { error.value = (e as Error).message }
  finally { polling = false; clearTimeout(timer); if (!disposed) timer = setTimeout(poll, running.value.length ? 2000 : 10000) }
}
async function refresh() {
  busy.value = true; error.value = ''
  try {
    const snapshot = await api.snapshot()
    if (disposed) return
    accounts.value = snapshot.accounts; keys.value = snapshot.keys.filter(k => k.enabled)
    selected.value = selected.value.filter(id => usable.value.some(a => a.account_id === id))
    if (!keys.value.some(k => k.id === keyId.value)) keyId.value = keys.value[0]?.id ?? ''
    await poll()
  } catch(e) { error.value = (e as Error).message } finally { busy.value = false }
}
watch(keyId, async id => {
  const sequence = ++modelSequence; models.value = []; model.value = ''; modelLoading.value = !!id
  if (!id) return
  try { const result = await api.models(id); if (!disposed && sequence === modelSequence) { models.value = result.models; model.value = result.models[0] ?? '' } }
  catch(e) { if (sequence === modelSequence) error.value = (e as Error).message }
  finally { if (sequence === modelSequence) modelLoading.value = false }
})
async function submit(ids = selected.value) {
  if (!ready.value || !ids.length) return
  const planned = ids.length * (kind.value === 'candy' ? repeats.value : 1)
  const pending = records.value.filter(r => r.task && !['completed','stopped'].includes(r.status)).length
  if (planned + pending > 16) { error.value = `本次将创建 ${planned} 份检测，已有 ${pending} 份待处理。总数最多 16 份，请减少账号或次数。`; return }
  retrySubmission.value = ids.flatMap(accountId => Array.from({length:kind.value === 'candy' ? repeats.value : 1}, () => ({id:crypto.randomUUID(),accountId,clientKeyId:keyId.value,model:model.value,effort:effort.value,kind:kind.value,profile:profile.value,step:0})))
  await sendPending()
}
async function sendPending() {
  busy.value = true; error.value = ''; notice.value = ''; tab.value = 'tasks'
  try {
    while (retrySubmission.value.length) {
      await api.submit(retrySubmission.value[0]); retrySubmission.value.shift()
    }
    notice.value = '检测已提交。可以关闭页面，CPR 将继续执行。'
  } catch(e) { error.value = `${(e as Error).message}。尚未确认的提交已保留；重试提交复用原 ID，不会重复创建任务。` }
  finally { busy.value = false; await poll() }
}
async function action(name:'resume'|'stop'|'delete', r:RecordEntry) {
  busy.value = true; error.value = ''; exportText.value = ''
  try {
    await api.action(name,r.id); deleteId.value = ''
    if (name === 'delete' && report.value?.id === r.id) report.value = null
    else if (report.value?.id === r.id) await openReport(r.id)
    await poll()
  } catch(e) { error.value = (e as Error).message } finally { busy.value = false }
}
async function openReport(id:string, loading = true) {
  const row = records.value.find(r => r.id === id)
  if (!row) return
  if (loading) reportLoading.value = true
  try {
    const result = row.task ? await api.task(id) : await api.detail(id)
    if (!result.record) throw new Error('该检测已被清理')
    const value = result.record
    if (value.task) {
      value.samples = []
      for (const attempt of value.attempts ?? []) {
        const cached = sampleCache.get(attempt.key) ?? (await api.sample(id,attempt.key)).sample
        sampleCache.set(attempt.key,cached); value.samples.push(cached)
      }
    }
    if (!disposed) {
      report.value = value
      if (loading) { await nextTick(); const target=document.querySelector<HTMLElement>('.report'); target?.focus({preventScroll:true}); target?.scrollIntoView({block:'start'}) }
    }
  } catch(e) { error.value = (e as Error).message } finally { reportLoading.value = false }
}
function exportReport() {
  exportText.value = JSON.stringify(report.value,null,2)
  // The host sandbox may block downloads; the selectable text remains available.
  const url = URL.createObjectURL(new Blob([exportText.value], {type:'application/json'}))
  const link = document.createElement('a'); link.href = url; link.download = `codex-eval-${report.value?.id}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url),1000)
}
onMounted(() => { if (isPreview) notice.value = '从 CPR 插件入口打开后，可读取账号并发起检测。'; else void refresh() })
onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <main class="eval-page">
    <header class="page-heading"><p class="muted">选择账号进行检测，关闭页面后 CPR 会继续执行。</p><button :disabled="busy || isPreview" @click="refresh">刷新</button></header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <section class="panel" aria-labelledby="new-title">
      <h2 id="new-title">发起检测</h2>
      <div class="toolbar">
        <label>测试类型<select v-model="kind" aria-label="测试类型" :disabled="busy"><option v-for="item in kinds" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
        <label>客户端 Key<select v-model="keyId" aria-label="客户端 Key" :disabled="busy"><option v-if="!keys.length" value="">暂无可用 Key</option><option v-for="key in keys" :key="key.id" :value="key.id">{{ key.name }}</option></select></label>
        <label>模型<select v-model="model" aria-label="模型" :disabled="busy || modelLoading"><option v-if="!models.length" value="">{{ modelLoading ? '正在读取模型' : '暂无可用模型' }}</option><option v-for="name in models" :key="name" :value="name">{{ name }}</option></select></label>
        <label v-if="kind === 'candy'">每账号次数<select v-model="repeats" aria-label="每账号次数" :disabled="busy"><option v-for="n in [1,3,5,10]" :key="n" :value="n">{{ n }}</option></select></label>
      </div>
      <details class="advanced"><summary>高级设置</summary><div class="toolbar">
        <label>推理强度<select v-model="effort" aria-label="推理强度"><option value="">默认</option><option v-for="s in ['none','minimal','low','medium','high','xhigh','max']" :key="s">{{ s }}</option></select></label>
        <label>请求语境<select v-model="profile" aria-label="请求语境"><option v-for="(name,id) in profiles" :key="id" :value="id">{{ name }}</option></select></label>
      </div><p class="muted">Codex 上下文包含较长指令和工具声明，工具执行关闭。不同语境分别统计。</p></details>
      <p class="muted">{{ kind === 'fingerprint' ? '三份有效样本后生成参考库候选排名，不能证明真实模型身份。' : kind === 'candy' ? '使用固定糖果题，以独立数字 21 判分。' : '辅助查看绘图输出，不评判模型身份。' }}</p>
      <div class="table-wrap"><table v-if="accounts.length"><thead><tr><th><input type="checkbox" aria-label="全选可用账号" :checked="!!usable.length && selected.length === usable.length" @change="selected = ($event.target as HTMLInputElement).checked ? usable.map(a => a.account_id) : []"></th><th>账号</th><th>当前条件最近结果</th><th v-if="kind === 'candy'">糖果正确 / 有效</th><th>操作</th></tr></thead><tbody>
        <tr v-for="account in accounts" :key="account.account_id"><td><input v-model="selected" type="checkbox" :value="account.account_id" :disabled="!account.enabled" :aria-label="`选择 ${account.name}`"></td><td>{{ account.name }}<small class="muted">{{ account.enabled ? account.email : '已停用' }}</small></td><td>{{ latest(account.account_id) ? label(latest(account.account_id)!) : '未测试' }}</td><td v-if="kind === 'candy'">{{ candyStats(account.account_id) }}</td><td><button :disabled="!ready || !account.enabled" @click="submit([account.account_id])">测试</button></td></tr>
      </tbody></table><p v-else class="muted">暂无 OpenAI 账号</p></div>
      <div class="actions"><button class="primary" :disabled="!ready || !selected.length" @click="submit()">测试所选账号</button><span class="muted">已选 {{ selected.length }} 个账号 · 计划 {{ expected }} 次模型请求</span></div>
      <p class="muted">消耗所选账号额度。插件不自动重试，宿主可能额外重试。每次最多保留 16 个待处理任务。</p>
      <div v-if="retrySubmission.length" class="actions"><button :disabled="busy" @click="sendPending">重试提交</button><button :disabled="busy" @click="retrySubmission = []; notice = '已放弃未确认的提交；请刷新检查是否已有任务。'">放弃未确认的提交</button></div>
    </section>
    <section class="panel" aria-labelledby="tasks-title">
      <div class="section-heading"><h2 id="tasks-title">检测记录</h2><nav aria-label="检测记录视图"><button :aria-pressed="tab === 'tasks'" @click="tab = 'tasks'">任务</button><button :aria-pressed="tab === 'history'" @click="tab = 'history'">历史</button></nav></div>
      <div class="toolbar filters"><label>账号<select v-model="accountFilter" aria-label="筛选账号"><option value="">全部账号</option><option v-for="a in accounts" :key="a.account_id" :value="a.account_id">{{ a.name }}</option></select></label><label>测试<select v-model="kindFilter" aria-label="筛选测试"><option value="">全部测试</option><option v-for="k in kinds" :key="k.value" :value="k.value">{{ k.label }}</option></select></label></div>
      <p v-if="!visible.length" class="empty muted">{{ tab === 'tasks' ? '暂无待处理检测' : '暂无历史记录' }}</p>
      <article v-for="r in visible" :key="r.id" class="task-row">
        <div><strong>{{ accountName(r) }}</strong><span class="badge">{{ label(r) }}</span><p class="muted">{{ kinds.find(k => k.value === r.kind)?.label }} · {{ r.model }} · {{ date(r.startedAt) }}<span v-if="!r.task"> · 旧版记录</span></p><p v-if="r.task" class="muted">有效样本 {{ r.validSamples }} / {{ r.expectedSamples }}<span v-if="r.status === 'queued'"> · 等待宿主调度</span><span v-if="r.stopRequested && active(r)"> · 正在停止</span></p><p v-if="r.reason">{{ reasons[r.reason] ?? '执行未完成，请查看报告中的请求诊断。' }}</p></div>
        <div class="actions"><button :disabled="reportLoading" @click="openReport(r.id)">查看报告</button><button v-if="r.canResume" :disabled="busy" @click="action('resume',r)">继续检测</button><button v-if="active(r) || r.status === 'paused'" :disabled="busy || r.stopRequested" @click="action('stop',r)">停止</button><button v-if="r.task && !active(r)" :disabled="busy" @click="deleteId = r.id">删除</button><template v-if="deleteId === r.id"><span>删除本次检测和全部样本？</span><button :disabled="busy" @click="action('delete',r)">确认删除</button><button @click="deleteId = ''">取消</button></template></div>
      </article>
      <p class="muted">新版最多保留 100 份检测及约 12 MB 样本，优先淘汰旧的已结束记录。排队、执行和暂停中的检测受到保护。统计仅针对保留记录。</p>
    </section>
    <section v-if="report" class="panel report" aria-labelledby="report-title" tabindex="-1">
      <div class="section-heading"><h2 id="report-title">检测报告</h2><button @click="report = null; exportText = ''">关闭报告</button></div>
      <p class="report-verdict">{{ label(report) }}</p><p>{{ accountName(report) }} · {{ report.model }} · {{ report.effort || '默认推理强度' }} · {{ profiles[report.requestProfile ?? 'simple-v1'] }}</p>
      <p v-if="report.reason">{{ reasons[report.reason] ?? '请查看下方请求诊断。' }}</p>
      <p v-if="!report.task" class="notice">旧版记录保留原结果；缺失的身份和任务信息未补造，不计入新版统计。</p>
      <p v-if="report.kind === 'candy'">答案标准：21。未取得有效回答不记为答错。</p>
      <div class="actions"><button v-if="report.canResume" :disabled="busy" @click="action('resume',report)">继续检测</button><button @click="exportReport">导出本次报告</button></div>
      <ResultDetails :record="report" />
      <details><summary>检测版本与请求依据</summary><p class="muted">插件 {{ report.pluginVersion ?? '旧版未记录' }} · 检测器 {{ report.detectorVersion ?? '旧版未记录' }}</p><pre>{{ JSON.stringify(report.sourceHashes ?? '旧版未记录',null,2) }}</pre></details>
      <textarea v-if="exportText" :value="exportText" readonly rows="10" class="export" aria-label="报告 JSON，下载受限时可选中复制" />
    </section>
  </main>
</template>
