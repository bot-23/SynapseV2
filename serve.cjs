/**
 * 演示版零依赖静态服务器。
 *
 * 演示包里带上了构建好的 apps/web/dist，所以队友不需要 npm install，
 * 只要机器上有 Node 就能跑。只用 Node 内置模块，不碰 node_modules。
 *
 * 用法：node serve.cjs   （端口默认 5180，可用 PORT 环境变量覆盖）
 *
 * 日志保持纯 ASCII：Windows 控制台默认代码页是 GBK，中文会显示成乱码。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, 'apps', 'web', 'dist')
const port = Number(process.env.PORT || 5180)
const indexPath = path.join(root, 'index.html')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm',
}

if (!fs.existsSync(indexPath)) {
  console.error('[Synapse] build output not found: ' + root)
  console.error('          run: npm run build --workspace @synapse/web')
  process.exit(1)
}

const server = http.createServer((request, response) => {
  const requestPath = decodeURIComponent((request.url || '/').split('?')[0])
  let filePath = path.join(root, requestPath)

  // 目录穿越保护：拼出来的路径必须仍在 dist 之内
  if (!filePath.startsWith(root)) {
    response.writeHead(403)
    response.end('forbidden')
    return
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html')
  }
  if (!fs.existsSync(filePath)) {
    // 前端路由回退：只有不带扩展名的路径才回退到 index.html，
    // 缺资源文件就如实报 404，免得浏览器拿到一份伪装成 JS 的 HTML
    if (path.extname(filePath)) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    filePath = indexPath
  }

  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(filePath).pipe(response)
})

server.listen(port, () => {
  console.log('[Synapse] demo server ready: http://localhost:' + port)
  console.log('          closing this window stops the server.')
})
