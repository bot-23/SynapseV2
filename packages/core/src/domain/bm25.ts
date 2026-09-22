/**
 * BM25 本地检索（纯函数，零依赖，完全离线）。
 *
 * 中文不引分词库：用「相邻双字（bigram）」建索引 —— 这是中文无词典检索的标准做法，
 * 对学科名词、知识点这类查询足够用，实现与索引体积都极小。
 * 刻意不用向量检索：端侧跑 embedding 模型在小程序里不现实（模型体积远超包上限），
 * 而词法检索在这里可解释、可测试、可离线。
 */

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
  /** 命中的查询词，便于解释「为什么命中」与调试排序 */
  matched: string[];
}

export interface Bm25Index {
  total: number;
  avgdl: number;
  /** term -> docId -> 词频 */
  postings: Map<string, Map<string, number>>;
  /** docId -> 文档长度（token 数） */
  lengths: Map<string, number>;
}

const K1 = 1.5;
const B = 0.75;

const CJK_START = 0x4e00;
const CJK_END = 0x9fff;
const TOKEN_PATTERN = /[a-z0-9]+|[\u4e00-\u9fff]+/g;

/**
 * 分词：英文/数字取连续串（长度 ≥ 2），中文取相邻双字；
 * 中文串长度为 1 时退化为单字，保证单字查询也能命中。
 */
export function tokenize(text: string): string[] {
  const lower = (text || "").toLowerCase();
  const tokens: string[] = [];
  // 模块级带 g 的正则有 lastIndex 状态，每次进来先归零，避免跨调用串味
  TOKEN_PATTERN.lastIndex = 0;
  let matched: RegExpExecArray | null = TOKEN_PATTERN.exec(lower);
  while (matched !== null) {
    const chunk = matched[0]!;
    const head = chunk.charCodeAt(0);
    const isCjk = head >= CJK_START && head <= CJK_END;
    if (!isCjk) {
      if (chunk.length >= 2) {
        tokens.push(chunk);
      }
    } else if (chunk.length === 1) {
      tokens.push(chunk);
    } else {
      for (let index = 0; index + 1 < chunk.length; index += 1) {
        tokens.push(chunk.slice(index, index + 2));
      }
    }
    matched = TOKEN_PATTERN.exec(lower);
  }
  return tokens;
}

export function build_index(documents: Bm25Document[]): Bm25Index {
  const postings = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  let totalLength = 0;

  for (const doc of documents) {
    const tokens = tokenize(doc.text);
    lengths.set(doc.id, tokens.length);
    totalLength += tokens.length;
    for (const token of tokens) {
      let bucket = postings.get(token);
      if (!bucket) {
        bucket = new Map<string, number>();
        postings.set(token, bucket);
      }
      bucket.set(doc.id, (bucket.get(doc.id) ?? 0) + 1);
    }
  }

  const total = documents.length;
  return {
    total,
    avgdl: total ? totalLength / total : 0,
    postings,
    lengths,
  };
}

/** BM25 打分排序；同分时按 id 字典序，保证结果可复现。 */
export function search_index(index: Bm25Index, query: string, limit = 5): Bm25Hit[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !index.total) {
    return [];
  }

  const scores = new Map<string, number>();
  const matchedByDoc = new Map<string, string[]>();

  for (const term of queryTerms) {
    const bucket = index.postings.get(term);
    if (!bucket || !bucket.size) {
      continue;
    }
    const documentFrequency = bucket.size;
    const idf = Math.log(1 + (index.total - documentFrequency + 0.5) / (documentFrequency + 0.5));
    for (const [docId, termFrequency] of bucket) {
      const docLength = index.lengths.get(docId) ?? 0;
      const denominator =
        termFrequency + K1 * (1 - B + (B * docLength) / Math.max(1, index.avgdl));
      const score = (idf * (termFrequency * (K1 + 1))) / Math.max(1e-9, denominator);
      scores.set(docId, (scores.get(docId) ?? 0) + score);
      const matched = matchedByDoc.get(docId) ?? [];
      if (!matched.includes(term)) {
        matched.push(term);
      }
      matchedByDoc.set(docId, matched);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, matched: matchedByDoc.get(id) ?? [] }))
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, Math.max(1, limit));
}
