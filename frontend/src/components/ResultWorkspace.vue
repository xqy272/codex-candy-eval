<script setup lang="ts">
import { computed } from 'vue'
import { ZButton, ZCard, ZSkeleton, ZTag } from '@codex-proxy/ui'
import type { Workspace } from '../workspace'
import { batchCompletionTime, kinds, profiles } from '../presentation'
import BatchResults from './BatchResults.vue'
import TestResult from './TestResult.vue'
import ResultTimestamp from './ResultTimestamp.vue'
const props = defineProps<{ w: Workspace; dialog?: boolean }>()
const emit = defineEmits<{ open: [id: string] }>()
const batchTime = computed(() => {
  const { w } = props
  const b = w.currentBatch
  if (!b || props.dialog) return
  const finished = batchCompletionTime(b, w.batchRows)
  if (finished) return { label: '完成于', value: finished }
  if (w.batchState(b) === 'completed') return { label: '完成时间', value: undefined }
  return { label: '发起于', value: b.startedAt }
})
const keyLabel = computed(() => {
  const { w } = props
  const id = w.currentBatch?.request.clientKeyId ?? w.resultRecords[0]?.clientKeyId
  return id ? w.keys.find(key => key.id === id)?.name || id : ''
})
</script>
<template>
  <section class="work-area" aria-label="当前测试结果">
    <template v-if="w.currentBatch && (!dialog || !w.detailOpen)">
      <div class="current-batch">
        <div><h2>本批次 · {{ kinds.find((k) => k.value === w.currentBatch?.request.kind)?.label }}</h2>
          <div class="batch-status-line muted"><span>{{ w.batchStatus(w.currentBatch) }} · 完成 {{ w.completedAccounts.length }} / {{ w.batchAccounts.length }} 个账号<span v-if="w.waitingAccounts.length"> · {{ w.waitingAccounts.length }} 个等待处理</span></span><span v-if="batchTime" class="batch-time">{{ batchTime.label }} <ResultTimestamp :value="batchTime.value" /></span></div></div>
        <ZButton v-if="w.running || !w.currentBatch.ready" size="small" :disabled="w.busy" @click="w.stopBatch">停止本批次</ZButton>
      </div>
      <div class="frozen-conditions" aria-label="本批次冻结条件">
        <span class="muted">冻结条件</span>
        <ZTag size="small">{{ w.currentBatch.request.model }}</ZTag>
        <ZTag size="small">{{ w.currentBatch.request.effort || '默认强度' }}</ZTag>
        <ZTag size="small">{{ profiles[w.currentBatch.request.profile] }}</ZTag>
        <ZTag size="small">{{ w.keys.find((k) => k.id === w.currentBatch?.request.clientKeyId)?.name ?? '已保存的 Key ID' }}</ZTag>
      </div>
      <BatchResults :w="w" @open="emit('open', $event)" />
    </template>
    <TestResult v-if="dialog && w.detailOpen && w.resultRecords.length" :key="w.resultRecords[0]!.id" :records="w.resultRecords"
      :account-label="w.recordLabel(w.resultRecords[0]!)" :clock="w.clock" :busy="w.busy"
      :client-key="keyLabel"
      @action="w.action" @compare="w.compare" />
    <div v-else-if="dialog && w.reportLoading && w.detailOpen" class="result-skeleton"><ZSkeleton /><ZSkeleton /><ZSkeleton /></div>
    <ZCard v-else-if="!w.currentBatch && !w.legacyId" padding="compact" class="result-empty">
      <h2>选择账号，开始一次检测</h2>
      <p class="muted">{{ w.kind === 'fingerprint' ? '每账号取得三份有效样本后展示参考库候选' : w.kind === 'candy' ? '固定原题，标准答案 21，执行失败单列' : '生成后直接预览 SVG，单次最多等待 10 分钟' }}</p>
    </ZCard>
    <p v-else-if="dialog && w.detailOpen && !w.resultRecords.length && !w.reportLoading" class="feedback notice">当前账号暂无可读结果，部分旧记录可能已淘汰</p>
  </section>
</template>
