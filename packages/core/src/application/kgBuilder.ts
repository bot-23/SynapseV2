import { tokenize } from "../domain/bm25.js";
import type { LlmProvider } from "../providers/contracts.js";
import type { RuntimeStore } from "../storage/runtimeStore.js";
import type { KnowledgeEdge, KnowledgeNode } from "../storage/kgSeed.js";

const ALLOWED_RELATIONS = new Set([
  "contains",
  "prerequisite_of",
  "recommends",
  "practice_for",
]);

interface ExtractedNode {
  name: string;
  category: string;
  subject: string;
  aliases: string;
  description: string;
}

interface ExtractedEdge {
  source_name: string;
  target_name: string;
  relation: string;
}

export interface KgBuildResult {
  doc_id: string;
  file_name: string;
  node_count: number;
  edge_count: number;
  added_nodes: number;
  added_edges: number;
  topic_nodes: KnowledgeNode[];
  used_fallback: boolean;
  added_reviews?: number;
}

export class KgBuilder {
  constructor(
    private readonly store: RuntimeStore,
    private readonly llm: LlmProvider,
  ) {}

  async buildKgFromDocument(docId: string, userId = "default"): Promise<KgBuildResult> {
    const sourceRecord = this.store
      .get_documents(userId)
      .find((item) => String(item["doc_id"] ?? "") === docId);
    if (!sourceRecord) {
      throw new Error("资料不存在或已被删除");
    }

    const text = this.documentText(sourceRecord).slice(0, 4000);
    if (!text) {
      throw new Error("资料没有可用于构图的文本片段");
    }

    let extractedNodes: ExtractedNode[] = [];
    let extractedEdges: ExtractedEdge[] = [];
    let usedFallback = false;
    try {
      const generated = await this.llm.generateJson(this.buildPrompt(text));
      extractedNodes = this.normalizeNodes(generated["nodes"]);
      extractedEdges = this.normalizeEdges(generated["edges"]);
    } catch {
      usedFallback = true;
    }
    if (!extractedNodes.length) {
      extractedNodes = this.offlineNodes(text);
      extractedEdges = [];
      usedFallback = true;
    }

    const prefix = String(docId).slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_") || "document";
    const documentNode: KnowledgeNode = {
      id: `doc_${prefix}_0`,
      name: String(sourceRecord["file_name"] ?? "未命名资料"),
      category: "document",
      subject: "资料",
      grade: "",
      aliases: "",
      description: "用户导入的学习资料",
    };
    const topicNodes = extractedNodes.slice(0, 12).map((node, index): KnowledgeNode => ({
      id: `doc_${prefix}_${index + 1}`,
      name: node.name,
      category: node.category || "topic",
      subject: node.subject || "未分类",
      grade: "",
      aliases: node.aliases,
      description: node.description || (usedFallback ? "离线规则抽取" : ""),
    }));

    const idsByName = new Map(topicNodes.map((node) => [node.name, node.id]));
    const edges: KnowledgeEdge[] = topicNodes.map((node) => ({
      source_id: documentNode.id,
      target_id: node.id,
      relation: "contains",
    }));
    for (const edge of extractedEdges) {
      const sourceId = idsByName.get(edge.source_name);
      const targetId = idsByName.get(edge.target_name);
      if (sourceId && targetId && sourceId !== targetId) {
        edges.push({
          source_id: sourceId,
          target_id: targetId,
          relation: edge.relation,
        });
      }
    }

    const addedNodes = this.store.addKgNodes([documentNode, ...topicNodes]);
    const addedEdges = this.store.addKgEdges(edges);
    // F1：把生成的节点 ID 回写到资料上，形成「资料 → 图谱」的可查证据链。
    const generatedIds = [documentNode.id, ...topicNodes.map((node) => node.id)];
    const current = this.store
      .get_documents(userId)
      .find((item) => String(item["doc_id"] ?? "") === docId);
    const existingIds = Array.isArray(current?.["kg_node_ids"])
      ? (current!["kg_node_ids"] as unknown[]).map((id) => String(id))
      : [];
    this.store.update_document(userId, docId, {
      kg_node_ids: [...existingIds, ...generatedIds],
    });
    return {
      doc_id: docId,
      file_name: documentNode.name,
      node_count: this.store.kgNodes().length,
      edge_count: this.store.kgEdges().length,
      added_nodes: addedNodes,
      added_edges: addedEdges,
      topic_nodes: topicNodes,
      used_fallback: usedFallback,
    };
  }

  private documentText(sourceRecord: Record<string, unknown>): string {
    const chunks = Array.isArray(sourceRecord["chunks"]) ? sourceRecord["chunks"] : [];
    return chunks
      .map((chunk) =>
        chunk && typeof chunk === "object"
          ? String((chunk as Record<string, unknown>)["text"] ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }

  private buildPrompt(text: string): string {
    return [
      "请从学习资料中抽取知识点并输出严格 JSON。",
      '格式：{"nodes":[{"name":"","category":"topic","subject":"","aliases":[],"description":""}],',
      '"edges":[{"source_name":"","target_name":"","relation":"prerequisite_of"}]}。',
      "relation 只能是 contains、prerequisite_of、recommends、practice_for。",
      "只保留资料中明确出现、适合作为学习图谱节点的内容，最多 12 个节点。",
      `资料原文：\n${text}`,
    ].join("\n");
  }

  private normalizeNodes(raw: unknown): ExtractedNode[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const result: ExtractedNode[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const value = item as Record<string, unknown>;
      const name = String(value["name"] ?? "").trim().slice(0, 80);
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const aliases = Array.isArray(value["aliases"])
        ? value["aliases"].map((alias) => String(alias).trim()).filter(Boolean).join(",")
        : String(value["aliases"] ?? "").trim();
      result.push({
        name,
        category: String(value["category"] ?? "topic").trim().slice(0, 32) || "topic",
        subject: String(value["subject"] ?? "未分类").trim().slice(0, 40) || "未分类",
        aliases: aliases.slice(0, 240),
        description: String(value["description"] ?? "").trim().slice(0, 500),
      });
    }
    return result;
  }

  private normalizeEdges(raw: unknown): ExtractedEdge[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const value = item as Record<string, unknown>;
      const relation = String(value["relation"] ?? "").trim();
      const sourceName = String(value["source_name"] ?? "").trim();
      const targetName = String(value["target_name"] ?? "").trim();
      return ALLOWED_RELATIONS.has(relation) && sourceName && targetName
        ? [{ source_name: sourceName, target_name: targetName, relation }]
        : [];
    });
  }

  private offlineNodes(text: string): ExtractedNode[] {
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) {
      if (token.length < 2 || /^\d+$/.test(token)) {
        continue;
      }
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
      .slice(0, 5)
      .map(([name]) => ({
        name,
        category: "topic",
        subject: "未分类",
        aliases: "",
        description: "离线规则抽取",
      }));
  }
}
