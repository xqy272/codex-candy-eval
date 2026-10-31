<script setup lang="ts">
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import { ref } from 'vue'
import type { RecordEntry } from '../api'
const props = defineProps<{ record: RecordEntry }>()
const enlarged = ref(false)
const comparison = computed(() => {
  const aliases: Record<string,string> = { 'gpt-6.1-sol':'gpt-6-astra', 'deepseek-flash':'deepseek-v4.1-flash-1017' }
  const normalize = (name:string) => { const id=name.toLowerCase().split('/').pop() ?? name; return aliases[id] ?? id }
  const a=props.record.attribution
  if (!a?.prediction || a.decision === 'not_model' || a.decision === 'unscorable') return ''
  return normalize(props.record.model) === normalize(a.prediction) ? '首位候选与所选模型的参考库映射一致' : '首位候选与所选模型的参考库映射不同'
})
const totalUsage = computed(() => props.record.samples.reduce((sum, sample) => { for (const [key,value] of Object.entries(sample.answer?.usage ?? {})) if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value; return sum }, {} as Record<string, number>))
const sampleLabels: Record<string, string> = { completed: '完整完成', cancelled: '已取消', timeout: '超时', execution_failed: '宿主执行失败', incomplete: '响应不完整或超出上限', invalid_request: '请求无效', answer_too_large: '回答超过 48 KiB 上限', empty_answer: '没有可用文本', invalid_events: '宿主事件格式无效', permission_denied: 'Key 权限或账号资格拒绝', capacity: '宿主容量限制' }
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
    <p v-if="Object.keys(totalUsage).length" class="muted">Token 用量：<span v-for="(value,key) in totalUsage" :key="key">{{ key }} {{ value }} · </span></p>
    <p v-if="record.attribution" class="muted">模型家族：{{ record.attribution.family_prediction_name || '未知' }} · 有效样本 {{ record.attribution.used_outputs ?? '未知' }} / 3 · {{ record.attribution.decision === 'not_model' ? '数字序列不像参考库中的语言模型回答，不生成身份结论' : record.attribution.decision === 'unscorable' ? '有效样本不足，无法评分' : '参考库候选归因' }}</p>
    <p v-if="record.kind === 'fingerprint'" class="muted">指纹为参考库内候选排名，概率不代表模型身份证明</p>
    <p v-if="comparison" class="muted">{{ comparison }}</p>
    <table v-if="record.attribution?.results.length" class="results-table">
      <thead><tr><th>候选模型</th><th>排名分数</th><th>库内概率</th></tr></thead>
      <tbody><tr v-for="item in record.attribution.results.slice(0, 5)" :key="item.display_name"><td>{{ item.display_name }}</td><td>{{ item.score.toFixed(3) }}</td><td>{{ item.probability == null ? '—' : `${(item.probability * 100).toFixed(1)}%` }}</td></tr></tbody>
    </table>
    <button v-if="preview" type="button" @click="enlarged = !enlarged">{{ enlarged ? '收起大图' : '放大查看' }}</button>
    <img v-if="preview" :style="enlarged ? 'height:auto;min-height:420px;max-height:none;width:100%' : ''" :src="preview" referrerpolicy="no-referrer" alt="鹈鹕绘图预览" class="drawing">
    <p v-if="preview" class="muted">预览已清洗并以 SVG 图片隔离；原始回答保留在下方，可选中复制</p>
    <p v-if="!preview && record.kind === 'pelican'" class="muted">未取得可预览的 SVG，请展开查看原始回答</p>
    <details v-for="(sample, i) in record.samples" :key="i" class="sample">
      <summary>回答 {{ i + 1 }} · {{ sampleLabels[sample.status] ?? sample.status }} · {{ (sample.durationMs / 1000).toFixed(1) }} 秒</summary>
      <p v-if="record.attribution?.diagnostics?.[i]" class="muted">解析到 {{ record.attribution.diagnostics[i].parsed_numbers }} 个有效数字 / 预期 {{ sample.expectedCount }} 个 · {{ record.attribution.diagnostics[i].accepted ? '样本可用' : '样本不足' }}</p>
      <pre>{{ sample.answer?.text ?? '未取得完整回答' }}</pre>
      <p class="muted">请求 ID：{{ sample.requestId ?? '未知' }}</p>
      <details><summary>测试题目</summary><pre v-if="sample.instructions">{{ sample.instructions }}</pre><pre>{{ sample.prompt }}</pre></details>
    </details>
  </div>
</template>
