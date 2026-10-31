import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue(), {
    name: 'cpr-classic-script',
    transformIndexHtml: { order: 'post', handler: html => html.replace('type="module" crossorigin', 'defer') },
  }],
  build: {
    modulePreload: false, cssCodeSplit: false,
    rolldownOptions: { output: { format: 'iife', codeSplitting: false, entryFileNames: 'app.js', assetFileNames: 'app.[ext]' } },
  },
})
