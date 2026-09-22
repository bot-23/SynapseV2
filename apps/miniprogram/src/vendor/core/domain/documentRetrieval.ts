/**
 * 用户资料文本切分与检索（纯函数）。
 * 翻译自 Synapse/backend/app/services/document_retriever.py，语义逐字保留。
 * 检索部分在 v2 升级为 BM25（见 bm25.ts）。
 */

import { build_index, search_index, type Bm25Document } from "./bm25";

export interface DocumentChunk {
  chunk_id: string;
  text: string;
  keywords: string[];
}

export interface DocumentRecord {
  doc_id: string;
  user_id: string;
  file_name: string;
  excerpt: string;
  chunks: DocumentChunk[];
}

export interface AttachmentLike {
  id?: string | null;
  name?: string | null;
  extracted_text?: string | null;
  text_excerpt?: string | null;
}

function cleanText(text: string): string {
  return (text || "").split(/\s+/).filter(Boolean).join(" ");
}

function tokenize(text: string): string[] {
  const normalized = cleanText(text).toLowerCase();
  const asciiTokens = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  const zhTokens = normalized.match(/[一-鿿]{2,6}/g) ?? [];
  return [...asciiTokens, ...zhTokens];
}

function extractKeywords(text: string, limit = 12): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const token of tokenize(text)) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= limit) {
      break;
    }
  }
  return keywords;
}

export function chunk_document_text(text: string, chunkSize = 360, overlap = 60): string[] {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return [];
  }
  if (cleaned.length <= chunkSize) {
    return [cleaned];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(cleaned.length, start + chunkSize);
    chunks.push(cleaned.slice(start, end));
    if (end >= cleaned.length) {
      break;
    }
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export function build_document_records(
  userId: string,
  attachments: AttachmentLike[],
): DocumentRecord[] {
  const records: DocumentRecord[] = [];
  for (const attachment of attachments) {
    const extractedText = attachment.extracted_text || "";
    if (!extractedText) {
      continue;
    }

    const chunks: DocumentChunk[] = [];
    chunk_document_text(extractedText).forEach((chunk, index) => {
      chunks.push({
        chunk_id: `${attachment.id || "doc"}-chunk-${index + 1}`,
        text: chunk,
        keywords: extractKeywords(chunk),
      });
    });

    if (!chunks.length) {
      continue;
    }

    records.push({
      doc_id: attachment.id || attachment.name || "doc",
      user_id: userId,
      file_name: attachment.name || "未命名资料",
      excerpt: attachment.text_excerpt || chunks[0]!.text.slice(0, 240),
      chunks,
    });
  }
  return records;
}

/**
 * 资料检索：BM25（v2 升级，原先只是关键词包含计数）。
 *
 * 输出格式与旧实现保持一致（同样的「资料命中[文件名]: 片段」行），
 * 所以上层 `_build_hybrid_context` 无需改动；没有资料时依旧返回空数组。
 */
export function search_document_records(
  records: DocumentRecord[],
  query: string,
  weakPoints: string[] | null = null,
  limit = 3,
): string[] {
  const searchText = [query, ...(weakPoints ?? [])].join(" ");
  const documents: Bm25Document[] = [];
  const meta = new Map<string, { fileName: string; text: string }>();

  for (const record of records) {
    (record.chunks ?? []).forEach((chunk, index) => {
      const text = String(chunk.text ?? "");
      if (!text) {
        return;
      }
      const id = `${record.doc_id ?? "doc"}#${chunk.chunk_id || index}`;
      documents.push({ id, text });
      meta.set(id, { fileName: String(record.file_name ?? "未命名资料"), text });
    });
  }

  if (!documents.length) {
    return [];
  }

  return search_index(build_index(documents), searchText, limit).map((hit) => {
    const item = meta.get(hit.id)!;
    return `资料命中[${item.fileName}]: ${item.text.slice(0, 180)}`;
  });
}
