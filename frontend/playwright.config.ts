import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  outputDir: '../.runtime/ui-tests',
  fullyParallel: false,
  use: { channel: 'chrome', baseURL: 'http://127.0.0.1:4173', viewport: { width: 1100, height: 900 } },
  webServer: { command: 'npm exec vite preview -- --host 127.0.0.1 --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
})
