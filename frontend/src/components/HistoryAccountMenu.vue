<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ZButton, ZInput, ZPopover } from '@codex-proxy/ui'

const props = defineProps<{ batchId: string; accounts: { label: string; value: string }[] }>()
const emit = defineEmits<{ open: [account: string, origin: string] }>()
const origin = computed(() => props.batchId + ':accounts')
const query = ref(''), panel = ref<HTMLElement>()
const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  return props.accounts.filter(account => account.label.toLowerCase().includes(q) || account.value.toLowerCase().includes(q))
})
async function focusSearch() {
  query.value = ''
  await nextTick()
  panel.value?.querySelector('input')?.focus({ preventScroll: true })
}
</script>
<template>
  <ZPopover class="history-account-menu" placement="bottom-start" @open="focusSearch">
    <template #reference="{ open, id }">
      <ZButton size="small" :data-return-history="origin" :aria-expanded="open" :aria-controls="open ? id : undefined"
        aria-haspopup="dialog" :aria-label="'查看批次账号 · ' + accounts.length + ' 个账号'">
        {{ accounts.length }} 个账号 <span aria-hidden="true">▾</span>
      </ZButton>
    </template>
    <template #default="{ close }">
      <section ref="panel" class="history-account-panel" role="dialog" aria-label="查看批次账号">
        <ZInput v-model="query" size="small" aria-label="搜索批次账号" placeholder="搜索账号名称或 ID" />
        <div class="history-account-options">
          <ZButton v-for="a in matches" :key="a.value" size="small" variant="text"
            :aria-label="'查看 ' + a.label + ' 结果'" @click="close(); emit('open', a.value, origin)">
            <span class="history-account-option">{{ a.label }}</span>
          </ZButton>
          <p v-if="!matches.length" class="muted" role="status">未找到匹配账号</p>
        </div>
      </section>
    </template>
  </ZPopover>
</template>
