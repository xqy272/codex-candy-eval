<script setup lang="ts">
import { computed } from 'vue'
import { ZButton, ZCard, ZFormItem, ZPopover, ZSelect } from '@codex-proxy/ui'
import type { Workspace } from '../workspace'
import { drawingVersions, profiles } from '../presentation'
defineProps<{ w: Workspace }>()
const profileOptions = computed(() => Object.entries(profiles).map(([value, label]) => ({ value, label })))
const drawingOptions = ['svg-v2', 'legacy-animation-v1'].map((value) => ({ value, label: drawingVersions[value] }))
</script>
<template>
  <ZCard padding="compact" class="request-panel" aria-label="下一次检测配置">
    <div class="request-fields">
      <ZFormItem label="模型">
        <ZSelect v-model="w.model" aria-label="模型" :options="w.models.map((m) => ({ label: m, value: m }))"
          :placeholder="w.modelLoading ? '正在读取模型' : w.models.length ? '请选择模型' : '暂无可用模型'"
          :loading="w.modelLoading" :disabled="w.busy || w.modelLoading" filterable />
      </ZFormItem>
      <ZFormItem label="推理强度">
        <ZSelect v-model="w.effort" aria-label="推理强度" :options="w.effortOptions" :disabled="w.busy" />
      </ZFormItem>
      <ZFormItem v-if="w.kind === 'ciallo'" label="固定消息"><code class="fixed-message">ciallo</code></ZFormItem>
      <ZFormItem v-else label="请求语境">
        <ZSelect v-model="w.profile" aria-label="请求语境" :options="profileOptions" :disabled="w.busy" />
      </ZFormItem>
      <ZFormItem label="客户端 Key">
        <ZSelect v-model="w.keyId" aria-label="客户端 Key" filterable
          :options="w.keys.map((k) => ({ label: k.name || '未命名 Key', value: k.id, description: w.keys.filter((other) => other.name === k.name).length > 1 ? k.id : undefined }))"
          :placeholder="w.keys.length ? '请选择 Key' : '暂无可用 Key'" :disabled="w.busy || !w.keys.length" />
      </ZFormItem>
      <ZFormItem v-if="w.kind === 'candy'" label="每账号次数">
        <ZSelect v-model="w.repeats" aria-label="每账号次数"
          :options="[1, 3, 5].map((value) => ({ label: value + ' 次', value }))" :disabled="w.busy" />
      </ZFormItem>
      <ZFormItem v-if="w.kind === 'pelican'" label="绘图题目">
        <ZSelect v-model="w.outputVersion" aria-label="绘图题目"
          :options="drawingOptions"
          :disabled="w.busy" />
      </ZFormItem>
    </div>
    <div class="batch-toolbar">
      <div class="plan-summary"><span>{{ w.selected.length }} 个账号</span><span class="muted">{{ w.planned }} 次计划请求</span></div>
      <div class="concurrency-field">
        <span id="concurrency-label" class="muted">并行账号</span>
        <ZSelect v-model="w.concurrency" aria-label="并行账号数" size="small"
          :options="[1, 2, 3, 4].map((value) => ({ label: value + ' 个', value }))"
          :disabled="w.busy || w.globalRunning" />
      </div>
      <ZPopover trigger="click">
        <template #reference><ZButton size="small" variant="text">额度说明</ZButton></template>
        <section class="help-popover" aria-label="额度说明内容">
          <h2>额度说明</h2>
          <p>检测消耗所选账号额度，同一账号逐题执行</p>
          <p>计划请求数不包含宿主可能发生的上游重试</p>
          <p>并行数是插件上限，实际执行还受账号与 Key 限制</p>
          <p>排队和执行中的检测占用任务名额；指纹每账号占 1 个，糖果按次数计入</p>
          <p>等待处理的记录不占名额，手动补测时重新核对队列容量</p>
        </section>
      </ZPopover>
      <ZButton class="start-button" type="primary" :disabled="!w.ready" :loading="w.busy" @click="w.start">
        {{ w.currentBatch ? '新建检测' : '开始检测' }} · {{ w.selected.length }} 个账号
      </ZButton>
    </div>
    <p class="queue-capacity" :class="{ 'queue-exceeded': w.queueExceeded }" aria-label="队列余量" role="status">
      <template v-if="w.queueCapacity">{{ w.syncError ? '上次读取：' : '' }}剩余 {{ w.queueCapacity.available }} / {{ w.queueCapacity.limit }} 个任务名额 · 本次需要 {{ w.requiredTasks }} 个</template>
      <template v-else>尚未取得队列余量</template>
    </p>
    <p v-if="w.queueCapacity?.paused" class="queue-capacity" aria-label="未完成检测" role="status">另有 {{ w.queueCapacity.paused }} 个未完成检测，记录已保留，不占队列名额</p>
    <div class="readiness-row">
      <span v-if="w.readinessReason" class="muted" role="status">{{ w.readinessReason }}</span>
      <span v-else class="muted">上方条件用于下一次检测</span>
      <ZButton class="mobile-target-toggle" size="small" variant="text"
        :aria-expanded="w.mobileAccounts" aria-controls="account-picker"
        @click="w.mobileAccounts = !w.mobileAccounts">{{ w.mobileAccounts ? '完成选择' : '选择账号' }}</ZButton>
    </div>
    <div v-if="w.pending" class="feedback warning">
      <span>上次提交尚未确认，核对时复用原批次编号</span>
      <ZButton size="small" :disabled="w.busy" @click="w.sendPending">核对提交状态</ZButton>
    </div>
  </ZCard>
</template>
