<script setup lang="ts">
import { ZButton, ZSelect } from '@codex-proxy/ui'
defineProps<{ batchId: string; accounts: { label: string; value: string }[] }>()
const emit = defineEmits<{ open: [account: string, origin: string] }>()
</script>
<template>
  <div v-if="accounts.length > 1" class="history-account-links" aria-label="直接查看账号">
    <ZButton v-for="a in accounts.slice(0, 3)" :key="a.value" size="small" variant="text"
      :data-return-history="batchId + ':' + a.value" :aria-label="'查看 ' + a.label + ' 结果'"
      @click="emit('open', a.value, batchId + ':' + a.value)"><span class="history-account-name">{{ a.label }}</span></ZButton>
    <ZSelect v-if="accounts.length > 3" class="history-more-accounts" size="small" aria-label="查看其他账号"
      :data-return-history="batchId + ':more'" :options="accounts.slice(3)" placeholder="其他账号" filterable
      :model-value="undefined" @update:model-value="(value) => { if (value) emit('open', value, batchId + ':more') }" />
  </div>
</template>
