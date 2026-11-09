<script setup lang="ts">
import { ZButton, ZCard, ZCheckbox, ZEmpty, ZInput, ZScrollbar, ZTag } from '@codex-proxy/ui'
import type { Workspace } from '../workspace'
defineProps<{ w: Workspace }>()
function select(w: Workspace, id: string, value: boolean) {
  w.selected = value ? [...new Set([...w.selected, id])] : w.selected.filter((v) => v !== id)
}
</script>
<template>
  <ZCard id="account-picker" padding="compact" class="accounts" :class="{ expanded: w.mobileAccounts }" aria-label="下一次检测账号">
    <div class="aside-heading"><h2>下一次检测</h2><ZTag size="small">已选 {{ w.selected.length }}</ZTag></div>
    <ZInput v-model="w.accountSearch" type="search" placeholder="搜索名称、邮箱或 ID" aria-label="搜索账号" clearable />
    <div class="selection-actions">
      <ZButton size="small" variant="text" :disabled="w.busy" @click="w.toggleFiltered(true)">选择筛选结果</ZButton>
      <ZButton size="small" variant="text" :disabled="w.busy" @click="w.toggleFiltered(false)">取消选择</ZButton>
    </div>
    <ZScrollbar max-height="30rem">
      <div v-for="a in w.pageAccounts" :key="a.account_id" class="account-row">
        <ZCheckbox :model-value="w.selected.includes(a.account_id)" :disabled="!a.enabled || w.busy"
          :aria-label="'选择 ' + w.accountLabel(a.account_id)" @update:model-value="select(w, a.account_id, $event)">
          <template #label>
            <span class="account-identity"><strong>{{ w.accountLabel(a.account_id) }}</strong><small>{{ a.enabled ? '可用' : '已停用' }}</small></span>
          </template>
        </ZCheckbox>
      </div>
      <ZEmpty v-if="!w.accounts.length" :description="w.loading ? '正在读取账号' : '暂无 OpenAI 账号'" />
      <ZEmpty v-else-if="!w.filteredAccounts.length" description="未找到匹配账号" />
    </ZScrollbar>
    <div v-if="w.filteredAccounts.length > 20" class="pagination">
      <ZButton size="small" :disabled="w.accountPage === 0" @click="w.accountPage--">上一页</ZButton>
      <span class="muted">{{ w.accountPage + 1 }} / {{ Math.ceil(w.filteredAccounts.length / 20) }}</span>
      <ZButton size="small" :disabled="(w.accountPage + 1) * 20 >= w.filteredAccounts.length" @click="w.accountPage++">下一页</ZButton>
    </div>
    <p class="muted account-hint">勾选只改变下一次检测的目标</p>
  </ZCard>
</template>
