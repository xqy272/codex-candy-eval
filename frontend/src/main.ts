import { createApp } from 'vue'
import { applyTheme, createTheme } from '@codex-proxy/ui/theme'
import App from './App.vue'
import '@codex-proxy/ui/styles.css'
import './layout.css'

function theme() {
  // 宿主桥接已经注入完整主题变量，仅独立预览需要默认主题。
  if (window.codexProxyPlugin) {
    return
  }
  const mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyTheme(document.documentElement, createTheme({ scheme: mode }))
}
theme()
createApp(App).mount('#app')
