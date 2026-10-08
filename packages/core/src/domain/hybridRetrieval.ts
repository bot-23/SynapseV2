/**
 * 混合检索：在 BM25 之上补两层「确定性也能做对」的改进，并把 LLM 重排收敛成一个可选步骤。
 *
 * 1) 元数据加成：资料带 subject 标签，查询命中该科目时加分 —— 纯 BM25 只看正文，
 *    会把「同科目但用词不同」的片段排到后面。
 * 2) 单份资料去重：BM25 常常让同一份资料的好几个片段占满配额，
 *    限制每份资料保留的片段数，让结果覆盖更多资料。
 *
 * LLM 重排（可选）：先把候选交给模型排序，失败就退回 BM25 顺序 ——
 * 绝不因为一次模型调用失败就检索不到东西。
 */

import type { DocumentRecord } from "./documentRetrieval.js";
import { build_index, search_index, tokenize } from "./bm25.js";

export interface RankedHit {
  doc_id: string;
  file_name: string;
  subject: string;
  text: string;
  score: number;
}

export interface RankedSearchOptions {
  weakPoints?: string[] | null;
  limit?: number;
  /** 每份资料最多保留几个片段（默认 1，保证结果多样性）。 */
  perDocument?: number;
  /** 查询命中资料 subject 时的加分（0 关闭）。 */
  subjectBoost?: number;
}

const DEFAULT_SUBJECT_BOOST = 0.6;

/** 把查询与薄弱点拼成一个检索串（薄弱点是用户明确的关注点，应参与检索）。 */
export function expand_query(query: string, weakPoints?: string[] | null): string {
  return [String(query ?? "").trim(), ...(weakPoints ?? []).map((item) => String(item ?? "").trim())]
    .filter(Boolean)
    .join(" ");
}

/** 检索并按「BM25 + 科目加成」排序，再按资料去重。 */
export function search_documents_ranked(
  records: readonly DocumentRecord[],
  query: string,
  options: RankedSearchOptions = {},
): RankedHit[] {
  const limit = Math.max(1, options.limit ?? 3);
  const perDocument = Math.max(1, options.perDocument ?? 1);
  const subjectBoost = options.subjectBoost ?? DEFAULT_SUBJECT_BOOST;
  const searchText = expand_query(query, options.weakPoints);
  if (!searchText.trim()) {
    return [];
  }

  const chunks: Array<{ id: string; text: string }> = [];
  const meta = new Map<string, RankedHit>();
  for (const record of records) {
    const row = record as unknown as Record<string, unknown>;
    (record.chunks ?? []).forEach((chunk, index) => {
      const text = String(chunk.text ?? "");
      if (!text) {
        return;
      }
      const id = `${record.doc_id ?? "doc"}#${chunk.chunk_id || index}`;
      chunks.push({ id, text });
      meta.set(id, {
        doc_id: String(record.doc_id ?? "doc"),
        file_name: String(record.file_name ?? "未命名资料"),
        subject: String(row["subject"] ?? ""),
        text,
        score: 0,
      });
    });
  }
  if (!chunks.length) {
    return [];
  }

  const queryTerms = new Set(tokenize(searchText));
  const hits = search_index(build_index(chunks), searchText, chunks.length);

  const scored = hits.map((hit) => {
    const info = meta.get(hit.id)!;
    const subjectMatches =
      Boolean(info.subject) && tokenize(info.subject).some((token) => queryTerms.has(token));
    return { ...info, score: hit.score + (subjectMatches ? subjectBoost : 0) };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0;
  });

  const perDocCount = new Map<string, number>();
  const result: RankedHit[] = [];
  for (const hit of scored) {
    const used = perDocCount.get(hit.doc_id) ?? 0;
    if (used >= perDocument) {
      continue;
    }
    perDocCount.set(hit.doc_id, used + 1);
    result.push(hit);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

/** 格式化命中行 —— 与旧的 `资料命中[文件名]: 片段` 完全一致，上层无需改动。 */
export function format_document_hits(hits: readonly RankedHit[]): string[] {
  return hits.map((hit) => `资料命中[${hit.file_name}]: ${hit.text.slice(0, 180)}`);
}

/**
 * 解析 LLM 重排结果：接受 `{ "order": [2,0,1] }` 或 `{ "indexes": [...] }`。
 * 越界、重复、非法的下标一律丢弃，保证结果一定对应真实候选。
 */
export function parse_rerank_json(raw: unknown, count: number): number[] {
  let list: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    list = row["order"] ?? row["indexes"];
  }
  if (!Array.isArray(list)) {
    return [];
  }
  const seen = new Set<number>();
  const order: number[] = [];
  for (const item of list) {
    const index = Math.trunc(Number(item));
    if (!Number.isFinite(index) || index < 0 || index >= count || seen.has(index)) {
      continue;
    }
    seen.add(index);
    order.push(index);
  }
  return order;
}
