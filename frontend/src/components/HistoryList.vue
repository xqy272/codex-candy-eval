<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ZButton, ZCard, ZEmpty, ZFormItem, ZInput, ZSelect, ZTable, ZTag, type TableColumn } from '@codex-proxy/ui'
import type { Batch, RecordEntry } from '../api'
import type { Workspace } from '../workspace'
import { executionOptions, kinds, label, profiles, recordTone, verdictOptions } from '../presentation'
import HistoryAccountLinks from './HistoryAccountLinks.vue'
const props = defineProps<{ w: Workspace }>()
const emit = defineEmits<{ open: [row: HistoryRow, account?: string, origin?: string] }>()
export interface HistoryRow {
  id: string
  title: string
  conditions: string
  status: string
  startedAt: number
  accounts: { label: string; value: string }[]
  batch?: Batch
  record?: RecordEntry
}
const page = ref(0)
const rows = computed<HistoryRow[]>(() => [
  ...props.w.historyItems.map((b) => ({
    id: b.request.id,
    title: (kinds.find((k) => k.value === b.request.kind)?.label ?? b.request.kind) + ' · ' + b.request.accountIds.length + ' 个账号',
    conditions: [b.request.model, b.request.effort || '默认强度', profiles[b.request.profile]].join(' · '),
    status: props.w.batchStatus(b), startedAt: b.startedAt, batch: b,
    accounts: b.request.accountIds.map((id) => ({ label: props.w.batchAccountLabel(b, id), value: id })),
  })),
  ...props.w.legacyItems.map((r) => ({
    id: r.id,
    title: (kinds.find((k) => k.value === r.kind)?.label ?? r.kind) + ' · ' + props.w.recordLabel(r),
    conditions: r.model + ' · ' + (r.task ? '独立检测' : '旧版记录'),
    status: label(r), startedAt: r.startedAt, record: r, accounts: [],
  })),
].sort((a, b) => b.startedAt - a.startedAt))
const paged = computed(() => rows.value.slice(page.value * 10, page.value * 10 + 10))
watch(() => [props.w.filterKind, props.w.filterAccount, props.w.filterStatus, props.w.filterDate, props.w.filterVerdict], () => { page.value = 0 })
watch(rows, () => { page.value = Math.min(page.value, Math.max(0, Math.ceil(rows.value.length / 10) - 1)) })
const columns: TableColumn<HistoryRow>[] = [
  { key: 'title', label: '检测', kind: 'identity', minWidth: 180 },
  { key: 'conditions', label: '冻结条件', kind: 'text', minWidth: 210 },
  { key: 'status', label: '状态', kind: 'status', minWidth: 100 },
  { key: 'startedAt', label: '时间', kind: 'datetime', formatter: (v) => new Date(Number(v)).toLocaleString(), minWidth: 140 },
  { key: 'actions', label: '操作', kind: 'actions', width: 100 },
]
function batchTone(row: HistoryRow) {
  if (row.record) return recordTone(row.record)
  return row.status === '检测中' ? 'info' : ['部分完成', '待确认提交'].includes(row.status) ? 'warning' : 'default'
}
function preferredAccount(row: HistoryRow) {
  const id = props.w.filterAccount
  return row.accounts.some(account => account.value === id) ? id : undefined
}
const actionLabel = (row: HistoryRow) => row.accounts.length > 1 && !preferredAccount(row) ? '批次总览' : '查看结果'
</script>
<template>
  <section aria-label="检测记录">
    <ZCard padding="compact">
      <div class="history-filters">
        <ZFormItem label="测试"><ZSelect v-model="w.filterKind" aria-label="筛选测试" :options="[{ label: '全部测试', value: '' }, ...kinds]" /></ZFormItem>
        <ZFormItem label="账号"><ZSelect v-model="w.filterAccount" aria-label="筛选账号" filterable
          :options="[{ label: '全部账号', value: '' }, ...w.accounts.map((a) => ({ label: w.accountLabel(a.account_id), value: a.account_id }))]" /></ZFormItem>
        <ZFormItem label="执行状态"><ZSelect v-model="w.filterStatus" aria-label="筛选状态" :options="executionOptions" /></ZFormItem>
        <ZFormItem label="测试结论"><ZSelect v-model="w.filterVerdict" aria-label="筛选结果" :options="verdictOptions" /></ZFormItem>
        <ZFormItem label="日期"><ZInput v-model="w.filterDate" type="date" aria-label="筛选日期" /></ZFormItem>
      </div>
    </ZCard>
    <ZTable v-if="rows.length" class="history-table desktop-results" :columns="columns" :data="paged" row-key="id">
      <template #title="{ row }"><strong>{{ row.title }}</strong><HistoryAccountLinks v-if="!w.filterAccount" :batch-id="row.id" :accounts="row.accounts" @open="(id, origin) => emit('open', row, id, origin)" /></template>
      <template #status="{ row }"><ZTag size="small" :type="batchTone(row)">{{ row.status }}</ZTag></template>
      <template #actions="{ row }"><ZButton :data-return-history="row.id" size="small" @click="emit('open', row, preferredAccount(row))">{{ actionLabel(row) }}</ZButton></template>
    </ZTable>
    <div v-if="rows.length" class="mobile-results">
      <ZCard v-for="row in paged" :key="row.id" padding="compact" class="history-row">
        <div class="aside-heading"><strong>{{ row.title }}</strong><ZTag size="small" :type="batchTone(row)">{{ row.status }}</ZTag></div>
        <p class="muted">{{ row.conditions }}</p><p class="muted">{{ new Date(row.startedAt).toLocaleString() }}</p>
        <HistoryAccountLinks v-if="!w.filterAccount" :batch-id="row.id" :accounts="row.accounts" @open="(id, origin) => emit('open', row, id, origin)" />
        <ZButton :data-return-history="row.id" size="small" @click="emit('open', row, preferredAccount(row))">{{ actionLabel(row) }}</ZButton>
      </ZCard>
    </div>
    <ZEmpty v-if="!rows.length" description="暂无符合筛选条件的记录" />
    <div v-if="rows.length > 10" class="pagination">
      <ZButton size="small" :disabled="page === 0" @click="page--">上一页</ZButton>
      <span class="muted">{{ page + 1 }} / {{ Math.ceil(rows.length / 10) }}</span>
      <ZButton size="small" :disabled="(page + 1) * 10 >= rows.length" @click="page++">下一页</ZButton>
    </div>
  </section>
</template>
