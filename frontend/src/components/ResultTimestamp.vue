<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ value?: number }>()
const date = computed(() => {
  if (!props.value || !Number.isFinite(props.value)) return
  const value = new Date(props.value)
  if (Number.isFinite(value.getTime())) return value
})
</script>
<template>
  <time v-if="date" class="result-timestamp" :datetime="date.toISOString()">{{ date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) }}</time>
  <span v-else>未记录</span>
</template>
