/**
 * 把 pdf.js 的 CMap 目录复制到 Web 静态目录，供中文 CID 字体 PDF 抽取文字用。
 *
 * 为什么不入库：cmaps 是「npm install 可再生」的依赖产物，与仓库瘦身原则一致。
 * 复制目标目录已在 .gitignore。
 *
 * 为什么不用 CDN：本项目的卖点之一是断网可用，核心依赖不能挂到外网。
 *
 * 为什么裁剪：pdf.js 自带 169 个 CMap，其中包含大量日文（UniJIS / RKSJ / EUC / Ext）
 * 与韩文（UniKS / KSC）表。本项目面向中文用户，只保留简繁中文相关的表，
 * 部署体积减少约一半；这些表是「打开 CJK PDF 时按需拉取」的，不进首屏。
 * 白名单一旦匹配过少（pdf.js 改了目录结构），自动退回全量复制 —— 宁可大也不能缺。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(HERE, '..')
const source = path.resolve(webRoot, '../../node_modules/pdfjs-dist/cmaps')
const target = path.join(webRoot, 'public/pdfjs/cmaps')

/** 简体 / 繁体中文（含港澳）相关的 CMap。 */
const KEEP_PATTERNS = [
  /^Adobe-GB1-/,
  /^Adobe-CNS1-/,
  /^UniGB-/,
  /^UniCNS-/,
  /^GB/, // GB-EUC / GBK-EUC / GBK2K / GBT-* / GBpc-EUC
  /^B5/, // B5 / B5pc
  /^CNS/, // CNS-EUC / CNS1 / CNS2
  /^ET/, // ETen-B5 / ETenms-B5 / ETHK-B5
  /^HK/, // HKscs / HKdla / HKdlb / HKgccs / HKm314 / HKm471
  /^Roman/, // 拉丁 CID 字体（很小，保留）
]

if (!existsSync(source)) {
  console.warn('[pdfjs] 找不到 node_modules/pdfjs-dist/cmaps，跳过（PDF 中文抽取可能不完整）')
  process.exit(0)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const matched = readdirSync(source).filter((name) =>
  KEEP_PATTERNS.some((pattern) => pattern.test(name)),
)
const withLicense = existsSync(path.join(source, 'LICENSE')) ? ['LICENSE'] : []

if (matched.length < 20) {
  console.warn(`[pdfjs] cmaps 白名单只匹配到 ${matched.length} 个文件，退回全量复制`)
  cpSync(source, target, { recursive: true })
} else {
  for (const name of [...matched, ...withLicense]) {
    cpSync(path.join(source, name), path.join(target, name))
  }
}

console.log(`[pdfjs] cmaps 已就绪：${path.relative(webRoot, target)}（${matched.length} 个文件）`)
