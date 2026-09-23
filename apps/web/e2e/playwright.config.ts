import { defineConfig, devices } from '@playwright/test'

/**
 * Web 端端到端测试。
 *
 * 前置：已运行 `npm run dev --workspace @synapse/web`（vite，默认 http://localhost:5180）。
 * 运行：`npx playwright test --config e2e/playwright.config.ts`
 *
 * 浏览器二进制安装在工作区 `node_modules/ms-playwright`，
 * 通过 `PLAYWRIGHT_BROWSERS_PATH` 传给启动进程即可（见 npm script `e2e`）。
 */
export default defineConfig({
  testDir: './specs',
  outputDir: './results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${process.env.WEB_PORT || '5180'}`,
    trace: 'retain-on-failure',
    // 每个测试用全新浏览器上下文 = 干净 localStorage，保证互不污染
    contextOptions: {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})