<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { ZButton, ZCard, ZConfigProvider, ZSelect } from '@codex-proxy/ui'
import { zhHans } from '@codex-proxy/ui/locale'
import { api, isPreview, type Account, type ClientKey, type RecordEntry } from './api'
import ResultDetails from './components/ResultDetails.vue'

const accounts = ref<Account[]>([]), keys = ref<ClientKey[]>([]), records = ref<RecordEntry[]>([])
const selected = ref<string[]>([]), keyId = ref(''), model = ref(''), models = ref<string[]>([])
const kind = ref('candy'), effort = ref(''), repeats = ref(1), error = ref(''), notice = ref('')
const loading = ref(true), modelLoading = ref(false), running = ref(false), stopping = ref(false)
const progress = ref(''), activeId = ref(''), openRecord = ref(''), showExport = ref(false)
const serverActive = ref('')
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let stopped = false, disposed = false, modelSequence = 0
const kindOptions = [{ label: '糖果题', value: 'candy' }, { label: '指纹检测', value: 'fingerprint' }, { label: '画鹈鹕', value: 'pelican' }]
const effortOptions = [{ label: '默认', value: '' }, ...['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ label: value, value }))]
const usable = computed(() => accounts.value.filter(a => a.enabled))
const ready = computed(() => !isPreview && !loading.value && !modelLoading.value && !running.value && !serverActive.value && !!keyId.value && !!model.value)
const canRun = computed(() => ready.value && selected.value.length > 0)
const expected = computed(() => selected.value.length * (kind.value === 'candy' ? repeats.value : 1) * (kind.value === 'fingerprint' ? 3 : 1))
const statusLabel: Record<string, string> = { correct: '答对', wrong: '答错', completed: '完成', failed: '执行失败', cancelled: '已取消', unscorable: '无法评分', partial: '未完成', running: '进行中', interrupted: '已中断' }
const accountName = (id: string) => accounts.value.find(a => a.account_id === id)?.name ?? id
const exportText = computed(() => JSON.stringify({ records: records.value }, null, 2))
async function refresh() {
  clearTimeout(refreshTimer)
  loading.value = true; error.value = ''
  try {
    const [snapshot, history] = await Promise.all([api.snapshot(), api.history()])
    if (disposed) return
    accounts.value = snapshot.accounts; keys.value = snapshot.keys.filter(k => k.enabled); records.value = history.records
    serverActive.value = snapshot.activeId ?? ''
    if (!serverActive.value && !running.value) stopping.value = false
    if (serverActive.value && !running.value) refreshTimer = setTimeout(() => { if (!disposed) void refresh() }, 1500)
    if (!keys.value.some(k => k.id === keyId.value)) keyId.value = keys.value[0]?.id ?? ''
    selected.value = selected.value.filter(id => usable.value.some(a => a.account_id === id))
  } catch (e) { error.value = (e as Error).message } finally { loading.value = false }
}
watch(keyId, async value => {
  const sequence = ++modelSequence
  models.value = []; model.value = ''; modelLoading.value = !!value
  if (!value) return
  try { const result = await api.models(value); if (sequence === modelSequence && !disposed) { models.value = result.models; model.value = result.models[0] ?? '' } }
  catch (e) { if (sequence === modelSequence) error.value = (e as Error).message }
  finally { if (sequence === modelSequence) modelLoading.value = false }
})
async function run(ids = selected.value) {
  if (!ready.value || !ids.length) return
  running.value = true; stopped = false; stopping.value = false; error.value = ''; notice.value = ''
  const plan = ids.flatMap(accountId => Array.from({ length: kind.value === 'candy' ? repeats.value : 1 }, () => ({ accountId, clientKeyId: keyId.value, model: model.value, effort: effort.value, kind: kind.value })))
  try {
    for (let i = 0; i < plan.length && !stopped; i++) {
      activeId.value = crypto.randomUUID()
      let step: number | null = 0
      do {
        progress.value = `${i + 1} / ${plan.length} · ${accountName(plan[i].accountId)}${plan[i].kind === 'fingerprint' ? ` · 第 ${step + 1} / 3 题` : ''}`
        const result = await api.run({ id: activeId.value, ...plan[i], step })
        records.value = [result.record, ...records.value.filter(r => r.id !== result.record.id)].slice(0, 20)
        openRecord.value = result.record.id
        if (!result.persisted) { notice.value = '本次结果未保存到 CPR，请展开 JSON 导出保留'; stopped = true }
        if (result.record.status === 'cancelled' || result.record.status === 'interrupted') stopped = true
        step = result.nextStep ?? null
      } while (step !== null && !stopped)
      if (stopped && records.value[0]?.status === 'partial') {
        const cancelled = await api.cancel(activeId.value)
        if (cancelled.record) records.value = [cancelled.record, ...records.value.filter(r => r.id !== cancelled.record!.id)].slice(0, 20)
      }
    }
  } catch (e) { error.value = (e as Error).message }
  finally { activeId.value = ''; running.value = false; stopping.value = false; progress.value = '' }
}
async function stop() {
  stopped = true; stopping.value = true
  try { if (activeId.value || serverActive.value) await api.cancel(activeId.value || serverActive.value); if (!running.value) await refresh() }
  catch (e) { error.value = (e as Error).message; stopping.value = false }
}
onMounted(() => { if (isPreview) { loading.value = false; notice.value = '独立页面预览 · 从 CPR 插件入口打开后可读取账号并测试' } else void refresh() })
onBeforeUnmount(() => { disposed = true; stopped = true; clearTimeout(refreshTimer); if (activeId.value) void api.cancel(activeId.value).catch(() => {}) })
</script>
<template>
  <ZConfigProvider :locale="zhHans">
    <main class="eval-page" :aria-busy="loading">
      <p v-if="notice" role="status" class="notice">{{ notice }}</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <ZCard padding="compact">
        <div class="toolbar">
          <label>测试类型<ZSelect v-model="kind" :options="kindOptions" :disabled="running" aria-label="测试类型" /></label>
          <label>客户端 Key<ZSelect v-model="keyId" :options="keys.map(k => ({ label: k.name, value: k.id }))" :disabled="running || loading" placeholder="暂无可用 Key" aria-label="客户端 Key" /></label>
          <label>模型<ZSelect v-model="model" :options="models.map(value => ({ label: value, value }))" :disabled="running || modelLoading" :placeholder="modelLoading ? '正在读取模型' : '暂无可用模型'" aria-label="模型" /></label>
          <label>推理强度<ZSelect v-model="effort" :options="effortOptions" :disabled="running" aria-label="推理强度" /></label>
          <label v-if="kind === 'candy'">每账号次数<ZSelect v-model="repeats" :options="[1, 3, 5, 10].map(value => ({ label: String(value), value }))" :disabled="running" aria-label="每账号次数" /></label>
        </div>
        <div class="actions">
          <ZButton type="primary" :disabled="!canRun" :loading="running" @click="run()">测试所选账号</ZButton>
          <ZButton v-if="running || serverActive" :disabled="stopping" @click="stop">{{ stopping ? '正在停止' : '停止' }}</ZButton>
          <ZButton :disabled="loading || running || isPreview" @click="refresh">刷新</ZButton>
          <span v-if="running" role="status">{{ progress }}</span>
          <span v-else-if="serverActive" role="status">已有测试正在执行</span>
          <span v-else class="muted">已选 {{ selected.length }} 个账号 · {{ expected }} 次模型请求，宿主可能额外重试</span>
        </div>
        <p class="muted">测试消耗所选账号额度</p>
      </ZCard>
      <ZCard title="账号" padding="compact">
        <p v-if="loading" role="status">正在读取账号</p>
        <p v-else-if="!accounts.length" class="muted">暂无 OpenAI 账号</p>
        <div v-else class="table-wrap"><table>
          <thead><tr><th><input type="checkbox" aria-label="全选可用账号" :disabled="running" :checked="usable.length > 0 && selected.length === usable.length" @change="selected = ($event.target as HTMLInputElement).checked ? usable.map(a => a.account_id) : []"></th><th>账号</th><th>状态</th><th>操作</th></tr></thead>
          <tbody><tr v-for="account in accounts" :key="account.account_id"><td><input v-model="selected" type="checkbox" :value="account.account_id" :disabled="running || !account.enabled" :aria-label="`选择 ${account.name}`"></td><td>{{ account.name }}<small class="muted">{{ account.email }}</small></td><td>{{ account.enabled ? '已启用' : '已停用' }}</td><td><ZButton :disabled="!account.enabled || !ready" @click="run([account.account_id])">测试</ZButton></td></tr></tbody>
        </table></div>
      </ZCard>
      <ZCard title="最近测试" padding="compact">
        <div class="actions"><span class="muted">最多保留最近 20 条，容量不足时提前淘汰旧记录</span><ZButton :disabled="!records.length" @click="showExport = !showExport">JSON 导出</ZButton></div>
        <textarea v-if="showExport" :value="exportText" readonly aria-label="测试记录 JSON，选中后复制" rows="10" class="export" />
        <p v-if="!records.length" class="muted">暂无测试记录</p>
        <details v-for="record in records" :key="record.id" :open="openRecord === record.id" class="record" @toggle="($event.target as HTMLDetailsElement).open && (openRecord = record.id)">
          <summary><span>{{ accountName(record.accountId) }} · {{ kindOptions.find(k => k.value === record.kind)?.label }}</span><span :class="['status', record.status]">{{ statusLabel[record.status] ?? record.status }}</span><span class="muted">{{ record.model }} · {{ (record.durationMs / 1000).toFixed(1) }} 秒</span><span v-if="record.attribution">{{ record.attribution.prediction_name }}</span></summary>
          <ResultDetails :record="record" />
        </details>
      </ZCard>
    </main>
  </ZConfigProvider>
</template>
