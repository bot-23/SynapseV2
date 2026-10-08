/**
 * 数据可迁移 / 记忆管理 / 学习趋势 的回归测试。
 *
 * 这三块对应本轮补齐的功能空白：
 * - 数据此前「只出得去、回不来」——导出有、导入无，纯本地路线下无法换设备；
 * - AI 记住的内容只进 prompt、用户完全看不见也删不掉；
 * - 只有单一窗口快照（周报），没有随时间变化的曲线。
 */

import { describe, expect, it } from "vitest";

import { createSynapseCore } from "../src/application/core.js";
import { MemoryKvStore } from "../src/storage/kv.js";

const fixedClock = { nowIso: () => "2026-03-04T09:00:00.000Z" };

describe("数据导入：export → import 往返", () => {
  it("把导出的 JSON 恢复到全新实例", () => {
    const coreA = createSynapseCore({ clock: fixedClock });
    coreA.saveProfile("default", "小明", "高三");
    coreA.store.save_profile("default", { weak_points: ["导数与单调性"] });
    coreA.store.save_plan(
      "default",
      "测试计划",
      [{ day_index: 1, focus: "函数", tasks: [], carry_over: [] }],
      null,
      "测试",
    );
    coreA.store.add_subject("default", "高中数学", "test");
    coreA.addReviewTopic("default", "高中数学", "受力分析");
    coreA.importDocument("default", "笔记.txt", "函数与导数要先求导再判断符号。".repeat(20));

    const exported = coreA.exportData("default");
    expect(exported.success).toBe(true);
    const bundle = exported.data as Record<string, unknown>;
    const payload = bundle["data"] as Record<string, unknown>;
    expect(payload).toBeTruthy();

    const coreB = createSynapseCore({ clock: fixedClock });
    const imported = coreB.importData("default", payload);
    expect(imported.success).toBe(true);

    expect(coreB.getProfile("default").data?.["display_name"]).toBe("小明");
    expect((coreB.listDocuments("default").data?.["documents"] as unknown[]).length).toBe(1);
    expect(coreB.listReviews("default").data?.["total"]).toBe(1);
    expect(coreB.listSubjects("default").data?.["total"]).toBe(1);
    expect(coreB.getCurrentPlan("default").data?.["version"]).toBe(1);
  });
});

describe("数据导入：安全边界", () => {
  it("api_key 不随文件迁移，未知键被忽略，非对象直接拒绝", () => {
    const kv = new MemoryKvStore();
    const core = createSynapseCore({ kv, clock: fixedClock });
    core.store.save_api_key("default", "sk-keepme");

    const result = core.importData("default", {
      "profile:src": { display_name: "小红", api_key: "sk-evil" },
      "plans:src": { version: 1, message: "", weekly_plan: [] },
      "unknown:src": { hack: true },
    });

    expect(result.success).toBe(true);
    // 本机凭据不被导入文件覆盖
    expect(core.store.get_api_key("default")).toBe("sk-keepme");
    expect(core.getProfile("default").data?.["display_name"]).toBe("小红");
    // 白名单之外的键不进 KV
    expect(kv.get("unknown:src")).toBeUndefined();

    expect(
      core.importData("default", null as unknown as Record<string, unknown>).success,
    ).toBe(false);
    expect(
      core.importData("default", [] as unknown as Record<string, unknown>).success,
    ).toBe(false);
  });

  it("空文件（没有可识别数据集）返回失败而不是谎报成功", () => {
    const core = createSynapseCore({ clock: fixedClock });
    expect(core.importData("default", { exported_at: "2026-03-04" }).success).toBe(false);
  });
});

describe("记忆：可见可删", () => {
  it("列出 remember 写入的弱项与偏好，并能逐条 / 整体删除", () => {
    const core = createSynapseCore({ clock: fixedClock });
    core.store.save_profile("default", {
      weak_points: ["导数", "数列"],
      mood: "有点焦虑",
      focus_preference: "先做题再看讲解",
    });

    const listed = core.listMemories("default");
    expect(listed.success).toBe(true);
    const values = (listed.data?.["memories"] as Array<{ value: string }>).map((m) => m.value);
    expect(values).toContain("导数");
    expect(values).toContain("数列");
    expect(values).toContain("有点焦虑");
    expect(values).toContain("先做题再看讲解");

    core.deleteMemory("default", "weak_points", "导数");
    const after = (core.listMemories("default").data?.["memories"] as Array<{ value: string }>).map(
      (m) => m.value,
    );
    expect(after).not.toContain("导数");
    expect(after).toContain("数列");

    core.deleteMemory("default", "mood");
    const final = (core.listMemories("default").data?.["memories"] as Array<{ value: string }>).map(
      (m) => m.value,
    );
    expect(final).not.toContain("有点焦虑");
  });

  it("没有画像时返回空列表，未知类型删除会失败", () => {
    const core = createSynapseCore({ clock: fixedClock });
    expect((core.listMemories("default").data?.["memories"] as unknown[]).length).toBe(0);
    expect(core.deleteMemory("default", "不存在的类型").success).toBe(false);
  });
});

describe("本地多用户档案", () => {
  it("创建 / 列出 / 删除档案，数据按档案隔离", () => {
    const core = createSynapseCore({ clock: fixedClock });
    expect(core.createUser("u-alice", "小艾").success).toBe(true);
    core.store.save_profile("u-alice", { weak_points: ["导数"] });

    const users = core.listUsers().data?.["users"] as Array<{ user_id: string }>;
    expect(users.map((user) => user.user_id)).toContain("u-alice");

    // 数据按档案隔离：小艾的弱项不会出现在 default 上
    expect(core.listMemories("default").data?.["total"]).toBe(0);
    expect(core.listMemories("u-alice").data?.["total"]).toBe(1);

    // 重名拒绝
    expect(core.createUser("u-alice").success).toBe(false);
    // 默认档案不可删
    expect(core.deleteUser("default").success).toBe(false);

    expect(core.deleteUser("u-alice").success).toBe(true);
    expect(
      (core.listUsers().data?.["users"] as Array<{ user_id: string }>).map((u) => u.user_id),
    ).not.toContain("u-alice");
  });

  it("非法档案名被拒绝（原型污染防护）", () => {
    const core = createSynapseCore({ clock: fixedClock });
    expect(core.createUser("__proto__").success).toBe(false);
    expect(core.createUser("").success).toBe(false);
  });
});

describe("知识图谱按档案隔离", () => {
  const node = (id: string) => ({
    id,
    name: `知识点-${id}`,
    category: "topic",
    subject: "数学",
    grade: "",
    aliases: "",
    description: "",
  });

  it("不同档案的图谱互相看不见，删档也不会清掉别人的", () => {
    const core = createSynapseCore({ clock: fixedClock });
    core.store.addKgNodes("u-alice", [node("a1"), node("a2")]);
    core.store.addKgNodes("u-bob", [node("b1")]);

    expect(core.store.kgNodes("u-alice").length).toBe(2);
    expect(core.store.kgNodes("u-bob").length).toBe(1);
    // 未使用的默认档案不受影响
    expect(core.store.kgNodes("default").length).toBe(0);

    // 删掉 alice：bob 的图谱必须还在
    core.store.delete_all_user_data("u-alice");
    expect(core.store.kgNodes("u-alice").length).toBe(0);
    expect(core.store.kgNodes("u-bob").length).toBe(1);
  });

  it("旧版本的无后缀图谱键在默认档案下仍能读到（读侧兜底迁移）", () => {
    const kv = new MemoryKvStore();
    kv.set("kg:nodes", [node("legacy-1")]);
    const core = createSynapseCore({ kv, clock: fixedClock });
    expect(core.store.kgNodes("default").length).toBe(1);
    // 非默认档案不会读到旧键
    expect(core.store.kgNodes("u-alice").length).toBe(0);
  });

  it("接口层 getKnowledgeGraph 也按 userId 取图谱", () => {
    const core = createSynapseCore({ clock: fixedClock });
    core.store.addKgNodes("u-alice", [node("a1")]);
    const alice = core.getKnowledgeGraph("u-alice").data as { nodes: unknown[] };
    const empty = core.getKnowledgeGraph("default").data as { nodes: unknown[] };
    expect(alice.nodes.length).toBe(1);
    expect(empty.nodes.length).toBe(0);
  });
});

describe("学习趋势", () => {
  it("逐日完成度与用量，连续打卡按全部历史算", () => {
    const kv = new MemoryKvStore();
    kv.set("progress:default", {
      a: { done: true, updated_at: "2026-03-04T09:00:00.000Z", actual_minutes: 25 },
      b: { done: true, updated_at: "2026-03-03T09:00:00.000Z", actual_minutes: 30 },
      c: { done: false, updated_at: "2026-03-04T10:00:00.000Z", actual_minutes: 10 },
    });
    const core = createSynapseCore({ kv, clock: fixedClock });

    const data = core.getTrends("default", 30).data as Record<string, unknown>;
    const daily = data["daily"] as Array<{ date: string; done_count: number; minutes: number }>;
    expect(daily.length).toBe(30);
    const last = daily[daily.length - 1]!;
    expect(last.date).toBe("2026-03-04");
    // 只算已完成的：a 计入，c 未完成不计
    expect(last.done_count).toBe(1);
    expect(last.minutes).toBe(25);

    const totals = data["totals"] as Record<string, number>;
    expect(totals["done_count"]).toBe(2);
    expect(totals["active_days"]).toBe(2);
    expect(totals["streak_days"]).toBe(2);
  });

  it("科目能力值走势取窗口内首末差值", () => {
    const kv = new MemoryKvStore();
    kv.set("assessments:default", [
      {
        subject: "数学",
        abilities_snapshot_json: JSON.stringify({ skill_score: 1.2 }),
        created_at: "2026-03-01T09:00:00.000Z",
      },
      {
        subject: "数学",
        abilities_snapshot_json: JSON.stringify({ skill_score: 1.8 }),
        created_at: "2026-03-04T09:00:00.000Z",
      },
    ]);
    const core = createSynapseCore({ kv, clock: fixedClock });

    const data = core.getTrends("default").data as Record<string, unknown>;
    const subjects = data["subjects"] as Array<{ subject: string; delta: number; points: unknown[] }>;
    expect(subjects.length).toBe(1);
    expect(subjects[0]!.subject).toBe("数学");
    expect(subjects[0]!.points.length).toBe(2);
    expect(subjects[0]!.delta).toBeCloseTo(0.6, 5);
  });

  it("天数为非法值时兜底为默认窗口，不会算出 NaN", () => {
    const core = createSynapseCore({ clock: fixedClock });
    const data = core.getTrends("default", Number.NaN).data as Record<string, unknown>;
    expect((data["daily"] as unknown[]).length).toBe(30);
  });
});
