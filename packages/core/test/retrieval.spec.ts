/**
 * 混合检索回归测试：BM25 + 科目加成 + 单资料去重 + LLM 重排解析。
 */

import { describe, expect, it } from "vitest";

import type { DocumentRecord } from "../src/domain/documentRetrieval.js";
import {
  format_document_hits,
  parse_rerank_json,
  search_documents_ranked,
} from "../src/domain/hybridRetrieval.js";

function record(args: {
  doc_id: string;
  file_name: string;
  subject?: string;
  chunks: string[];
}): DocumentRecord {
  return {
    doc_id: args.doc_id,
    user_id: "default",
    file_name: args.file_name,
    excerpt: "",
    subject: args.subject ?? "",
    chunks: args.chunks.map((text, index) => ({
      chunk_id: String(index + 1),
      text,
      keywords: [],
    })),
  } as unknown as DocumentRecord;
}

describe("混合检索：科目加成", () => {
  it("正文相同的两份资料，科目命中查询的排在前面", () => {
    const hits = search_documents_ranked(
      [
        record({ doc_id: "a", file_name: "A.txt", subject: "英语", chunks: ["导数与单调性"] }),
        record({ doc_id: "b", file_name: "B.txt", subject: "数学", chunks: ["导数与单调性"] }),
      ],
      "数学 导数",
      { perDocument: 1 },
    );
    expect(hits.map((hit) => hit.doc_id)).toEqual(["b", "a"]);
  });
});

describe("混合检索：单资料去重", () => {
  it("同一份资料的多个片段只保留前 N 个，让结果覆盖更多资料", () => {
    const records = [
      record({
        doc_id: "a",
        file_name: "A.txt",
        chunks: ["导数一", "导数二", "导数三"],
      }),
      record({ doc_id: "b", file_name: "B.txt", chunks: ["导数四"] }),
    ];

    const single = search_documents_ranked(records, "导数", { limit: 5, perDocument: 1 });
    expect(single.map((hit) => hit.doc_id)).toEqual(["a", "b"]);

    const doubled = search_documents_ranked(records, "导数", { limit: 5, perDocument: 2 });
    expect(doubled.filter((hit) => hit.doc_id === "a").length).toBe(2);
  });

  it("无资料 / 空查询返回空数组，格式化保持旧输出格式", () => {
    expect(search_documents_ranked([], "导数")).toEqual([]);
    expect(search_documents_ranked([record({ doc_id: "a", file_name: "A", chunks: ["导数"] })], ""))
      .toEqual([]);

    const hits = search_documents_ranked(
      [record({ doc_id: "a", file_name: "高数笔记", chunks: ["夹逼定理与无穷小"] })],
      "夹逼定理",
    );
    expect(format_document_hits(hits)[0]).toContain("资料命中[高数笔记]:");
  });
});

describe("混合检索：LLM 重排解析", () => {
  it("接受 order / indexes，丢弃越界与重复下标", () => {
    expect(parse_rerank_json({ order: [2, 0, 1] }, 3)).toEqual([2, 0, 1]);
    expect(parse_rerank_json({ indexes: [1, 1, 9, -1] }, 3)).toEqual([1]);
    expect(parse_rerank_json({ order: "不是数组" }, 3)).toEqual([]);
    expect(parse_rerank_json(null, 3)).toEqual([]);
  });
});
