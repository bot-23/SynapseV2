/**
 * 知识图谱检索 Provider（重写自 Synapse/db/retrieval.py 的 SQLRetrievalProvider）。
 * 图谱内容全部来自用户资料与计划（存 KV 桶 kg:nodes / kg:edges），新装时为空。
 *
 * 行为要点：
 * - 排序：(-score, topic 优先, name 码点序)，稳定排序，节点保持写入序。
 * - 邻接节点名：邻接 id 按字典序排列后映射名称（与旧库 SQLite 主键索引扫描序一致）。
 * - 路径：双向 BFS，边按插入序入邻接表，最深 4 层。
 */

import type { RuntimeStore } from "../storage/runtimeStore";
import type { KnowledgeNode } from "../storage/kgTypes";
import type { RetrievalProvider } from "./contracts";

interface RankedNode {
  id: string;
  name: string;
  category: string;
  subject: string;
  score: number;
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).join(" ");
  }
  return String(value).toLowerCase();
}

const STOP_WORDS = new Set(["每天", "分钟", "同学", "计划", "模式", "生成", "一个", "怎么", "安排"]);

export class KgRetrievalProvider implements RetrievalProvider {
  constructor(private readonly store: RuntimeStore) {}

  search(query: string): string[] {
    const [nodeCount, edgeCount] = this.summaryCounts();
    const ranked = this.rankNodes(query);
    if (!ranked.length) {
      return [
        `图谱摘要：当前已有 ${nodeCount} 个节点、${edgeCount} 条边。`,
        `未在图谱里直接命中「${query}」，先按通用学习规划策略继续生成。`,
        "图谱建议：先补录课程、知识点和任务关系，后续能给出更贴近学科结构的路径。",
      ];
    }

    const topMatches = ranked.slice(0, 3);
    const contextLines = [`图谱摘要：当前已有 ${nodeCount} 个节点、${edgeCount} 条边。`];

    for (const node of topMatches) {
      const relationNames = this.collectNeighborNames(node.id);
      const relationText = relationNames.length
        ? relationNames.slice(0, 4).join("、")
        : "暂无直接相邻节点";
      contextLines.push(
        `图谱命中：${node.name}（${node.category} / ${node.subject}，匹配分 ${node.score}），关联内容：${relationText}。`,
      );
    }

    const topIds = topMatches.map((node) => node.id);
    const learningPath = this.buildLearningPath(topIds);
    if (learningPath.length) {
      contextLines.push(`图谱建议路径：${learningPath.join(" -> ")}。`);
    } else {
      contextLines.push("图谱建议路径：先知识点梳理，再做题验证，最后安排回顾闭环。");
    }

    return contextLines;
  }

  describe(): Record<string, unknown> {
    const [nodeCount, edgeCount] = this.summaryCounts();
    return {
      provider: "sql-kg",
      status: "ready",
      node_count: nodeCount,
      edge_count: edgeCount,
    };
  }

  private summaryCounts(): [number, number] {
    return [this.store.kgNodes().length, this.store.kgEdges().length];
  }

  private rankNodes(query: string): RankedNode[] {
    let keywords = this.extractKeywords(query);
    const queryText = query.toLowerCase();
    if (!keywords.length) {
      keywords = queryText.trim() ? [queryText.trim()] : [];
    }

    const nodes = this.store.kgNodes();
    const ranked: RankedNode[] = [];
    for (const node of nodes) {
      const aliases = (node.aliases || "").split(",");
      const searchBlob = [
        node.id.toLowerCase(),
        normalizeText(node.name),
        normalizeText(node.category),
        normalizeText(node.subject),
        normalizeText(node.grade || ""),
        normalizeText(node.description || ""),
        normalizeText(aliases),
      ].join(" ");
      let score = keywords.filter((kw) => kw && searchBlob.includes(kw)).length;
      for (const term of [node.id, node.name, node.category, node.subject, ...aliases]) {
        const normalized = normalizeText(term).trim();
        if (normalized.length >= 2 && queryText.includes(normalized)) {
          score += 2;
        }
      }
      if (score > 0) {
        ranked.push({
          id: node.id,
          name: node.name,
          category: node.category,
          subject: node.subject,
          score,
        });
      }
    }

    ranked.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      const aTopic = a.category === "topic" ? 0 : 1;
      const bTopic = b.category === "topic" ? 0 : 1;
      if (aTopic !== bTopic) {
        return aTopic - bTopic;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return ranked;
  }

  private extractKeywords(query: string): string[] {
    const rawTokens = query.toLowerCase().match(/[一-鿿]{2,}|[a-zA-Z]{3,}|\d{2,3}/g) ?? [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const token of rawTokens) {
      if (STOP_WORDS.has(token)) {
        continue;
      }
      if (!seen.has(token)) {
        seen.add(token);
        result.push(token);
      }
    }
    return result;
  }

  private collectNeighborNames(nodeId: string): string[] {
    const edges = this.store.kgEdges();
    const neighborIds = new Set<string>();
    for (const edge of edges) {
      if (edge.source_id === nodeId || edge.target_id === nodeId) {
        if (edge.source_id !== nodeId) {
          neighborIds.add(edge.source_id);
        }
        if (edge.target_id !== nodeId) {
          neighborIds.add(edge.target_id);
        }
      }
    }
    if (!neighborIds.size) {
      return [];
    }
    const nodesById = new Map<string, KnowledgeNode>(
      this.store.kgNodes().map((node) => [node.id, node]),
    );
    // 与旧库 SQLite 主键索引扫描序一致：按 id 字典序
    return [...neighborIds]
      .sort()
      .map((id) => nodesById.get(id)?.name ?? id);
  }

  private buildLearningPath(nodeIds: string[]): string[] {
    if (nodeIds.length < 2) {
      return [];
    }

    const path = this.findPath(nodeIds[0]!, nodeIds[1]!);
    if (!path) {
      return [];
    }

    const nodesById = new Map<string, KnowledgeNode>(
      this.store.kgNodes().map((node) => [node.id, node]),
    );
    return path.map((nid) => nodesById.get(nid)?.name ?? nid);
  }

  private findPath(startId: string, endId: string, maxDepth = 4): string[] | null {
    if (startId === endId) {
      return [startId];
    }

    const adjacency = new Map<string, string[]>();
    for (const edge of this.store.kgEdges()) {
      if (!adjacency.has(edge.source_id)) {
        adjacency.set(edge.source_id, []);
      }
      adjacency.get(edge.source_id)!.push(edge.target_id);
      if (!adjacency.has(edge.target_id)) {
        adjacency.set(edge.target_id, []);
      }
      adjacency.get(edge.target_id)!.push(edge.source_id);
    }

    const queue: string[][] = [[startId]];
    const visited = new Set([startId]);

    while (queue.length) {
      const path = queue.shift()!;
      const current = path[path.length - 1]!;
      if (path.length > maxDepth) {
        continue;
      }
      for (const neighbor of adjacency.get(current) ?? []) {
        if (neighbor === endId) {
          return [...path, neighbor];
        }
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...path, neighbor]);
        }
      }
    }
    return null;
  }
}
