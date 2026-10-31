import { createApp } from 'vue'
import { applyResolvedTheme, resolveTheme, DEFAULT_THEME_COLOR, DEFAULT_CUSTOM_THEME_COLOR } from '@codex-proxy/ui/theme'
import App from './App.vue'
import '@codex-proxy/ui/styles.css'
import './style.css'

function theme() {
  // 宿主桥接已经注入完整主题变量，仅独立预览需要默认主题。
  if (window.codexProxyPlugin) return
  const mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyResolvedTheme(document.documentElement, resolveTheme(mode, DEFAULT_THEME_COLOR, DEFAULT_CUSTOM_THEME_COLOR))
}
theme()
window.addEventListener('codex-proxy-themechange', theme)
createApp(App).mount('#app')
