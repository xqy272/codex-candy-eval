<script setup lang="ts">
import { computed } from 'vue'
import { ZButton, ZCard, ZTable, ZTag, type TableColumn } from '@codex-proxy/ui'
import type { Workspace } from '../workspace'
import { active, duration, executionState, label, phases, recordTone } from '../presentation'
import { artwork } from '../media'
const props = defineProps<{ w: Workspace }>()
const emit = defineEmits<{ open: [id: string] }>()
const rows = computed(() => props.w.batchAccounts.map((id) => {
  const batch = props.w.currentBatch!
  const kind = batch.request.kind
  const expected = kind === 'candy' ? batch.request.repeats : 1
  const records = props.w.batchRows.filter(r => r.accountId === id)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  const current = records.find(active) ?? records.find(r => r.status === 'paused') ?? records.at(-1)
  const completed = records.filter(r => executionState(r) === 'completed')
  const unfinished = records.filter(r => executionState(r) === 'paused' || executionState(r) === 'failed')
  const stopped = records.filter(r => executionState(r) === 'stopped')
  const missing = Math.max(0, expected - records.length)
  const complete = completed.length === expected
  const live = records.some(active)
  let state = batch.ready ? '记录不完整' : '准备中'
  let stateTone: ReturnType<typeof recordTone> = 'warning'
  if (live) {
    state = current?.status === 'queued' ? '排队中' : current?.status === 'scoring' ? '正在保存' : '执行中'
    stateTone = 'info'
  } else if (complete) {
    state = kind === 'ciallo' ? '完整返回' : '已完成'
    stateTone = 'success'
  } else if (unfinished.length) {
    state = kind === 'ciallo' ? '未完成' : records.some(r => r.status === 'paused') ? '等待处理' : '执行失败'
    stateTone = records.some(r => r.status === 'paused') ? 'warning' : 'danger'
  } else if (stopped.length) {
    state = stopped.length === expected ? '已停止' : '部分停止'
    stateTone = 'default'
  }
  const progress = live && current?.progress ? phases[current.progress.phase] ?? ''
    : !complete && expected > 1 && records.length ? completed.length + ' / ' + expected + ' 次完成' : ''

  let result = '尚无已保存结果', detail = '', resultBadge = false
  let resultTone: ReturnType<typeof recordTone> = 'default'
  if (kind === 'ciallo' && current) {
    const preview = (live && current.status !== 'scoring' ? current.progress?.partialText : current.answerPreview) ?? ''
    result = preview.replace(/\s+/gu, ' ').trim() || (live ? '等待模型回复' : complete ? '未记录回复摘要，请查看结果' : '尚未取得回复正文')
    if (preview && !complete) detail = live ? '收到的正文 · 等待完整结束' : '已保留部分回复 · 未完整结束'
  } else if (kind === 'candy') {
    const correct = completed.filter(r => r.verdict === 'correct' || r.status === 'correct').length
    if (completed.length) {
      result = expected === 1 ? label(completed[0]!) : correct + ' / ' + completed.length + ' 答对'
      resultBadge = true
      resultTone = correct === completed.length ? 'success' : 'danger'
    } else result = live ? '等待完整回答' : '尚无有效回答'
    detail = [unfinished.length ? unfinished.length + ' 次未完成' : '', stopped.length ? stopped.length + ' 次已停止' : ''].filter(Boolean).join(' · ')
  } else if (kind === 'fingerprint' && current) {
    const probability = current.attribution?.probability
    if (current.status === 'completed') {
      result = current.attribution?.prediction_name || '未形成候选结论'
      detail = [typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1 ? (probability * 100).toFixed(1) + '% 库内概率' : '',
        (current.validSamples ?? 0) + ' 份有效样本'].filter(Boolean).join(' · ')
    } else {
      result = live ? '等待完整样本与候选分析' : '尚未形成候选排名'
      detail = '已保留 ' + (current.validSamples ?? 0) + ' / ' + (current.expectedSamples ?? 3) + ' 份有效样本'
    }
  } else if (kind === 'pelican' && current) {
    result = current.status === 'completed' ? '作品已生成' : live ? '等待完整作品' : '未取得完整作品'
    detail = current.outputVersion === 'svg-v1' ? '标准 SVG' : '旧版绘图题'
  }
  if (missing && batch.ready) detail = [detail, '缺少 ' + missing + ' 份记录'].filter(Boolean).join(' · ')
  return { id, name: records[0] ? props.w.recordLabel(records[0]) : props.w.accountLabel(id),
    state, stateTone, progress, result, detail, resultBadge, resultTone, reply: kind === 'ciallo',
    elapsed: records.length ? duration(records.reduce((sum, r) => sum + r.durationMs, 0)) : '—' }
}))
type Row = (typeof rows.value)[number]
const columns: TableColumn<Row>[] = [
  { key: 'name', label: '账号', kind: 'identity', minWidth: 150 },
  { key: 'state', label: '执行情况', kind: 'status', align: 'left', minWidth: 100 },
  { key: 'result', label: '检测结果', kind: 'text', minWidth: 200 },
  { key: 'elapsed', label: '耗时', kind: 'meta', minWidth: 85 },
  { key: 'actions', label: '操作', kind: 'actions', width: 100 },
]
</script>
<template>
  <div class="batch-results" aria-label="本批次总览">
    <div v-if="w.gallery.length" class="art-gallery" aria-label="本批次作品">
      <ZCard v-for="r in w.gallery" :key="r.id" padding="compact">
        <img v-if="artwork(r).url" :src="artwork(r).url" alt="已生成作品缩略图" />
        <p v-else class="muted">作品已生成，可查看原始代码</p>
        <div class="gallery-caption"><strong>{{ w.recordLabel(r) }}</strong><ZButton :data-return-account="r.accountId" size="small" @click="emit('open', r.accountId)">查看作品</ZButton></div>
      </ZCard>
    </div>
    <ZTable class="desktop-results" :columns="columns" :data="rows" row-key="id" empty-text="批次正在保存">
      <template #name="{ row }"><strong>{{ row.name }}</strong></template>
      <template #state="{ row }">
        <div class="overview-summary" :data-execution-account="row.id"><ZTag size="small" :type="row.stateTone">{{ row.state }}</ZTag><span v-if="row.progress" class="muted">{{ row.progress }}</span></div>
      </template>
      <template #result="{ row }">
        <div class="overview-summary" :data-result-account="row.id">
          <ZTag v-if="row.resultBadge" size="small" :type="row.resultTone">{{ row.result }}</ZTag>
          <span v-else :class="{ 'reply-preview': row.reply }">{{ row.result }}</span>
          <span v-if="row.detail" class="muted">{{ row.detail }}</span>
        </div>
      </template>
      <template #actions="{ row }"><ZButton :data-return-account="row.id" size="small" @click="emit('open', row.id)" :aria-label="'查看 ' + row.name + ' 结果'">查看结果</ZButton></template>
    </ZTable>
    <div class="mobile-results">
      <ZCard v-for="row in rows" :key="row.id" padding="compact">
        <div class="aside-heading"><strong>{{ row.name }}</strong><ZTag :type="row.stateTone" size="small">{{ row.state }}</ZTag></div>
        <p v-if="row.progress" class="muted">{{ row.progress }}</p>
        <div class="overview-summary mobile-outcome" :data-result-account="row.id">
          <ZTag v-if="row.resultBadge" size="small" :type="row.resultTone">{{ row.result }}</ZTag>
          <p v-else :class="{ 'reply-preview': row.reply }">{{ row.result }}</p>
          <p v-if="row.detail" class="muted">{{ row.detail }}</p>
        </div>
        <div class="mobile-result-footer"><span class="muted">耗时 {{ row.elapsed }}</span><ZButton :data-return-account="row.id" size="small" @click="emit('open', row.id)" :aria-label="'查看 ' + row.name + ' 结果'">查看结果</ZButton></div>
      </ZCard>
    </div>
  </div>
</template>
