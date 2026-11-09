<script setup lang="ts">
import { computed } from 'vue'
import { ZButton, ZCard, ZTable, ZTag, type TableColumn } from '@codex-proxy/ui'
import type { Workspace } from '../workspace'
import { active, duration, label, phases, recordTone } from '../presentation'
import { artwork } from '../media'
const props = defineProps<{ w: Workspace }>()
const emit = defineEmits<{ open: [id: string] }>()
const rows = computed(() => props.w.batchAccounts.map((id) => {
  const records = props.w.batchRows.filter((r) => r.accountId === id)
  const current = records.find(active) ?? records.find((r) => r.status === 'paused') ?? records.at(-1)
  const valid = records.filter((r) => ['completed', 'correct', 'wrong'].includes(r.status))
  const failed = records.filter((r) => ['paused', 'failed', 'partial', 'interrupted', 'unscorable'].includes(r.status))
  const correct = valid.filter((r) => r.verdict === 'correct' || r.status === 'correct').length
  let summary = '正在准备'
  if (current) {
    summary = active(current)
      ? current.progress ? phases[current.progress.phase] ?? label(current) : label(current)
      : current.kind === 'candy'
        ? correct + ' / ' + valid.length + ' 答对' + (failed.length ? ' · ' + failed.length + ' 次未完成' : '')
        : current.status === 'paused'
          ? '已保留 ' + (current.validSamples ?? 0) + ' / ' + (current.expectedSamples ?? 3) + ' 个样本'
          : current.kind === 'fingerprint' && current.attribution?.prediction_name
            ? current.attribution.prediction_name
            : label(current)
  }
  return { id, name: records[0] ? props.w.recordLabel(records[0]) : props.w.accountLabel(id), current,
    summary, samples: props.w.currentBatch?.request.kind === 'candy'
      ? valid.length + ' / ' + records.length + ' 份完成'
      : current ? (current.validSamples ?? 0) + ' / ' + (current.expectedSamples ?? 1) + ' 份有效' : '等待保存',
    elapsed: records.length ? duration(records.reduce((sum, r) => sum + r.durationMs, 0)) : '—' }
}))
type Row = (typeof rows.value)[number]
const columns: TableColumn<Row>[] = [
  { key: 'name', label: '账号', kind: 'identity', minWidth: 140 },
  { key: 'summary', label: '结果 / 当前阶段', kind: 'text', minWidth: 170 },
  { key: 'samples', label: '样本', kind: 'meta', minWidth: 110 },
  { key: 'elapsed', label: '累计耗时', kind: 'meta', minWidth: 85 },
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
      <template #summary="{ row }">
        <div class="overview-summary"><ZTag v-if="row.current" size="small" :type="recordTone(row.current)">{{ label(row.current) }}</ZTag><span>{{ row.summary }}</span></div>
      </template>
      <template #actions="{ row }"><ZButton :data-return-account="row.id" size="small" @click="emit('open', row.id)" :aria-label="'查看 ' + row.name + ' 结果'">查看结果</ZButton></template>
    </ZTable>
    <div class="mobile-results">
      <ZCard v-for="row in rows" :key="row.id" padding="compact">
        <div class="aside-heading"><strong>{{ row.name }}</strong><ZTag v-if="row.current" :type="recordTone(row.current)" size="small">{{ label(row.current) }}</ZTag></div>
        <p>{{ row.summary }}</p><p class="muted">{{ row.samples }} · {{ row.elapsed }}</p>
        <ZButton :data-return-account="row.id" size="small" @click="emit('open', row.id)" :aria-label="'查看 ' + row.name + ' 结果'">查看结果</ZButton>
      </ZCard>
    </div>
  </div>
</template>
