// 运行 Web 端 e2e：指向工作区内的浏览器二进制，避免沙箱默认路径受限。
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(repoRoot, 'node_modules', 'ms-playwright')

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