/**
 * 把 pdf.js 的 CMap 目录复制到 Web 静态目录，供中文 CID 字体 PDF 抽取文字用。
 *
 * 为什么不入库：cmaps 约 1.5MB 的二进制表，属于「npm install 可再生」的依赖产物，
 * 与仓库瘦身原则一致。复制目标目录已在 .gitignore。
 *
 * 为什么不用 CDN：本项目的卖点之一是断网可用，核心依赖不能挂到外网。
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(HERE, '..')
const source = path.resolve(webRoot, '../../node_modules/pdfjs-dist/cmaps')
const target = path.join(webRoot, 'public/pdfjs/cmaps')

if (!existsSync(source)) {
  console.warn('[pdfjs] 找不到 node_modules/pdfjs-dist/cmaps，跳过（PDF 中文抽取可能不完整）')
  process.exit(0)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`[pdfjs] cmaps 已就绪：${path.relative(webRoot, target)}`)
