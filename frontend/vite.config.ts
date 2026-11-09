import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import CodexProxyUI from '@codex-proxy/ui/vite'

export default defineConfig({
  base: './',
  plugins: [vue(), CodexProxyUI(), {
    name: 'cpr-classic-script',
    transformIndexHtml: { order: 'post', handler: html => html.replace('type="module" crossorigin', 'defer') },
  }],
  build: {
    modulePreload: false, cssCodeSplit: false, assetsInlineLimit: 0,
    rolldownOptions: { output: { format: 'iife', codeSplitting: false, entryFileNames: 'app.js',
      assetFileNames: (asset) => asset.names.some((name) => name.endsWith('.woff2')) ? 'fonts/[name][extname]' : 'app.[ext]' } },
  },
})
