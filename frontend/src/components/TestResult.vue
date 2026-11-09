<script setup lang="ts">
import { computed, ref } from 'vue'
import { ZButton, ZCard, ZTag, ZTextarea } from '@codex-proxy/ui'
import type { RecordEntry } from '../api'
import { active, duration, label, phases, profiles, reasons, recordTone } from '../presentation'
import { download } from '../media'
import ArtworkView from './ArtworkView.vue'
import AnswerBody from './AnswerBody.vue'
const props = defineProps<{ records: RecordEntry[]; accountLabel: string; clock: number; readonly?: boolean; busy?: boolean; clientKey?: string }>()
const emit = defineEmits<{ action: [name: 'resume' | 'stop', r: RecordEntry]; compare: [r: RecordEntry] }>()
const current = computed(() => props.records[0])
const liveRecord = computed(() => props.records.find(active))
const canStop = computed(() => props.records.some((r) => active(r) || r.status === 'paused'))
const rawFallback = ref(''), notice = ref(''), fullRanking = ref(false), retryConfirm = ref(''), candyExpanded = ref('')
const validCandy = computed(() => props.records.filter((r) => r.status === 'completed' || ['correct', 'wrong'].includes(r.status)))
const correctCandy = computed(() => validCandy.value.filter((r) => r.verdict === 'correct' || r.status === 'correct').length)
const failedCandy = computed(() => props.records.filter((r) => ['paused', 'failed', 'unscorable', 'partial', 'interrupted', 'cancelled'].includes(r.status)).length)
const stoppedCandy = computed(() => props.records.filter((r) => r.status === 'stopped').length)
const answer = (r: RecordEntry) => r.samples.find((s) => s.valid !== false && s.status === 'completed')?.answer?.text ?? r.samples.at(-1)?.answer?.text ?? ''
const inspected = computed(() => props.records.find((r) => r.id === candyExpanded.value) ?? current.value)
const total = computed(() => props.records.flatMap((r) => r.samples).reduce((sum, s) => {
  for (const [k, v] of Object.entries(s.answer?.usage ?? {})) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v
  return sum
}, {} as Record<string, number>))
const missingUsage = computed(() => props.records.some((r) => r.samples.some((s) => !s.answer?.usage || !Object.values(s.answer.usage).some((v) => typeof v === 'number'))))
const resultTone = computed(() => props.records.length > 1
  ? liveRecord.value ? 'info' : failedCandy.value ? 'warning' : validCandy.value.length && correctCandy.value < validCandy.value.length ? 'danger' : stoppedCandy.value ? 'default' : 'success'
  : current.value ? recordTone(current.value) : 'default')
const retryText = (r: RecordEntry) => r.reason === 'scoring_failed' ? '重新分析 · 不发请求'
  : r.kind === 'fingerprint' ? '补测 ' + Math.max(0, (r.expectedSamples ?? 3) - (r.validSamples ?? 0)) + ' 个样本'
    : r.kind === 'candy' ? '补测 1 次回答' : '重新生成 · 1 次请求'
function retry(r: RecordEntry) {
  if (r.reason === 'uncertain' && retryConfirm.value !== r.id) { retryConfirm.value = r.id; return }
  emit('action', 'resume', r)
  retryConfirm.value = ''
}
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); notice.value = '已复制' }
  catch { rawFallback.value = text; notice.value = '复制受限，可选中下方文本复制' }
}
function readableSummary() {
  if (!current.value) return ''
  const r = current.value
  const lines = [props.accountLabel, [r.model, r.effort || '默认强度', profiles[r.requestProfile ?? 'simple-v1']].join(' · '), new Date(r.startedAt).toLocaleString()]
  if (r.kind === 'candy') lines.push('答对 ' + correctCandy.value + ' / ' + validCandy.value.length + '，未完成 ' + failedCandy.value)
  else if (r.kind === 'fingerprint') lines.push('有效样本 ' + (r.validSamples ?? 0) + ' / ' + (r.expectedSamples ?? 3), r.attribution?.prediction_name ? '参考库候选：' + r.attribution.prediction_name : label(r))
  else lines.push(label(r))
  props.records.forEach((row, i) => lines.push('第 ' + (i + 1) + ' 次 · ' + label(row), answer(row) || '未取得完整正文'))
  return lines.join('\n')
}
function exportSummary() {
  download(readableSummary(), 'model-test-' + current.value?.id + '.txt')
  notice.value = '已请求下载，下载受限时可复制结果'
}
</script>
<template>
  <ZCard v-if="current" padding="compact" class="test-result">
    <template #header>
      <div class="result-heading">
        <div><h2>{{ accountLabel }}</h2><p class="muted">{{ current.model }} · {{ current.effort || '默认强度' }} · {{ profiles[current.requestProfile ?? 'simple-v1'] ?? current.requestProfile }}<span v-if="current.kind === 'pelican'"> · {{ current.outputVersion === 'svg-v1' ? '标准 SVG v1' : '旧版绘图题' }}</span></p></div>
        <ZTag class="result-state" :type="resultTone">{{ records.length > 1 ? validCandy.length + ' / ' + records.length + ' 份完成' : label(current) }}</ZTag>
      </div>
    </template>
    <div class="result-body">
      <p v-if="!current.task" class="feedback notice">旧版记录保留原结果，未记录的信息保持未知</p>
      <div v-if="liveRecord" class="live-progress">
        <ZTag type="info">{{ liveRecord.progress ? phases[liveRecord.progress.phase] ?? '执行中' : liveRecord.status === 'scoring' ? '正在保存与分析' : liveRecord.status === 'queued' ? '排队中' : '执行状态待确认' }}</ZTag>
        <h3>{{ current.kind === 'fingerprint' ? '已保存 ' + (current.validSamples ?? 0) + ' / 3 个有效样本' : current.kind === 'pelican' ? '作品正在生成' : '等待完整回答' }}</h3>
        <p v-if="liveRecord.progress" class="muted">已运行 {{ duration(clock - liveRecord.progress.startedAt) }} · 正文 {{ liveRecord.progress.textBytes }} 字节 · {{ liveRecord.progress.lastEventAt ? '最近事件 ' + duration(clock - liveRecord.progress.lastEventAt) + '前' : '尚未收到事件' }} · 上限 {{ current.kind === 'pelican' ? '10 分钟' : '150 秒' }}</p>
        <p v-else class="muted">等待可用名额与完整执行窗口，页面可以离开</p>
        <details v-if="liveRecord.progress?.partialText"><summary>查看正在接收的正文{{ liveRecord.progress.partialTruncated ? '（节选）' : '' }}</summary><pre>{{ liveRecord.progress.partialText }}</pre></details>
      </div>
      <div v-if="current.status === 'paused'" class="feedback warning">
        <strong>{{ current.kind === 'fingerprint' ? '已保留 ' + (current.validSamples ?? 0) + ' / 3 个有效样本' : current.kind === 'pelican' ? '未取得完整作品' : '本次回答未完成' }}</strong>
        <p>{{ reasons[current.reason ?? ''] ?? '请求未完成，已保留取得的内容' }}</p>
      </div>
      <div v-if="current.kind === 'fingerprint'" class="sample-strip">
        <div v-for="n in 3" :key="n"><span>样本 {{ n }}</span><small>{{ current.attempts?.some((a) => a.step === n - 1 && a.valid) || current.status === 'completed' && current.attribution?.used_outputs === 3 ? '已保存 · 有效' : current.progress?.step === n - 1 ? '执行中' : '未完成' }}</small></div>
      </div>
      <template v-if="current.kind === 'fingerprint' && current.attribution">
        <div v-if="current.attribution.results.length" class="candidate-summary">
          <div><p class="muted">参考库中最接近的候选</p><h3>{{ current.attribution.prediction_name }}</h3><p class="muted">{{ current.attribution.family_prediction_name || '家族未提供' }}</p></div>
          <div class="probability"><strong>{{ current.attribution.probability == null ? '—' : (current.attribution.probability * 100).toFixed(1) + '%' }}</strong><small>库内相对概率</small></div>
        </div>
        <h3 v-else>未形成候选结论</h3>
        <div class="ranking">
          <div v-for="(item, i) in current.attribution.results.slice(0, fullRanking ? undefined : 5)" :key="item.display_name" class="rank-row">
            <span>{{ item.display_name }}</span><div class="track"><span :class="{ first: i === 0 }" :style="{ width: Math.max(0, Math.min(100, (item.probability ?? 0) * 100)) + '%' }" /></div>
            <span>{{ item.probability == null ? '—' : (item.probability * 100).toFixed(1) + '%' }}</span>
          </div>
        </div>
        <ZButton size="small" variant="text" @click="fullRanking = !fullRanking">{{ fullRanking ? '收起排名' : '完整排名' }}</ZButton>
        <p class="muted">仅比较参考库内候选，概率不代表模型身份证明</p>
      </template>
      <template v-if="current.kind === 'candy'">
        <div class="candy-summary">
          <div><p class="muted">答对 / 有效回答</p><h3 class="big-answer">{{ correctCandy }} / {{ validCandy.length }}</h3><p class="muted">有效 {{ validCandy.length }} 次 · 未完成 {{ failedCandy }} 次<span v-if="stoppedCandy"> · 已停止 {{ stoppedCandy }} 次</span></p></div>
          <div class="answer-key"><small>标准答案</small><strong>21</strong></div>
        </div>
        <div v-if="records.length > 1" class="candy-answers" aria-label="每次回答">
          <ZButton v-for="(r, i) in records" :key="r.id" :type="r.verdict === 'correct' || r.status === 'correct' ? 'success' : r.verdict === 'wrong' || r.status === 'wrong' ? 'danger' : 'default'"
            :aria-pressed="inspected?.id === r.id" @click="candyExpanded = r.id">第 {{ i + 1 }} 次 · {{ label(r) }}</ZButton>
        </div>
      </template>
      <ArtworkView v-if="current.kind === 'pelican'" :record="current" @copy="copy" @compare="emit('compare', $event); notice = '已选择作品，关闭结果后查看对比'" />
      <div v-if="!readonly" class="actions">
        <ZButton v-if="inspected?.canResume" type="primary" :disabled="busy" @click="retry(inspected)">{{ retryConfirm === inspected.id ? '确认补测，可能再次消耗额度' : retryText(inspected) }}</ZButton>
        <ZButton v-if="canStop" :disabled="busy || current.stopRequested" @click="emit('action', 'stop', current)">{{ current.stopRequested ? '正在停止' : current.batchId ? '停止此账号' : '停止此检测' }}</ZButton>
        <span v-if="canStop && records.length > 1" class="muted">覆盖此账号尚未结束的全部次数</span>
      </div>
      <p v-if="current.canResume && current.reason !== 'scoring_failed'" class="muted">只补缺失或无效样本，此前请求可能已消耗额度</p>
      <section v-if="inspected" class="answer-evidence" aria-label="实际回答">
        <h2>{{ current.kind === 'pelican' ? '原始回答' : '实际回答' }}<span v-if="records.length > 1" class="muted"> · 第 {{ records.indexOf(inspected) + 1 }} 次</span></h2>
        <article v-for="(s, i) in inspected.samples" :key="i" class="sample">
          <div class="sample-heading"><h2>尝试 {{ i + 1 }}<span v-if="current.kind === 'fingerprint'" class="muted"> · 样本 {{ (s.step ?? i) + 1 }}</span></h2><ZTag size="small" :type="s.valid === false ? 'warning' : s.status === 'completed' ? 'success' : 'default'">{{ s.valid === false ? '未作为有效结果' : s.status === 'completed' ? '完整完成' : '未完成' }} · {{ duration(s.durationMs) }}</ZTag></div>
          <AnswerBody :source="s.answer?.text ?? ''" :code="current.kind === 'pelican'" :label="'尝试 ' + (i + 1) + ' 回答'" @copy="copy" />
          <p v-if="s.error?.origin === 'plugin'" class="feedback warning">达到插件 {{ (s.error.timeoutMs ?? 0) / 1000 }} 秒等待上限，部分回答不参与判分</p>
          <p v-else-if="s.error" class="feedback warning">{{ s.error.code }} · {{ s.error.kind ?? '未提供细分原因' }} · HTTP {{ s.error.httpStatus ?? '未知' }}</p>
        </article>
        <p v-if="!inspected.samples.length" class="muted">尚未保存回答，已接收的内容显示在执行进度中</p>
      </section>
      <section v-if="inspected" class="request-evidence" aria-label="请求详情">
        <h2>请求详情</h2>
        <dl class="request-facts">
          <div><dt>模型</dt><dd>{{ current.model }}</dd></div>
          <div><dt>推理强度</dt><dd>{{ current.effort || '默认强度' }}</dd></div>
          <div><dt>请求语境</dt><dd>{{ profiles[current.requestProfile ?? 'simple-v1'] ?? current.requestProfile }}</dd></div>
          <div><dt>客户端 Key</dt><dd>{{ clientKey || '旧版未记录' }}</dd></div>
          <div><dt>累计耗时</dt><dd>{{ duration(records.reduce((sum, r) => sum + r.durationMs, 0)) }}</dd></div>
        </dl>
        <p class="muted">检测时间 {{ new Date(current.startedAt).toLocaleString() }} · 插件 {{ current.pluginVersion ?? '旧版未记录' }} · 检测器 {{ current.detectorVersion }}</p>
        <p class="muted">Token：{{ Object.keys(total).length ? Object.entries(total).map(([k, v]) => k + ' ' + v).join(' · ') : '最终用量未提供，不能解释为零消耗' }}<span v-if="Object.keys(total).length && missingUsage"> · 部分请求用量未知</span></p>
        <article v-for="(s, i) in inspected.samples" :key="i" class="sample request-sample">
          <h2>尝试 {{ i + 1 }} 的请求</h2><p class="muted">请求 ID：{{ s.requestId ?? '未知' }}</p>
          <div v-if="s.instructions"><h4>指令</h4><pre>{{ s.instructions }}</pre></div>
          <div><h4>题目</h4><pre>{{ s.prompt || '旧版未记录' }}</pre></div>
        </article>
      </section>
      <details class="evidence">
        <summary>完整诊断数据</summary>
        <pre>{{ JSON.stringify({ ...current, samples: undefined, progress: undefined }, null, 2) }}</pre>
        <div class="actions"><ZButton size="small" @click="download(JSON.stringify(records, null, 2), 'model-test-' + current.id + '.json', 'application/json')">导出调试 JSON</ZButton><ZButton size="small" @click="copy(JSON.stringify(records, null, 2))">复制调试 JSON</ZButton></div>
      </details>
      <div class="actions export-actions"><ZButton size="small" variant="text" @click="exportSummary">导出摘要</ZButton><ZButton size="small" variant="text" @click="copy(readableSummary())">复制结果</ZButton><span class="muted" role="status">{{ notice }}</span></div>
      <ZTextarea v-if="rawFallback" v-model="rawFallback" readonly :rows="6" aria-label="可选中复制的结果文本" />
    </div>
  </ZCard>
</template>
