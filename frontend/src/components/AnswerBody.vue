<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue'
import { ZButton, ZMarkdown, ZSegmented } from '@codex-proxy/ui'
import renderMathInElement from 'katex/contrib/auto-render'

const props = defineProps<{ source: string; label: string; code?: boolean }>()
const emit = defineEmits<{ copy: [text: string] }>()
const view = ref(props.code ? 'source' : 'rendered'), markdown = ref<ComponentPublicInstance | null>(null)
// Preserve code and the original response. Only the reading view repairs a common
// model-produced closing-bold space and protects math from Markdown punctuation.
const readable = computed(() => props.source.split(/(`{3,}[^\n]*\n[\s\S]*?(?:\n`{3,}(?=\n|$)|$)|~{3,}[^\n]*\n[\s\S]*?(?:\n~{3,}(?=\n|$)|$)|`+[^`\n]*`+)/g)
  .map((part, i) => i % 2 ? part : part
    .replace(/\*\*([^*\n]*?\S)[ \t]+\*\*/g, '**$1**')
    .replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g,
      (math) => Array.from(math, (character) => '&#' + character.codePointAt(0) + ';').join('')))
  .join(''))
watch([readable, view, markdown], async () => {
  await nextTick()
  const body = markdown.value?.$el?.shadowRoot?.querySelector('.markdown-body')
  if (body) renderMathInElement(body, {
    output: 'mathml', trust: false, throwOnError: false,
    maxExpand: 200, maxSize: 10, strict: 'ignore',
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true },
    ],
  })
}, { flush: 'post' })
</script>
<template>
  <div class="answer-body">
    <div class="answer-toolbar">
      <ZSegmented v-if="!code" v-model="view" :aria-label="label + '显示方式'" size="small"
        :options="[{ label: '阅读', value: 'rendered' }, { label: '原文', value: 'source' }]" />
      <span v-else class="muted">原始代码</span>
      <ZButton size="small" variant="text" :aria-label="'复制' + label" @click="emit('copy', source)">复制回答</ZButton>
    </div>
    <ZMarkdown v-if="view === 'rendered' && source" ref="markdown" :source="readable" class="answer-markdown" />
    <pre v-else-if="source" class="answer-source">{{ source }}</pre>
    <p v-else class="muted">未取得正文</p>
  </div>
</template>
