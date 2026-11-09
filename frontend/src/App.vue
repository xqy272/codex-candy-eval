<script setup lang="ts">
import { computed, nextTick, reactive } from 'vue'
import { ZButton, ZConfigProvider, ZPageHeader, ZPopover, ZSegmented } from '@codex-proxy/ui'
import { zhHans } from '@codex-proxy/ui/locale'
import { workspace } from './workspace'
import { isPreview } from './api'
import { duration, kinds } from './presentation'
import RequestPanel from './components/RequestPanel.vue'
import AccountPicker from './components/AccountPicker.vue'
import ResultWorkspace from './components/ResultWorkspace.vue'
import HistoryList, { type HistoryRow } from './components/HistoryList.vue'
import ArtworkComparison from './components/ArtworkComparison.vue'
const w = reactive(workspace())
const navOptions = [{ label: '测试', value: 'test' }, { label: '记录', value: 'history' }]
const typeOptions = kinds
const currentNav = computed({ get: () => w.nav, set: (value: string) => {
  w.nav = value === 'history' ? 'history' : 'test'
}})
const currentKind = computed({ get: () => w.kind, set: (value: string) => w.chooseKind(value) })
let returnHistory = ''
async function restoreFocus(attribute: string, value: string) {
  await nextTick()
  const element = [...document.querySelectorAll<HTMLElement>('[' + attribute + ']')].find((el) => el.getAttribute(attribute) === value && el.getClientRects().length)
  element?.focus({ preventScroll: true })
  element?.scrollIntoView({ block: 'nearest' })
}
function openAccount(id: string) { w.focusAccount(id) }
function backToBatch() { w.detailOpen = false; void restoreFocus('data-return-account', w.focus) }
function openHistory(row: HistoryRow) {
  returnHistory = row.id
  if (row.batch) w.openBatch(row.batch)
  else if (row.record) w.openLegacy(row.record)
}
function backToHistory() { w.closeHistory(); void restoreFocus('data-return-history', returnHistory) }
</script>
<template>
  <ZConfigProvider :locale="zhHans">
    <main class="eval-page">
      <ZPageHeader v-if="isPreview" title="模型测试" description="独立预览" />
      <header class="page-heading">
        <ZSegmented v-model="currentNav" aria-label="插件导航" :options="navOptions" />
        <div class="heading-actions">
          <ZPopover trigger="click">
            <template #reference><ZButton size="small" variant="text">保留规则</ZButton></template>
            <p>历史有容量上限，旧的已结束检测可能淘汰</p><p>排队、执行与等待处理的检测受到保护</p>
          </ZPopover>
          <ZButton size="small" :disabled="w.loading || isPreview" :loading="w.loading && !isPreview" @click="w.refresh">刷新</ZButton>
        </div>
      </header>
      <p v-if="isPreview" class="feedback notice">从 CPR 插件入口打开后，可读取账号并发起检测</p>
      <div v-if="w.error" class="feedback error" role="alert"><span>{{ w.error }}</span><ZButton size="small" @click="w.error = ''">关闭提示</ZButton></div>
      <div v-if="w.syncError" class="feedback warning" role="status">
        <span>同步未完成，已保存结果仍保留<span v-if="w.lastSyncedAt"> · 最近成功 {{ duration(w.clock - w.lastSyncedAt) }}前</span></span>
        <ZButton size="small" :disabled="w.loading" @click="w.refresh">重新读取</ZButton>
        <details><summary>查看原因</summary><p>{{ w.syncError }}</p></details>
      </div>
      <div v-if="w.notice" class="notice-inline" role="status"><span>{{ w.notice }}</span><ZButton size="small" variant="text" @click="w.notice = ''">关闭提示</ZButton></div>
      <section v-if="w.nav === 'test'" class="test-workbench">
        <ZSegmented v-model="currentKind" class="type-tabs" aria-label="测试类型" :options="typeOptions" />
        <RequestPanel :w="w" />
        <div class="workspace">
          <AccountPicker :w="w" />
          <ResultWorkspace :w="w" @open="openAccount" @back="backToBatch" />
        </div>
      </section>
      <section v-else class="history-workspace">
        <HistoryList v-show="!w.historyDetail" :w="w" @open="openHistory" />
        <ResultWorkspace v-if="w.historyDetail" :w="w" @open="openAccount" @back="backToBatch" @history-back="backToHistory" />
      </section>
      <ArtworkComparison :w="w" />
    </main>
  </ZConfigProvider>
</template>
