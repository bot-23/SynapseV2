/**
 * 资料库分包的 PDF 抽取实现 —— 真正跑 pdf.js 的地方。
 *
 * 为什么放在分包里（src/packageDocuments）：pdf.js 压缩后约 1.7MB，
 * 直接 import 'pdfjs-dist' 会被 Taro 打进主包的 vendors.js，顶爆 2MB 主包上限。
 * 这里 import 的是 scripts/copy-pdfjs-vendor.mjs 复制到分包源码目录的构建产物，
 * webpack 因此把它们算进分包（分包上限同样是 2MB）。
 *
 * 小程序里没有 Worker、没有 DOM，所以走 pdf.js 的「主线程 fake worker」模式：
 * 在构造 PDFWorker 之前把 `globalThis.pdfjsWorker` 指向 worker 导出的
 * WorkerMessageHandler，pdf.js 一旦发现它就直接在主线程里跑，
 * 不会去碰 window / Worker / new URL。
 *
 * 已知边界：
 * - 不带 CMap（小程序里没有可 fetch 的静态目录），中文 PDF 若字体自带 ToUnicode
 *   可以正常抽取；只有依赖预定义 CJK CMap 的老式 PDF 才可能缺字。
 * - 扫描件（图片版）没有文字层，会给出明确错误而不是静默空结果。
 */

import type { FileExtractor } from '../../vendor/core'
import { installPdfCompat } from '../../adapters/pdfCompat'
import * as pdfjsModule from './vendor/pdf.min.mjs'
import * as pdfjsWorker from './vendor/pdf.worker.min.mjs'

/** 与 core 的 MAX_EXTRACTED_CHARS 对齐：够了就停止翻页，避免几百页 PDF 把界面卡住。 */
const MAX_CHARS = 200_000

/** 页数硬上限：恶意构造的「超多页」PDF 即便每页没字也会被逐页解析，必须设顶。 */
const MAX_PAGES = 400

/**
 * 只声明我们真正用到的那几个方法。
 * 不做 `import type { ... } from 'pdfjs-dist'`：那会把主包也拖进 pdfjs 的类型依赖，
 * 而且压缩产物的推断签名不可靠，这里用最小接口 + 断言更稳。
 */
interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>
  cleanup(): void
}

interface PdfDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPage>
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>
  destroy(): Promise<void>
}

interface PdfjsModule {
  getDocument(source: Record<string, unknown>): PdfLoadingTask
}

let ready = false

function ensureRuntime(): PdfjsModule {
  if (!ready) {
    installPdfCompat()
    // 告诉 pdf.js「主线程里就有 worker handler」，它就不会去创建 Web Worker
    ;(globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = {
      WorkerMessageHandler: (pdfjsWorker as unknown as { WorkerMessageHandler: unknown })
        .WorkerMessageHandler,
    }
    ready = true
  }
  return pdfjsModule as unknown as PdfjsModule
}

/**
 * 拼一页的文字。
 * pdf.js 把同一行切成多个 item，中文之间不能插空格（会打断 BM25 的双字索引），
 * 英文之间则需要空格，所以按「相邻字符是否 CJK」决定这不补空格。
 */
function joinPageItems(items: PdfTextItem[]): string {
  let text = ''
  for (const item of items) {
    const piece = item.str ?? ''
    if (!piece) {
      if (item.hasEOL) {
        text += '\n'
      }
      continue
    }
    const prevChar = text.slice(-1)
    const needsSpace =
      text.length > 0 &&
      prevChar !== '\n' &&
      !/[\u4e00-\u9fff\uff00-\uffef]/.test(prevChar) &&
      !/^[\u4e00-\u9fff\uff00-\uffef]/.test(piece)
    text += needsSpace ? ` ${piece}` : piece
    if (item.hasEOL) {
      text += '\n'
    }
  }
  return text
}

export const miniprogramPdfExtractor: FileExtractor = {
  async extract(fileName: string, data: Uint8Array): Promise<string> {
    const pdfjs = ensureRuntime()
    // pdf.js 会接管传入的 ArrayBuffer，这里传副本，避免影响调用方后续对原始字节的使用
    const task = pdfjs.getDocument({
      data: data.slice(),
      // 没有 fetch 环境，明确关掉，避免它去解析 document.baseURI
      useWorkerFetch: false,
    })

    try {
      const doc = await task.promise
      const pages: string[] = []
      let total = 0
      const pageCount = Math.min(doc.numPages, MAX_PAGES)
      if (doc.numPages > pageCount) {
        console.log('[Synapse] PDF 页数超上限，只解析前', pageCount, '页', fileName)
      }
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await doc.getPage(pageNumber)
        const content = await page.getTextContent()
        const pageText = joinPageItems(content.items)
        pages.push(pageText)
        total += pageText.length
        page.cleanup()
        if (total >= MAX_CHARS) {
          console.log('[Synapse] PDF 已达索引上限，停止翻页', fileName, pageNumber, doc.numPages)
          break
        }
      }

      const text = pages.join('\n').trim()
      if (text.length < 10) {
        throw new Error('这份 PDF 没提取到文字，可能是扫描件（图片版），当前不支持 OCR')
      }
      console.log('[Synapse] PDF 提取完成', fileName, doc.numPages, '页', text.length, '字')
      return text
    } finally {
      await task.destroy()
    }
  },
}
