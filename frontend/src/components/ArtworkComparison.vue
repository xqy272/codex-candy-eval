<script setup lang="ts">
import { computed } from 'vue'
import { ZButton, ZCard, ZDialog, ZTag } from '@codex-proxy/ui'
import type { Workspace } from '../workspace'
import { artwork } from '../media'
import { profiles } from '../presentation'
const props = defineProps<{ w: Workspace }>()
const replacing = computed({ get: () => !!props.w.comparisonCandidate, set: (open) => { if (!open) props.w.comparisonCandidate = null } })
const differing = computed(() => props.w.comparison.length === 2 && ['model', 'effort', 'requestProfile', 'outputVersion'].some((key) => {
  const field = key as 'model' | 'effort' | 'requestProfile' | 'outputVersion'
  return props.w.comparison[0]![field] !== props.w.comparison[1]![field]
}))
</script>
<template>
  <section v-if="w.comparison.length" class="comparison" aria-label="已有作品对比">
    <div class="aside-heading"><h2>已有作品对比</h2><ZButton size="small" variant="text" @click="w.comparison = []">关闭对比</ZButton></div>
    <p v-if="w.comparison.length === 1" class="muted">再打开一份已有作品加入 B，无需重新生成</p>
    <p v-if="differing" class="feedback warning">两份作品的检测条件不同</p>
    <div class="comparison-grid">
      <ZCard v-for="(r, i) in w.comparison" :key="r.id" padding="compact">
        <div class="aside-heading"><ZTag type="primary">对比 {{ i === 0 ? 'A' : 'B' }}</ZTag><ZButton size="small" variant="text" :aria-label="'移除对比 ' + (i === 0 ? 'A' : 'B')" @click="w.comparison.splice(i, 1)">移除</ZButton></div>
        <img :src="artwork(r).url" alt="对比中的鹈鹕作品" />
        <p><strong>{{ w.recordLabel(r) }}</strong></p><p class="muted">{{ r.model }} · {{ r.effort || '默认强度' }} · {{ profiles[r.requestProfile ?? 'simple-v1'] }} · {{ r.outputVersion ?? '旧版题目' }}</p><p class="muted">{{ new Date(r.startedAt).toLocaleString() }}</p>
      </ZCard>
    </div>
  </section>
  <ZDialog v-model="replacing" title="替换哪一份作品" description="对比最多保留两份，选择替换位置" width="32rem">
    <p v-if="w.comparisonCandidate">加入 {{ w.recordLabel(w.comparisonCandidate) }} · {{ w.comparisonCandidate.model }}</p>
    <template #footer>
      <ZButton @click="replacing = false">取消</ZButton>
      <ZButton @click="w.replaceComparison(0)">替换 A</ZButton>
      <ZButton @click="w.replaceComparison(1)">替换 B</ZButton>
    </template>
  </ZDialog>
</template>
