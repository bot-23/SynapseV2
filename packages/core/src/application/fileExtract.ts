/**
 * 附件文本提取（拆分自 Synapse/backend/app/services/file_extract.py）。
 * txt 解码在 core 内完成；PDF 经 ports/FileExtractor 由壳注入（pdf.js）。
 */

import type { FileExtractor, IdGen } from "../ports/index.js";
import { systemIdGen } from "../ports/index.js";
import type { FrontendAttachment } from "../protocol/frontend.js";

export interface IncomingFile {
  name: string | null;
  contentType?: string | null;
  data: Uint8Array;
}

/**
 * 单份资料最多索引的字符数。
 *
 * 旧实现把提取结果硬截断到 6000 字，导致「选文件导入」会在无提示的情况下丢掉
 * 6000 字之后的全部内容（而粘贴导入不截断，两条路径行为不一致）。
 * 这里统一抬高到 20 万字：远大于常见的笔记/讲义，同时仍给 KV 留出体积上限。
 */
export const MAX_EXTRACTED_CHARS = 200_000;

/** 纯文本类后缀：内容即文本，走 core 内置解码，不需要壳注入解析器。 */
const PLAIN_TEXT_SUFFIXES = new Set(["txt", "text", "md", "markdown", "mdx"]);

function decodeText(raw: Uint8Array): string {
  // Python: utf-8 / utf-8-sig / gbk / gb2312 依次尝试，最终 utf-8 ignore。
  // utf-8-sig 在 utf-8 失败时也必然失败（同编解码、仅多去 BOM），故实际链为 utf-8 → gbk → gb2312。
  for (const encoding of ["utf-8", "gbk", "gb2312"]) {
    try {
      return new TextDecoder(encoding as never, { fatal: true }).decode(raw);
    } catch {
      continue;
    }
  }
  return new TextDecoder("utf-8").decode(raw);
}

function cleanText(text: string): string {
  return (text || "").split(/\s+/).filter(Boolean).join(" ");
}

export async function extract_attachments(
  files: IncomingFile[],
  pdfExtractor: FileExtractor | null,
  idGen: IdGen = systemIdGen,
): Promise<FrontendAttachment[]> {
  const extractedFiles: FrontendAttachment[] = [];

  for (const upload of files) {
    const raw = upload.data;
    const fileName = upload.name ?? "";
    const suffix = fileName.includes(".")
      ? fileName.split(".").pop()!.toLowerCase()
      : "";
    let extractedText = "";
    let extractionStatus = "unsupported";
    let extractionError = "";

    try {
      if (PLAIN_TEXT_SUFFIXES.has(suffix)) {
        extractedText = decodeText(raw);
        extractionStatus = "done";
      } else if (suffix === "pdf") {
        if (!pdfExtractor) {
          throw new Error("未注入 PDF 提取器（ports/FileExtractor）。");
        }
        extractedText = await pdfExtractor.extract(fileName, raw);
        extractionStatus = "done";
      } else {
        extractionError = "当前仅支持提取 txt / md / pdf 文本。";
      }
    } catch (error) {
      extractionStatus = "error";
      extractionError = error instanceof Error ? error.message : String(error);
    }

    const cleanedText = cleanText(extractedText);
    const excerpt = cleanedText.slice(0, 1200);
    extractedFiles.push({
      id: idGen.next(),
      name: upload.name || "未命名资料",
      size: raw.length,
      type: upload.contentType || suffix || "unknown",
      extracted_text: cleanedText.slice(0, MAX_EXTRACTED_CHARS),
      text_excerpt: excerpt,
      extraction_status: extractionStatus,
      extraction_error: extractionError,
    });
  }

  return extractedFiles;
}
