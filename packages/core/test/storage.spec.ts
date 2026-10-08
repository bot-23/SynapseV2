/**
 * 存储层测试：内存镜像 + 异步后端（CachedKvStore）。
 *
 * 这一层的意义是把「异步存储后端」的代价关在一个类里：core 与 RuntimeStore
 * 仍然只认同步的 KvStore，Web 用 IndexedDB、桌面用 SQLite 时业务代码零改动。
 */

import { describe, expect, it } from "vitest";

import { CachedKvStore, type KvBackend } from "../src/storage/kv.js";

/** 可控的假后端：记录每次落盘，便于断言「什么时候真的写了」。 */
class FakeBackend implements KvBackend {
  records: Record<string, unknown>;
  saves: string[] = [];
  removes: string[] = [];

  constructor(seed: Record<string, unknown> = {}) {
    this.records = { ...seed };
  }

  async load(): Promise<Record<string, unknown>> {
    return { ...this.records };
  }

  async save(key: string, value: unknown): Promise<void> {
    this.saves.push(key);
    this.records[key] = value;
  }

  async remove(key: string): Promise<void> {
    this.removes.push(key);
    delete this.records[key];
  }
}

describe("storage：CachedKvStore", () => {
  it("创建时把后端数据全量读进内存，读取是同步的", async () => {
    const backend = new FakeBackend({ profile: { display_name: "小明" }, "kg:nodes": [] });
    const store = await CachedKvStore.create(backend);

    expect(store.get("profile")).toEqual({ display_name: "小明" });
    expect(store.get("kg:nodes")).toEqual([]);
    expect(store.get("不存在")).toBeUndefined();
  });

  it("写入先落内存、flush 之后才落盘", async () => {
    const backend = new FakeBackend();
    const store = await CachedKvStore.create(backend);

    store.set("plans:default", { version: 2 });
    // 还没 flush：内存已可读，后端还没动
    expect(store.get("plans:default")).toEqual({ version: 2 });
    expect(backend.records["plans:default"]).toBeUndefined();
    expect(store.pending).toBe(true);

    await store.flush();

    expect(backend.records["plans:default"]).toEqual({ version: 2 });
    expect(store.pending).toBe(false);
  });

  it("删除同样要 flush 才落盘", async () => {
    const backend = new FakeBackend({ "messages:c1": [{ id: "m1" }] });
    const store = await CachedKvStore.create(backend);

    store.delete("messages:c1");
    await store.flush();

    expect(backend.records["messages:c1"]).toBeUndefined();
  });

  it("同一批同步写入只落盘一次（批量载入演示数据不会写成千上万次）", async () => {
    const backend = new FakeBackend();
    const store = await CachedKvStore.create(backend);

    store.set("a", 1);
    store.set("b", 2);
    store.set("c", 3);
    // 中间态被合并：a 被覆盖后只写最后一次
    store.set("a", 9);
    await store.flush();

    expect(backend.saves.sort()).toEqual(["a", "b", "c"]);
    expect(backend.records).toEqual({ a: 9, b: 2, c: 3 });
  });

  it("flush 期间新产生的改动也会被写回", async () => {
    const backend = new FakeBackend();
    const store = await CachedKvStore.create(backend);

    store.set("a", 1);
    const flushing = store.flush();
    store.set("b", 2);
    await flushing;

    expect(backend.records).toEqual({ a: 1, b: 2 });
    expect(store.pending).toBe(false);
  });

  it("onDirty 在每次写入/删除时回调（壳据此做防抖写回）", async () => {
    let calls = 0;
    const store = await CachedKvStore.create(new FakeBackend(), { onDirty: () => (calls += 1) });

    store.set("x", 1);
    store.delete("y");

    expect(calls).toBe(2);
  });

  it("并发 flush 合并成同一次写", async () => {
    const backend = new FakeBackend();
    const store = await CachedKvStore.create(backend);

    store.set("k", 1);
    await Promise.all([store.flush(), store.flush(), store.flush()]);

    expect(backend.saves).toEqual(["k"]);
  });
});
