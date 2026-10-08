/**
 * 安全回归测试。
 *
 * 每一条都对应一次安全审计发现的问题：本地存储被篡改、恶意短码、原型污染、
 * 未封顶的模型产出、错误信息回显密钥。任何一条退化都必须当场变红。
 */

import { describe, expect, it } from "vitest";

import { createSynapseCore } from "../src/application/core.js";
import { MemoryKvStore } from "../src/storage/kv.js";
import { RuntimeStore } from "../src/storage/runtimeStore.js";
import {
  ASSIGNMENT_PACK_MAX_ITEMS,
  decode_assignment_pack,
} from "../src/domain/assignmentPack.js";
import { apiFail } from "../src/protocol/frontend.js";

const fixedClock = { nowIso: () => "2026-03-04T09:00:00.000Z" };

describe("安全：原型污染", () => {
  it("task_key = __proto__ 只返回失败，不污染 Object.prototype", () => {
    const core = createSynapseCore({ clock: fixedClock });

    const result = core.updatePlanProgress({
      user_id: "default",
      conversation_id: "",
      plan_id: "",
      plan_version: 1,
      task_key: "__proto__",
      done: true,
      task_title: "污染尝试",
      task_type: "learn",
      actual_minutes: 0,
      plan_message: "",
    });

    expect(result.success).toBe(false);
    // 关键断言：全局原型上不该多出任何字段
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "done")).toBe(false);
    expect(({} as Record<string, unknown>)["task_title"]).toBeUndefined();
  });

  it("非法会话 id 会被拒绝", () => {
    const store = new RuntimeStore(new MemoryKvStore(), fixedClock);
    expect(() => store.save_session("__proto__", {})).toThrow();
    expect(() => store.save_message("m1", "constructor", "user", "hi")).toThrow();
  });

  it("进度里的 __proto__ 残留键不会被读出来", () => {
    const kv = new MemoryKvStore();
    // 模拟被篡改的本地存储：JSON.parse 会带出真正的自有属性 __proto__
    kv.set("progress:default", JSON.parse('{"__proto__":{"done":true},"k1":{"done":false}}'));
    const store = new RuntimeStore(kv, fixedClock);
    const progress = store.get_progress("default");
    expect(Object.keys(progress)).toEqual(["k1"]);
  });
});

describe("安全：损坏的本地存储不崩溃", () => {
  it("messages / documents / profile 形状不对时回退到空值", () => {
    const kv = new MemoryKvStore();
    kv.set("messages:default", "not-an-array");
    kv.set("documents:default", { not: "an-array" });
    kv.set("assignments:default", 42);
    kv.set("profile", "not-an-object");

    const core = createSynapseCore({ kv, clock: fixedClock });

    expect(core.getMessages("default").success).toBe(true);
    expect(core.listDocuments("default").success).toBe(true);
    expect(core.listAssignments("default").success).toBe(true);
    expect(core.getProfile("default").success).toBe(true);
    expect(core.getKnowledgeGraph().success).toBe(true);
  });
});

describe("安全：写入量封顶", () => {
  it("能力评测快照不会无限增长", () => {
    const store = new RuntimeStore(new MemoryKvStore(), fixedClock);
    for (let index = 0; index < 260; index += 1) {
      store.record_assessment(`c${index}`, "数学", {}, "manual");
    }
    const rows = store.get_assessments();
    expect(rows.length).toBeLessThanOrEqual(200);
    // 保留的是最近的一条
    expect(rows[rows.length - 1]!.conversation_id).toBe("c259");
  });

  it("作业包解码对超长字段与超大数值收口", () => {
    const huge = "长".repeat(500);
    const code = [
      "SYNAPSE-ASG/1",
      `2026-03-05|数学|${huge}|999999999|题|999999999`,
      `2026-03-06|英语|标题|1|题|1`,
    ].join("\n");

    const { recognized, drafts } = decode_assignment_pack(code);
    expect(recognized).toBe(true);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.title.length).toBeLessThanOrEqual(60);
    expect(drafts[0]!.quantity).toBeLessThanOrEqual(100_000);
    expect(drafts[0]!.estimated_minutes).toBeLessThanOrEqual(24 * 60 * 30);
  });

  it("作业包最多只收前 N 条", () => {
    const lines = ["SYNAPSE-ASG/1"];
    for (let index = 0; index < ASSIGNMENT_PACK_MAX_ITEMS + 20; index += 1) {
      lines.push(`2026-03-05|数学|题${index}|1|题|30`);
    }
    const { drafts } = decode_assignment_pack(lines.join("\n"));
    expect(drafts.length).toBe(ASSIGNMENT_PACK_MAX_ITEMS);
  });
});

describe("安全：失败信息不回显密钥", () => {
  it("apiFail 会把错误文本里的 sk- 片段打码", () => {
    const response = apiFail("请求失败：Authorization: Bearer sk-abcdef1234567890");
    expect(response.message).not.toContain("sk-abcdef1234567890");
    expect(response.message).toContain("sk-***");
  });

  it("不含密钥的提示原样保留", () => {
    expect(apiFail("API Key 格式错误，应以 sk- 开头").message).toBe(
      "API Key 格式错误，应以 sk- 开头",
    );
  });
});
