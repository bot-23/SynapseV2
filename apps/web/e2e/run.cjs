// 优先使用工作区浏览器；未安装时由 Playwright 使用系统默认位置。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const localBrowsers = path.join(repoRoot, 'node_modules', 'ms-playwright')
const shellDir = process.platform === 'win32'
  ? 'chrome-headless-shell-win64'
  : process.platform === 'darwin'
    ? 'chrome-headless-shell-mac'
    : 'chrome-headless-shell-linux'
const shellName = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'
const hasLocalChromium = fs.existsSync(localBrowsers) && fs.readdirSync(localBrowsers).some(
  (name) => name.startsWith('chromium_headless_shell-')
    && fs.existsSync(path.join(localBrowsers, name, shellDir, shellName)),
)
if (hasLocalChromium) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers
}

const result = spawnSync(
  'npx',
  ['playwright', 'test', '--config', 'e2e/playwright.config.ts'],
  {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
    shell: true,
  },
)
process.exit(result.status ?? 1)
