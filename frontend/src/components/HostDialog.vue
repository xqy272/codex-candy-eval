<script setup lang="ts">
import { onScopeDispose } from 'vue'
import { ZDialog } from '@codex-proxy/ui'
import { trackDialogViewport } from '../dialogViewport'

defineOptions({ inheritAttrs: false })
defineProps<{ title: string }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ closed: [] }>()
let release: (() => void) | undefined
function onOpen() { release ??= trackDialogViewport() }
function releaseViewport() { release?.(); release = undefined }
onScopeDispose(releaseViewport)
</script>
<template>
  <ZDialog v-model="open" :title="title" v-bind="$attrs" @open="onOpen" @closed="releaseViewport(); emit('closed')">
    <template v-if="$slots.header" #header="header"><slot name="header" v-bind="header" /></template>
    <slot />
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </ZDialog>
</template>
