/**
 * PDF 抽取器的「插座」（主包侧，只有几十行）。
 *
 * pdf.js 压缩后约 1.7MB，为了不把微信 2MB 的主包上限顶爆，真正跑 pdf.js 的
 * 实现放在资料库分包里（src/packageDocuments/pdf/extractor.ts）。
 * 主包这边只留一个转发器：core 初始化时就拿到它，用户真的点「导入 PDF」时，
 * 资料库页（分包）早已把实现注册进来。
 */

import type { FileExtractor } from '../vendor/core'

let impl: FileExtractor | null = null

/** 由资料库分包在页面加载时调用，注册真正能跑 pdf.js 的实现。 */
export function registerPdfExtractor(next: FileExtractor): void {
  impl = next
}

export const pdfExtractor: FileExtractor = {
  async extract(fileName: string, data: Uint8Array): Promise<string> {
    if (!impl) {
      // 正常路径走不到：PDF 导入入口就在资料库页里，进页面即注册
      throw new Error('PDF 解析器还没加载，请从「我的 → 资料库」进入后再导入 PDF')
    }
    return impl.extract(fileName, data)
  },
}
