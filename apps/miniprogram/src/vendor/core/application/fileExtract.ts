/**
 * 附件文本提取（拆分自 Synapse/backend/app/services/file_extract.py）。
 * txt 解码在 core 内完成；PDF 经 ports/FileExtractor 由壳注入（pdf.js）。
 */

import type { FileExtractor, IdGen } from "../ports/index";
import { systemIdGen } from "../ports/index";
import type { FrontendAttachment } from "../protocol/frontend";

export interface IncomingFile {
  name: string | null;
  contentType?: string | null;
  data: Uint8Array;
}

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
      if (suffix === "txt") {
        extractedText = decodeText(raw);
        extractionStatus = "done";
      } else if (suffix === "pdf") {
        if (!pdfExtractor) {
          throw new Error("未注入 PDF 提取器（ports/FileExtractor）。");
        }
        extractedText = await pdfExtractor.extract(fileName, raw);
        extractionStatus = "done";
      } else {
        extractionError = "当前仅支持提取 txt/pdf 文本。";
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
      extracted_text: cleanedText.slice(0, 6000),
      text_excerpt: excerpt,
      extraction_status: extractionStatus,
      extraction_error: extractionError,
    });
  }

  return extractedFiles;
}
