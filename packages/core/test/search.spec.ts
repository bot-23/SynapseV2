/**
 * 全局搜索回归测试（资料 / 错题 / 会话）。
 */

import { describe, expect, it } from "vitest";

import { createSynapseCore } from "../src/application/core.js";

const fixedClock = { nowIso: () => "2026-03-04T09:00:00.000Z" };

interface SearchPayload {
  query: string;
  documents: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  total: number;
}

function payloadOf(core: ReturnType<typeof createSynapseCore>, query: string): SearchPayload {
  return core.searchAll("default", query).data as unknown as SearchPayload;
}

describe("全局搜索", () => {
  it("一次搜出资料正文 / 错题 / 会话标题", () => {
    const core = createSynapseCore({ clock: fixedClock });
    core.importDocument("default", "高数笔记.txt", "夹逼定理与无穷小的比较是重点。".repeat(10));
    core.addErrorItem("default", {
      subject: "数学",
      topic: "夹逼定理",
      question: "夹逼定理的适用条件是什么？",
    });
    core.saveConversation("c1", {
      title: "夹逼定理答疑",
      planning_mode: "free",
      user_id: "default",
    });

    const data = payloadOf(core, "夹逼定理");
    expect(data.documents.some((doc) => doc["file_name"] === "高数笔记.txt")).toBe(true);
    expect(data.errors.length).toBe(1);
    expect(data.conversations.some((item) => item["id"] === "c1")).toBe(true);
    expect(data.total).toBeGreaterThan(0);
  });

  it("会话正文命中时给出上下文片段", () => {
    const core = createSynapseCore({ clock: fixedClock });
    core.saveConversation("c2", { title: "随便聊聊", planning_mode: "free", user_id: "default" });
    core.saveMessage("c2", "m1", { role: "user", content: "我想问一下洛必达法则什么时候不能用" });

    const data = payloadOf(core, "洛必达");
    const hit = data.conversations.find((item) => item["id"] === "c2");
    expect(hit).toBeTruthy();
    expect(String(hit!["snippet"])).toContain("洛必达");
  });

  it("会话正文扫描有上限：只翻最近的一批会话", () => {
    let tick = 0;
    const core = createSynapseCore({
      clock: { nowIso: () => new Date(Date.UTC(2026, 2, 4, 9, 0, tick++)).toISOString() },
    });
    // 造 205 条会话，每条一句消息；只有最早和最晚两条带可命中的关键词
    for (let index = 0; index < 205; index += 1) {
      const id = `c${index}`;
      core.saveConversation(id, { title: `会话 ${index}`, planning_mode: "free", user_id: "default" });
      const content =
        index === 0 ? "关键词甲只在最旧的会话里" : index === 204 ? "关键词乙在最新的会话里" : "普通内容";
      core.saveMessage(id, `m${index}`, { role: "user", content });
    }

    // 窗口（200 条）覆盖最新的一批：最新的命中，最旧的落窗外
    expect(payloadOf(core, "关键词乙").conversations.length).toBe(1);
    expect(payloadOf(core, "关键词甲").conversations.length).toBe(0);
  });

  it("资料文件名命中即使正文没有关键词也能搜到", () => {
    const core = createSynapseCore({ clock: fixedClock });
    core.importDocument("default", "微观经济学讲义.txt", "供给与需求的基本关系。".repeat(10));

    const data = payloadOf(core, "微观经济学");
    expect(data.documents.some((doc) => doc["file_name"] === "微观经济学讲义.txt")).toBe(true);
  });

  it("空查询直接失败；无结果时三项为空且 total 为 0", () => {
    const core = createSynapseCore({ clock: fixedClock });
    expect(core.searchAll("default", "   ").success).toBe(false);

    const data = payloadOf(core, "完全不存在的关键词xyz");
    expect(data.total).toBe(0);
    expect(data.documents).toEqual([]);
    expect(data.errors).toEqual([]);
    expect(data.conversations).toEqual([]);
  });
});
