<script setup lang="ts">
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import type { RecordEntry } from '../api'
const props = defineProps<{ record: RecordEntry }>()
const sampleLabels: Record<string, string> = { completed: '完整完成', cancelled: '已取消', timeout: '超时', execution_failed: '宿主执行失败', incomplete: '响应不完整或超出上限', invalid_request: '请求无效' }
const preview = computed(() => {
  if (props.record.kind !== 'pelican' || props.record.status !== 'completed') return ''
  const text = props.record.samples[0]?.answer?.text ?? ''
  const code = text.match(/```(?:html|svg)?\s*\n([\s\S]*?)```/i)?.[1] ?? text
  const safe = DOMPurify.sanitize(code, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'base', 'meta', 'form', 'a', 'foreignObject', 'image'], FORBID_ATTR: ['href', 'xlink:href', 'src', 'action', 'formaction'] })
  const document = new DOMParser().parseFromString(safe, 'text/html')
  const svg = document.querySelector('svg')
  if (!svg) return ''
  // SVG 只作为图片解码，不能成为管理页中的可执行 DOM；宿主 CSP 禁止子 iframe。
  const css = [...document.querySelectorAll('style')].filter(style => !svg.contains(style)).map(style => style.textContent ?? '').join('\n')
  if (css) { const style = document.createElementNS('http://www.w3.org/2000/svg', 'style'); style.textContent = css; svg.prepend(style) }
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
})
</script>
<template>
  <div class="details">
    <p v-if="record.kind === 'fingerprint'" class="muted">指纹为参考库内候选排名，概率不代表模型身份证明</p>
    <table v-if="record.attribution?.results.length" class="results-table">
      <thead><tr><th>候选模型</th><th>排名分数</th><th>库内概率</th></tr></thead>
      <tbody><tr v-for="item in record.attribution.results.slice(0, 5)" :key="item.display_name"><td>{{ item.display_name }}</td><td>{{ item.score.toFixed(3) }}</td><td>{{ item.probability == null ? '—' : `${(item.probability * 100).toFixed(1)}%` }}</td></tr></tbody>
    </table>
    <img v-if="preview" :src="preview" referrerpolicy="no-referrer" alt="鹈鹕绘图预览" class="drawing">
    <p v-else-if="record.kind === 'pelican'" class="muted">未取得可预览的 SVG，请展开查看原始回答</p>
    <details v-for="(sample, i) in record.samples" :key="i" class="sample">
      <summary>回答 {{ i + 1 }} · {{ sampleLabels[sample.status] ?? sample.status }} · {{ (sample.durationMs / 1000).toFixed(1) }} 秒</summary>
      <p v-if="record.attribution?.diagnostics?.[i]" class="muted">解析到 {{ record.attribution.diagnostics[i].parsed_numbers }} 个有效数字 / 预期 {{ sample.expectedCount }} 个 · {{ record.attribution.diagnostics[i].accepted ? '样本可用' : '样本不足' }}</p>
      <pre>{{ sample.answer?.text ?? '未取得完整回答' }}</pre>
      <p class="muted">请求 ID：{{ sample.requestId ?? '未知' }}</p>
      <details><summary>测试题目</summary><pre v-if="sample.instructions">{{ sample.instructions }}</pre><pre>{{ sample.prompt }}</pre></details>
    </details>
  </div>
</template>
