<script setup lang="ts">
import { ZButton } from '@codex-proxy/ui'
import type { Workspace } from '../workspace'
import { duration } from '../presentation'
defineProps<{ w: Workspace }>()
</script>
<template>
  <div v-if="w.error" class="feedback error" role="alert"><span>{{ w.error }}</span><ZButton size="small" @click="w.error = ''">关闭提示</ZButton></div>
  <div v-if="w.syncError" class="feedback warning" role="status">
    <span>同步未完成，已保存结果仍保留<span v-if="w.lastSyncedAt"> · 最近成功 {{ duration(w.clock - w.lastSyncedAt) }}前</span></span>
    <ZButton size="small" :disabled="w.loading" @click="w.refresh">重新读取</ZButton>
    <details><summary>查看原因</summary><p>{{ w.syncError }}</p></details>
  </div>
  <div v-if="w.notice" class="notice-inline" role="status"><span>{{ w.notice }}</span><ZButton size="small" variant="text" @click="w.notice = ''">关闭提示</ZButton></div>
</template>
