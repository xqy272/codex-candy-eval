<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ZButton, ZSegmented, ZSelect } from '@codex-proxy/ui'
import HostDialog from './HostDialog.vue'
import type { RecordEntry } from '../api'
import { artwork, download } from '../media'
const props = defineProps<{ record: RecordEntry }>()
const emit = defineEmits<{ copy: [text: string]; compare: [record: RecordEntry] }>()
const media = computed(() => artwork(props.record))
const view = ref('preview'), failed = ref(false), zoom = ref(false), scale = ref(1), background = ref('theme')
watch(() => media.value.url, () => { failed.value = false })
</script>
<template>
  <section v-if="media.raw" class="artwork-view" aria-label="绘图作品">
    <div class="art-toolbar">
      <ZSegmented v-model="view" aria-label="作品视图" :options="[{ label: '预览', value: 'preview' }, { label: '代码', value: 'code' }]" />
      <div class="actions">
        <ZButton v-if="media.url && !failed" size="small" @click="zoom = true">放大查看</ZButton>
        <ZButton size="small" @click="emit('copy', media.code)">复制代码</ZButton>
        <ZButton size="small" @click="download(media.code, 'pelican-' + record.id + (media.legacy ? '.html' : '.svg'), media.legacy ? 'text/html' : 'image/svg+xml')">下载{{ media.legacy ? '原文' : ' SVG' }}</ZButton>
      </div>
    </div>
    <pre v-if="view === 'code'">{{ media.code }}</pre>
    <img v-else-if="media.url && !failed" class="drawing" :src="media.url" alt="鹈鹕绘图预览" referrerpolicy="no-referrer" @error="failed = true" />
    <div v-else class="feedback warning">
      <p>已生成，{{ media.legacy ? '旧版 HTML 格式无法完整预览' : '当前 SVG 无法预览' }}</p>
      <p>原始代码可复制或下载，生成结果仍然保留</p>
      <ZButton v-if="failed" size="small" @click="failed = false">重新预览 · 不发请求</ZButton>
    </div>
    <ZButton v-if="media.url" size="small" variant="text" @click="emit('compare', record)">加入作品对比</ZButton>
    <HostDialog v-model="zoom" title="作品预览" width="64rem" :draggable="false">
      <div class="zoom-controls">
        <ZSelect v-model="scale" aria-label="预览缩放" :options="[0.75, 1, 1.5, 2].map((value) => ({ label: (value * 100) + '%', value }))" />
        <ZSelect v-model="background" aria-label="预览背景" :options="[{ label: '跟随主题', value: 'theme' }, { label: '棋盘格', value: 'checker' }]" />
      </div>
      <div class="zoom-canvas" :class="{ checker: background === 'checker' }">
        <img :src="media.url" alt="放大中的鹈鹕作品" :style="{ width: (scale * 100) + '%', maxWidth: 'none' }" />
      </div>
    </HostDialog>
  </section>
</template>
