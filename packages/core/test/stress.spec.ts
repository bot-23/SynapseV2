import { describe, expect, it } from "vitest";

import { createSynapseCore } from "../src/application/core.js";
import { KgBuilder } from "../src/application/kgBuilder.js";
import { search_document_records } from "../src/domain/documentRetrieval.js";
import type {
  GenerateWithToolsResult,
  LlmProvider,
} from "../src/providers/contracts.js";
import { KgRetrievalProvider } from "../src/providers/kgRetrieval.js";
import type { KvStore } from "../src/storage/kv.js";
import type { KnowledgeNode } from "../src/storage/kgSeed.js";

class DelayedKgLlm implements LlmProvider {
  describe(): Record<string, unknown> {
    return { provider: "stress-mock", status: "ready" };
  }

  async generateText(): Promise<string> {
    return "";
  }

  async generateWithTools(): Promise<GenerateWithToolsResult> {
    return { content: "" };
  }

  async generateJson(): Promise<Record<string, unknown>> {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return {
      nodes: [
        {
          name: "函数单调性",
          category: "topic",
          subject: "高中数学",
          aliases: ["单调性"],
          description: "通过导数符号判断单调区间",
        },
        {
          name: "导数",
          category: "topic",
          subject: "高中数学",
          aliases: [],
          description: "函数变化率",
        },
      ],
      edges: [
        {
          source_name: "导数",
          target_name: "函数单调性",
          relation: "prerequisite_of",
        },
      ],
    };
  }

  async *streamText(): AsyncIterable<string> {
    yield "";
  }
}

class MalformedKgLlm extends DelayedKgLlm {
  override async generateJson(): Promise<Record<string, unknown>> {
    return {
      nodes: [
        { name: "极限", category: "topic", subject: "高等数学" },
        { name: "极限", category: "topic", subject: "重复项" },
        { name: "", category: "topic" },
        null,
      ],
      edges: [
        { source_name: "极限", target_name: "极限", relation: "prerequisite_of" },
        { source_name: "极限", target_name: "不存在", relation: "unknown_relation" },
      ],
    };
  }
}

class LimitedKvStore implements KvStore {
  private readonly data = new Map<string, unknown>();

  constructor(private readonly maxBytes: number) {}

  get(key: string): unknown {
    return this.data.get(key);
  }

  set(key: string, value: unknown): void {
    const candidate = new Map(this.data);
    candidate.set(key, value);
    const bytes = [...candidate.entries()].reduce(
      (sum, [itemKey, itemValue]) =>
        sum + itemKey.length + JSON.stringify(itemValue ?? null).length,
      0,
    );
    if (bytes > this.maxBytes) {
      throw new Error("storage quota exceeded");
    }
    this.data.set(key, value);
  }

  delete(key: string): void {
    this.data.delete(key);
  }
}

function planPayload(index: number): Record<string, unknown> {
  return {
    message: `压力测试计划 ${index}`,
    plan: {
      weekly_plan: [
        {
          day_index: 1,
          focus: `第 ${index} 版`,
          tasks: [
            {
              title: `任务 ${index}`,
              subject: "数学",
              task_type: "learn",
              duration_minutes: 30,
              reason: "压力测试",
            },
          ],
          carry_over: [],
        },
      ],
    },
    blockPlan: null,
  };
}

describe("压力测试：资料构图", () => {
  it("同一资料并发构建 20 次仍只写入一组节点和边", async () => {
    let sequence = 0;
    const core = createSynapseCore({ idGen: { next: () => `stress-${++sequence}` } });
    core.importDocument(
      "default",
      "函数专题",
      "导数是研究函数单调性的工具，函数单调性需要判断导数符号。",
    );
    const docId = String(
      (
        (core.listDocuments().data as Record<string, unknown>)["documents"] as Array<
          Record<string, unknown>
        >
      )[0]!["doc_id"],
    );
    const builder = new KgBuilder(core.store, new DelayedKgLlm());
    const beforeNodes = core.store.kgNodes().length;
    const beforeEdges = core.store.kgEdges().length;

    const results = await Promise.all(
      Array.from({ length: 20 }, () => builder.buildKgFromDocument(docId)),
    );

    expect(results.reduce((sum, result) => sum + result.added_nodes, 0)).toBe(3);
    expect(results.reduce((sum, result) => sum + result.added_edges, 0)).toBe(3);
    expect(core.store.kgNodes()).toHaveLength(beforeNodes + 3);
    expect(core.store.kgEdges()).toHaveLength(beforeEdges + 3);
  });

  it("模型返回重复、空节点和非法关系时只保留有效内容", async () => {
    const core = createSynapseCore({ idGen: { next: () => "malformed-doc" } });
    core.importDocument("default", "异常模型资料", "极限极限极限");
    const builder = new KgBuilder(core.store, new MalformedKgLlm());
    const result = await builder.buildKgFromDocument("malformed-doc");

    expect(result.added_nodes).toBe(2);
    expect(result.added_edges).toBe(1);
    expect(result.topic_nodes.map((node) => node.name)).toEqual(["极限"]);
  });

  it("百节点图谱仍可稳定检索尾部节点", () => {
    const core = createSynapseCore();
    const nodes: KnowledgeNode[] = Array.from({ length: 100 }, (_, index) => ({
      id: `stress-node-${index}`,
      name: `压力知识点${index}`,
      category: "topic",
      subject: "压力测试",
      grade: "",
      aliases: `节点${index}`,
      description: `第 ${index} 个压力测试节点`,
    }));
    core.store.addKgNodes(nodes);
    core.store.addKgEdges(
      nodes.slice(1).map((node, index) => ({
        source_id: nodes[index]!.id,
        target_id: node.id,
        relation: "prerequisite_of",
      })),
    );

    const lines = new KgRetrievalProvider(core.store).search("压力知识点99");
    expect(lines.join("\n")).toContain("压力知识点99");
    expect(core.store.kgNodes()).toHaveLength(109);
  });
});

describe("压力测试：存储与幂等", () => {
  it("连续保存 120 版计划只保留最近 30 版", () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-23T08:00:00.000Z" },
    });
    for (let index = 1; index <= 120; index += 1) {
      core.savePlan("default", planPayload(index), `第 ${index} 次写入`);
    }

    const data = core.listPlanVersions().data as Record<string, unknown>;
    const versions = data["versions"] as Array<{ version: number }>;
    expect(data["total"]).toBe(30);
    expect(versions[0]!.version).toBe(91);
    expect(versions[29]!.version).toBe(120);
  });

  it("重复载入演示数据 20 次不会复制资料、图谱节点或复习项", async () => {
    let sequence = 0;
    const core = createSynapseCore({
      idGen: { next: () => `demo-${++sequence}` },
      clock: { nowIso: () => "2026-09-23T08:00:00.000Z" },
      config: { offlinePlanFallback: true },
    });
    for (let index = 0; index < 20; index += 1) {
      expect((await core.loadDemoData()).success).toBe(true);
    }

    expect(core.store.get_documents("default")).toHaveLength(1);
    expect(core.store.kgNodes()).toHaveLength(15);
    expect(new Set(core.store.get_reviews("default").map((item) => item.key)).size).toBe(
      core.store.get_reviews("default").length,
    );
    expect((core.listPlanVersions().data as Record<string, unknown>)["total"]).toBe(20);
  });

  it("清空演示数据后只保留内置图谱，不残留资料节点", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-23T08:00:00.000Z" },
      config: { offlinePlanFallback: true },
    });
    await core.loadDemoData();
    expect(core.store.kgNodes().length).toBeGreaterThan(9);

    expect(core.deleteAllUserData().success).toBe(true);
    expect(core.store.get_documents("default")).toHaveLength(0);
    expect(core.store.get_reviews("default")).toHaveLength(0);
    expect(core.store.get_plan("default")).toBeNull();
    expect(core.store.kgNodes()).toHaveLength(9);
    expect(core.store.kgEdges()).toHaveLength(10);
  });

  it("批量导入 80 份资料后仍能命中目标资料", () => {
    let sequence = 0;
    const core = createSynapseCore({ idGen: { next: () => `bulk-${++sequence}` } });
    for (let index = 0; index < 80; index += 1) {
      const marker = index === 79 ? "稀有标记量子潮汐" : `普通材料${index}`;
      expect(
        core.importDocument(
          "default",
          `资料-${index}`,
          `${marker} ${"函数导数练习 ".repeat(80)}`,
        ).success,
      ).toBe(true);
    }

    const records = core.store.get_documents("default");
    const hits = search_document_records(records as never, "量子潮汐", null, 3);
    expect(records).toHaveLength(80);
    expect(hits[0]).toContain("资料-79");
  });

  it("存储容量不足时导入明确失败且已有资料不损坏", () => {
    let sequence = 0;
    const core = createSynapseCore({
      kv: new LimitedKvStore(3500),
      idGen: { next: () => `quota-${++sequence}` },
    });
    expect(core.importDocument("default", "已有资料", "函数与导数基础").success).toBe(true);

    const failed = core.importDocument("default", "超大资料", "容量压力文本".repeat(1000));
    expect(failed.success).toBe(false);
    expect(failed.message).toContain("storage quota exceeded");
    const documents = core.listDocuments().data as Record<string, unknown>;
    expect(documents["total"]).toBe(1);
  });
});
