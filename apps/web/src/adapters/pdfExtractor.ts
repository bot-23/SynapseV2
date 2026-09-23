/**
 * PDF 文本提取（Web 壳注入 pdf.js 实现 ports/FileExtractor）。
 *
 * 设计要点：
 * - 动态 import：pdf.js 体积大，只在真的选了 PDF 时才加载，主包不受影响。
 * - 逐页取 textContent，遇到扫描件（图片版）没有文字时给出明确错误，而不是静默返回空串。
 * - CMap 走本地静态目录 `public/pdfjs/cmaps`（由 scripts/copy-pdfjs-cmaps.mjs 生成，不入库），
 *   中文 CID 字体 PDF 才不会抽出乱码，同时保持完全离线可用。
 */

import type { FileExtractor } from '@synapse/core'

/** 与 core 的 MAX_EXTRACTED_CHARS 对齐：够了就停止翻页，避免几百页 PDF 把界面卡住。 */
const MAX_CHARS = 200_000

/** pdf.js 的 CMap 目录（相对站点根路径；构建时随 public 一起产出）。 */
const CMAP_URL = '/pdfjs/cmaps/'

type PdfModule = typeof import('pdfjs-dist')

let pdfModule: PdfModule | null = null

async function loadPdfjs(): Promise<PdfModule> {
  if (pdfModule) {
    return pdfModule
  }
  const [module, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  module.GlobalWorkerOptions.workerSrc = worker.default
  pdfModule = module
  return module
}

/**
 * 拼一页的文字。
 * pdf.js 把同一行切成多个 item，中文之间不能插空格（会打断 BM25 的双字索引），
 * 英文之间则需要空格，所以按「相邻字符是否 CJK」决定这不补空格。
 */
function joinPageItems(items: Array<{ str?: string; hasEOL?: boolean }>): string {
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

export const pdfExtractor: FileExtractor = {
  async extract(fileName: string, data: Uint8Array): Promise<string> {
    const pdfjs = await loadPdfjs()
    // pdf.js 会接管传入的 ArrayBuffer，这里传副本，避免影响调用方后续对原始字节的使用。
    // 资源释放走 loadingTask.destroy()（v6 的 PDFDocumentProxy 已不再暴露 destroy）。
    const task = pdfjs.getDocument({
      data: data.slice(),
      cMapUrl: CMAP_URL,
      cMapPacked: true,
    })

    try {
      const doc = await task.promise
      const pages: string[] = []
      let total = 0
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const page = await doc.getPage(pageNumber)
        const content = await page.getTextContent()
        const pageText = joinPageItems(content.items as Array<{ str?: string; hasEOL?: boolean }>)
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
