<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RecordEntry } from '../api'
import { label, profiles, reasons, active } from '../presentation'
import { artwork, download } from '../media'
const props = defineProps<{
  records: RecordEntry[]
  accountLabel: string
  clock: number
  readonly?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{
  action: [name: 'resume' | 'stop', r: RecordEntry]
  compare: [r: RecordEntry]
}>()
const code = ref(false),
  rawFallback = ref(''),
  notice = ref(''),
  fullRanking = ref(false),
  retryConfirm = ref('')
const current = computed(() => props.records[0])
const liveRecord = computed(() => props.records.find(active))
const canStop = computed(() => props.records.some((r) => active(r) || r.status === 'paused'))
const media = computed(() =>
  current.value ? artwork(current.value) : { raw: '', code: '', url: '', legacy: false },
)
const imageFailed = ref('')
const validCandy = computed(() =>
  props.records.filter((r) => r.status === 'completed' || ['correct', 'wrong'].includes(r.status)),
)
const correctCandy = computed(
  () => validCandy.value.filter((r) => r.verdict === 'correct' || r.status === 'correct').length,
)
const failedCandy = computed(
  () =>
    props.records.filter((r) =>
      ['paused', 'failed', 'unscorable', 'partial', 'interrupted', 'cancelled'].includes(r.status),
    ).length,
)
const stoppedCandy = computed(() => props.records.filter((r) => r.status === 'stopped').length)
const candyAnswer = computed(() => {
  const text = current.value?.samples.find((s) => s.valid !== false && s.status === 'completed')
    ?.answer?.text
  return text ? (text.trim().length <= 60 ? text.trim() : text.trim().slice(0, 60) + '…') : '—'
})
const phases: Record<string, string> = {
  requesting: '正在请求',
  waiting_events: '已取得请求 ID，等待事件',
  receiving_events: '正在接收事件',
  receiving_text: '正在接收正文',
}
const total = computed(() =>
  props.records
    .flatMap((r) => r.samples)
    .reduce(
      (sum, s) => {
        for (const [k, v] of Object.entries(s.answer?.usage ?? {}))
          if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v
        return sum
      },
      {} as Record<string, number>,
    ),
)
const duration = (ms: number) =>
  ms >= 60000
    ? `${Math.floor(ms / 60000)} 分 ${Math.floor(ms / 1000) % 60} 秒`
    : `${Math.floor(ms / 1000)} 秒`
const retryText = (r: RecordEntry) =>
  r.reason === 'scoring_failed'
    ? '重新分析 · 不发请求'
    : r.kind === 'fingerprint'
      ? `补测 ${Math.max(0, (r.expectedSamples ?? 3) - (r.validSamples ?? 0))} 个样本`
      : '重新生成 · 1 次请求'
function retry(r: RecordEntry) {
  if (r.reason === 'uncertain' && retryConfirm.value !== r.id) {
    retryConfirm.value = r.id
    return
  }
  emit('action', 'resume', r)
  retryConfirm.value = ''
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notice.value = '已复制'
  } catch {
    rawFallback.value = text
    notice.value = '复制受限，可选中下方文本复制'
  }
}
function exportRecord() {
  download(
    JSON.stringify(props.records, null, 2),
    `model-test-${current.value?.id}.json`,
    'application/json',
  )
  notice.value = '已请求下载；浏览器阻止下载时，可使用“复制结果”'
}
</script>
<template>
  <div v-if="current" class="test-result">
    <div class="result-heading">
      <div>
        <h2>{{ accountLabel }}</h2>
        <p class="muted">
          {{ current.model }} · {{ current.effort || '默认强度' }} ·
          {{ profiles[current.requestProfile ?? 'simple-v1'] ?? current.requestProfile
          }}<span v-if="current.kind === 'pelican'">
            · {{ current.outputVersion === 'svg-v1' ? '标准 SVG v1' : '旧版绘图题' }}</span
          >
        </p>
      </div>
      <span class="status" :data-state="current.status">{{
        records.length > 1 ? `${validCandy.length} / ${records.length} 份完成` : label(current)
      }}</span>
    </div>
    <div class="result-body">
      <p v-if="!current.task" class="notice">
        旧版记录保留原结果；未记录的身份与执行信息保持未知。
      </p>
      <template v-if="liveRecord">
        <p class="live">
          {{
            liveRecord.progress
              ? (phases[liveRecord.progress.phase] ?? '执行中')
              : liveRecord.status === 'scoring'
                ? '正在保存与分析'
                : liveRecord.status === 'queued'
                  ? '等待可用名额与完整执行窗口'
                  : '执行状态待恢复确认'
          }}
        </p>
        <h3>
          {{
            current.kind === 'fingerprint'
              ? `已保存 ${current.validSamples ?? 0} / 3 个有效样本`
              : current.kind === 'pelican'
                ? '作品正在生成'
                : '等待完整回答'
          }}
        </h3>
        <p v-if="liveRecord.progress" class="muted">
          已运行 {{ duration(clock - liveRecord.progress.startedAt) }} · 正文
          {{ liveRecord.progress.textBytes }} 字节 ·
          {{
            liveRecord.progress.lastEventAt
              ? `最近事件 ${duration(clock - liveRecord.progress.lastEventAt)}前`
              : '尚未收到事件'
          }}
          · 上限 {{ current.kind === 'pelican' ? '10 分钟' : '150 秒' }}
        </p>
        <p v-else class="muted">页面可以离开，检测由 CPR 继续执行。排队时间不算模型运行时间。</p>
        <details v-if="liveRecord.progress?.partialText">
          <summary>
            查看正在接收的正文{{ liveRecord.progress.partialTruncated ? '（节选）' : '' }}
          </summary>
          <pre>{{ liveRecord.progress.partialText }}</pre>
        </details>
      </template>
      <div v-if="current.status === 'paused'" class="warning">
        <strong>{{
          current.kind === 'fingerprint'
            ? `已保留 ${current.validSamples ?? 0} / 3 个有效样本`
            : current.kind === 'pelican'
              ? '未取得完整作品'
              : '本次回答未完成'
        }}</strong>
        <p>{{ reasons[current.reason ?? ''] ?? '请求未完成，已保留取得的内容。' }}</p>
      </div>
      <div v-if="current.kind === 'fingerprint'" class="sample-strip">
        <div v-for="n in 3" :key="n">
          <span>样本 {{ n }}</span
          ><small>{{
            current.attempts?.some((a) => a.step === n - 1 && a.valid)
              ? '已完成 · 有效'
              : current.progress?.step === n - 1
                ? '执行中'
                : current.status === 'completed' && current.attribution?.used_outputs === 3
                  ? '已完成 · 有效'
                  : '未完成'
          }}</small>
        </div>
      </div>
      <template v-if="current.kind === 'fingerprint' && current.attribution">
        <div v-if="current.attribution.results.length" class="candidate-summary">
          <div>
            <p class="eyebrow">参考库中最接近的候选</p>
            <h3>{{ current.attribution.prediction_name }}</h3>
            <p class="muted">{{ current.attribution.family_prediction_name || '家族未提供' }}</p>
          </div>
          <div class="probability">
            <strong>{{
              current.attribution.probability == null
                ? '—'
                : (current.attribution.probability * 100).toFixed(1) + '%'
            }}</strong
            ><small>库内相对概率</small>
          </div>
        </div>
        <h3 v-else>未形成候选结论</h3>
        <div class="ranking">
          <div
            v-for="(item, i) in current.attribution.results.slice(0, fullRanking ? undefined : 5)"
            :key="item.display_name"
            class="rank-row"
          >
            <span>{{ item.display_name }}</span>
            <div class="track">
              <span
                :class="{ first: i === 0 }"
                :style="{ width: `${Math.max(0, Math.min(100, (item.probability ?? 0) * 100))}%` }"
              ></span>
            </div>
            <span>{{
              item.probability == null ? '—' : (item.probability * 100).toFixed(1) + '%'
            }}</span>
          </div>
        </div>
        <button
          v-if="current.attribution.results.length > 5"
          class="quiet"
          @click="fullRanking = !fullRanking"
        >
          {{ fullRanking ? '收起排名' : '完整排名' }}
        </button>
        <p class="muted">仅比较参考库内候选，概率不代表模型身份证明。</p>
      </template>
      <template v-if="current.kind === 'candy'">
        <div class="candy-summary">
          <div>
            <p class="eyebrow">{{ records.length > 1 ? '本次正确 / 有效回答' : '实际回答' }}</p>
            <h3 class="big-answer">
              {{ records.length > 1 ? `${correctCandy} / ${validCandy.length}` : candyAnswer }}
            </h3>
            <p>
              {{
                validCandy.length
                  ? `${correctCandy} 个正确 · 执行失败 ${failedCandy}${stoppedCandy ? ` · 已停止 ${stoppedCandy}` : ''}`
                  : '尚无完整有效回答'
              }}
            </p>
          </div>
          <div class="answer-key"><small>标准答案</small><strong>21</strong></div>
        </div>
        <details v-for="(r, i) in records" :key="r.id" class="sample">
          <summary>第 {{ i + 1 }} 次 · {{ label(r) }}</summary>
          <pre>{{
            r.samples.find((s) => s.valid !== false && s.status === 'completed')?.answer?.text ??
            r.samples.at(-1)?.answer?.text ??
            '暂无完整回答'
          }}</pre>
          <button
            v-if="records.length > 1 && r.canResume && !readonly"
            :disabled="busy"
            @click="retry(r)"
          >
            {{ retryConfirm === r.id ? '确认补测，可能再次消耗额度' : retryText(r) }}
          </button>
        </details>
      </template>
      <template v-if="current.kind === 'pelican' && media.raw">
        <div class="art-heading">
          <h3>作品已生成</h3>
          <span class="muted">{{ duration(current.durationMs) }}</span>
        </div>
        <div class="actions">
          <button :aria-pressed="!code" @click="code = false">预览</button
          ><button :aria-pressed="code" @click="code = true">代码</button>
        </div>
        <pre v-if="code">{{ media.code }}</pre>
        <img
          v-else-if="media.url && imageFailed !== current.id"
          class="drawing"
          :src="media.url"
          alt="鹈鹕绘图预览"
          referrerpolicy="no-referrer"
          @error="imageFailed = current.id"
        />
        <p v-else class="warning">
          已生成，{{
            media.legacy ? '旧版 HTML 格式无法完整预览' : '当前 SVG 无法预览'
          }}。原始代码可复制或下载，生成结果仍然保留。
        </p>
        <div class="actions">
          <button @click="copy(media.code)">复制代码</button
          ><button
            @click="
              download(
                media.code,
                `pelican-${current.id}.${media.legacy ? 'html' : 'svg'}`,
                media.legacy ? 'text/html' : 'image/svg+xml',
              )
            "
          >
            下载{{ media.legacy ? '原文' : ' SVG' }}</button
          ><button v-if="imageFailed === current.id" @click="imageFailed = ''">
            重新预览 · 不发请求</button
          ><button v-if="media.url" class="quiet" @click="emit('compare', current)">
            加入作品对比
          </button>
        </div>
      </template>
      <div class="actions" v-if="!readonly">
        <button v-if="current.canResume" class="primary" :disabled="busy" @click="retry(current)">
          {{
            retryConfirm === current.id ? '确认补测，可能再次消耗额度' : retryText(current)
          }}</button
        ><button
          v-if="canStop"
          :disabled="busy || current.stopRequested"
          @click="emit('action', 'stop', current)"
        >
          {{ current.stopRequested ? '正在停止' : current.batchId ? '停止此账号' : '停止此检测' }}
        </button>
      </div>
      <p v-if="current.canResume && current.reason !== 'scoring_failed'" class="muted">
        只补缺失或无效样本；此前请求可能已消耗额度。
      </p>
      <details class="evidence">
        <summary>原始回答与请求详情</summary>
        <p class="muted">
          检测时间 {{ new Date(current.startedAt).toLocaleString() }} · 插件
          {{ current.pluginVersion ?? '旧版未记录' }} · 检测器 {{ current.detectorVersion }}
        </p>
        <p class="muted">
          Token：{{
            Object.keys(total).length
              ? Object.entries(total)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')
              : '最终用量未提供，不能解释为零消耗'
          }}
        </p>
        <details v-for="(s, i) in current.samples" :key="i" class="sample">
          <summary>
            尝试 {{ i + 1 }} ·
            {{
              s.valid === false
                ? '未作为有效结果'
                : s.status === 'completed'
                  ? '完整完成'
                  : '未完成'
            }}
            · {{ duration(s.durationMs) }}
          </summary>
          <pre>{{ s.answer?.text || '未取得正文' }}</pre>
          <p class="muted">请求 ID：{{ s.requestId ?? '未知' }}</p>
          <p v-if="s.error?.origin === 'plugin'">
            达到插件 {{ (s.error.timeoutMs ?? 0) / 1000 }} 秒等待上限；已收到的部分回答不参与判分。
          </p>
          <p v-else-if="s.error" class="muted">
            {{ s.error.code }} · {{ s.error.kind ?? '未提供细分原因' }} · HTTP
            {{ s.error.httpStatus ?? '未知' }}
          </p>
          <details>
            <summary>题目与指令</summary>
            <pre
              >{{ s.instructions }}
{{ s.prompt }}</pre
            >
          </details>
        </details>
        <details>
          <summary>冻结计划与版本依据</summary>
          <pre>{{
            JSON.stringify({ ...current, samples: undefined, progress: undefined }, null, 2)
          }}</pre>
        </details>
      </details>
      <div class="actions export-actions">
        <button class="quiet" @click="exportRecord">导出当前结果</button
        ><button class="quiet" @click="copy(JSON.stringify(records, null, 2))">复制结果</button
        ><span class="muted" role="status">{{ notice }}</span>
      </div>
      <textarea
        v-if="rawFallback"
        v-model="rawFallback"
        readonly
        rows="6"
        aria-label="可选中复制的结果文本"
      />
    </div>
  </div>
</template>
