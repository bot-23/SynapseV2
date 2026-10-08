/**
 * KV 分键化回归测试。
 *
 * 起因：资料与图谱原先都是「一个键装整个数组」，改一份资料就要把全部资料的正文
 * 重新序列化一遍。这里用「记录 set 调用的 KV」把「只写被改的那一条」变成可断言的事实。
 */

import { describe, expect, it } from "vitest";

import type { KvStore } from "../src/storage/kv.js";
import { RuntimeStore } from "../src/storage/runtimeStore.js";

const fixedClock = { nowIso: () => "2026-03-04T09:00:00.000Z" };

/** 记录每次写入/删除的键，用来断言「写了什么、没写什么」。 */
class RecordingKvStore implements KvStore {
  readonly sets: string[] = [];
  private readonly data = new Map<string, unknown>();

  get(key: string): unknown {
    return this.data.get(key);
  }

  set(key: string, value: unknown): void {
    this.sets.push(key);
    this.data.set(key, value);
  }

  delete(key: string): void {
    this.sets.push(`del:${key}`);
    this.data.delete(key);
  }
}

const node = (id: string) => ({
  id,
  name: `知识点-${id}`,
  category: "topic",
  subject: "数学",
  grade: "",
  aliases: "",
  description: "",
});

describe("分键存储：资料", () => {
  it("资料存在索引键 + 条目键里，不再有整数组的 documents 键", () => {
    const kv = new RecordingKvStore();
    const store = new RuntimeStore(kv, fixedClock);

    store.save_documents("default", [
      { doc_id: "a", file_name: "A", chunks: [{ chunk_id: "1", text: "aaa" }] },
      { doc_id: "b", file_name: "B", chunks: [{ chunk_id: "1", text: "bbb" }] },
    ]);

    expect(kv.get("doc_index:default")).toEqual(["a", "b"]);
    expect(kv.get("doc:default:a")).toBeTruthy();
    expect(kv.get("doc:default:b")).toBeTruthy();
    expect(kv.get("documents:default")).toBeUndefined();
  });

  it("更新单份资料只写这一条的键，不牵动其它资料的正文", () => {
    const kv = new RecordingKvStore();
    const store = new RuntimeStore(kv, fixedClock);
    store.save_documents("default", [
      { doc_id: "a", file_name: "A", chunks: [{ chunk_id: "1", text: "aaa" }] },
      { doc_id: "b", file_name: "B", chunks: [{ chunk_id: "1", text: "bbb" }] },
    ]);

    kv.sets.length = 0;
    store.update_document("default", "a", { subject: "数学" });

    expect(kv.sets).toEqual(["doc:default:a"]);
  });

  it("删除单份资料只删这一条 + 重写索引", () => {
    const kv = new RecordingKvStore();
    const store = new RuntimeStore(kv, fixedClock);
    store.save_documents("default", [
      { doc_id: "a", file_name: "A", chunks: [] },
      { doc_id: "b", file_name: "B", chunks: [] },
    ]);

    kv.sets.length = 0;
    const remaining = store.delete_document("default", "a");

    expect(remaining.map((doc) => doc["doc_id"])).toEqual(["b"]);
    expect(kv.sets).toEqual(["del:doc:default:a", "doc_index:default"]);
    expect(kv.get("doc:default:b")).toBeTruthy();
  });
});

describe("分键存储：旧布局读侧迁移", () => {
  it("旧的整数组 documents 键被读到后迁到分键，并清掉旧键", () => {
    const kv = new RecordingKvStore();
    kv.set("documents:default", [{ doc_id: "old", file_name: "旧资料", chunks: [] }]);
    const store = new RuntimeStore(kv, fixedClock);

    const docs = store.get_documents("default");
    expect(docs.length).toBe(1);
    expect(docs[0]!["file_name"]).toBe("旧资料");

    expect(kv.get("doc:default:old")).toBeTruthy();
    expect(kv.get("doc_index:default")).toEqual(["old"]);
    // 迁移后旧键不再残留一份读不到的副本
    expect(kv.get("documents:default")).toBeUndefined();
  });

  it("旧的整数组 kg:nodes 键被读到后迁到分键", () => {
    const kv = new RecordingKvStore();
    kv.set("kg:nodes", [node("legacy-1")]);
    const store = new RuntimeStore(kv, fixedClock);

    expect(store.kgNodes("default").length).toBe(1);
    expect(kv.get("kg:node:default:legacy-1")).toBeTruthy();
    expect(kv.get("kg:node_index:default")).toEqual(["legacy-1"]);
    expect(kv.get("kg:nodes")).toBeUndefined();
    // 非默认档案不会沾到旧键的数据
    expect(store.kgNodes("u-alice").length).toBe(0);
  });
});

describe("分键存储：图谱追加", () => {
  it("追加一个节点不重写已有节点", () => {
    const kv = new RecordingKvStore();
    const store = new RuntimeStore(kv, fixedClock);
    store.addKgNodes("default", [node("n1"), node("n2")]);

    kv.sets.length = 0;
    const added = store.addKgNodes("default", [node("n3")]);

    expect(added).toBe(1);
    expect(kv.sets).toContain("kg:node:default:n3");
    expect(kv.sets).not.toContain("kg:node:default:n1");
    expect(kv.sets).not.toContain("kg:node:default:n2");
    expect(store.kgNodes("default").map((item) => item.id)).toEqual(["n1", "n2", "n3"]);
  });
});
