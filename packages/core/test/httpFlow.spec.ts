/**
 * 端到端流程测试：health / 设置 / 图谱摘要 / 画像 / 会话 CRUD / copilot run
 * （自由与积木两种模式）/ SSE 事件流 / 计划落库与进度。
 *
 * 用固定的 clock 与自增 idGen 消除不确定性；断言的是响应的结构与关键语义，
 * 不绑定某一份历史响应的逐字副本，所以有意修改文案时不会被迫「为了过测试而改文案」。
 */

import { describe, expect, it } from "vitest";

import { createSynapseCore, type SynapseCore } from "../src/application/core.js";
import { encodeSseEvent } from "../src/protocol/sse.js";
import type {
  GenerateWithToolsResult,
  LlmProvider,
} from "../src/providers/contracts.js";
import type {
  StudyPilotRunRequest,
  StudyPilotRunResponse,
} from "../src/protocol/frontend.js";

const RUN_PAYLOAD: StudyPilotRunRequest = {
  input: "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟",
  message: "",
  files: [],
  userProfile: { name: "演示同学", grade: "大二" },
  user_profile: null,
  planningMode: "free",
  mode: "free",
  memories: [],
};

const PLAN_REQUEST_INPUT = "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟，给我制定计划";

const FAKE_PLAN_CONTENT = JSON.stringify({
  weekly_plan: [
    {
      day_index: 1,
      focus: "极限与连续",
      tasks: [
        {
          title: "梳理极限定义与判定条件",
          task_type: "learn",
          duration_minutes: 40,
          reason: "先建主干，后续练习不容易发散。",
        },
      ],
    },
  ],
  final_message: "这是假模型给出的鼓励语。",
  next_actions: ["建议一"],
});

/** 与真实 DeepSeek 的差别最小化：describe 自称 deepseek，并按工具调用返回计划。 */
class FakeLlm implements LlmProvider {
  describe(): Record<string, unknown> {
    return { provider: "deepseek", model: "fake-llm-v0", status: "ready" };
  }

  async generateWithTools(
    _prompt: string,
    _tools: unknown[],
    forceTool = "",
  ): Promise<GenerateWithToolsResult> {
    const name = forceTool || "create_plan";
    const args = name === "create_plan" ? { goal: "准备高等数学期末考试", subject: "高等数学" } : {};
    return { tool_calls: [{ name, args }] };
  }

  async generateText(): Promise<string> {
    return FAKE_PLAN_CONTENT;
  }

  async generateJson(): Promise<Record<string, unknown>> {
    return JSON.parse(FAKE_PLAN_CONTENT) as Record<string, unknown>;
  }

  async *streamText(): AsyncIterable<string> {
    yield FAKE_PLAN_CONTENT.slice(0, 20);
    yield FAKE_PLAN_CONTENT.slice(20);
  }
}

function makeCore(options: { offline?: boolean } = {}): SynapseCore {
  return createSynapseCore({
    clock: { nowIso: () => "<timestamp>" },
    idGen: (() => {
      let sequence = 0;
      return { next: () => `id-${++sequence}` };
    })(),
    config: options.offline ? { offlinePlanFallback: true } : undefined,
  });
}

function withFakeLlm(core: SynapseCore): SynapseCore {
  core.workflow.providers = { ...core.workflow.providers, llm: new FakeLlm() };
  return core;
}

/** 取每道澄清题的第一个推荐答案作答，保证应答动作可重复。 */
function answersFor(response: StudyPilotRunResponse) {
  return (response.clarification?.questions ?? []).map((question) => ({
    questionId: question.id,
    answer: (question.suggestedAnswers.length ? question.suggestedAnswers : ["默认回答"])[0]!,
  }));
}

describe("健康检查与设置", () => {
  it("未配置 Key 时如实报告 mock 状态，图谱摘要反映空图谱", async () => {
    const core = makeCore();

    const health = await core.health();
    expect(health["status"]).toBe("healthy");
    expect(health["llm_provider"]).toBe("mock");
    expect(health["deepseek_enabled"]).toBe(false);

    expect((core.settingsStatus().data as Record<string, unknown>)["deepseek_configured"]).toBe(
      false,
    );

    // 新装即空：图谱摘要如实说明还没有任何节点，而不是虚报内置知识
    expect(core.getGraphSummary().data).toEqual({
      provider: "sql-kg",
      status: "ready",
      node_count: 0,
      edge_count: 0,
    });
  });
});

describe("画像 / 会话 / 计划落库", () => {
  it("画像读写：未设置时为空，保存后可读回", () => {
    const core = makeCore();
    expect(core.getProfile().data).toEqual({});

    const saved = core.saveProfile("default", "演示同学", "大二");
    expect(saved.success).toBe(true);
    expect((saved.data as Record<string, unknown>)["display_name"]).toBe("演示同学");
    expect((saved.data as Record<string, unknown>)["current_level"]).toBe("大二");
    expect((core.getProfile().data as Record<string, unknown>)["display_name"]).toBe("演示同学");
  });

  it("会话与消息 CRUD 后列表回到空", () => {
    const core = makeCore();
    expect(core.listConversations().data).toEqual([]);

    expect(core.saveConversation("conv-1", { title: "高数复习", planning_mode: "free" }).success).toBe(
      true,
    );
    const listed = core.listConversations().data as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!["id"]).toBe("conv-1");
    expect(listed[0]!["title"]).toBe("高数复习");

    expect(
      core.saveMessage("conv-1", "msg-1", {
        role: "user",
        content: "帮我准备高等数学期末考试",
      }).success,
    ).toBe(true);
    const messages = core.getMessages("conv-1").data as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!["role"]).toBe("user");
    expect(messages[0]!["content"]).toBe("帮我准备高等数学期末考试");

    expect(core.deleteConversation("conv-1").success).toBe(true);
    expect(core.listConversations().data).toEqual([]);
  });

  it("保存计划后版本号从 1 递增，进度按 task_key 落库", () => {
    const core = makeCore();
    const weeklyPlan = [
      {
        day_index: 1,
        focus: "演示焦点",
        tasks: [
          { title: "演示任务", task_type: "learn", duration_minutes: 45, reason: "演示理由" },
        ],
        carry_over: [],
      },
    ];

    const saved = core.savePlan("default", {
      message: "演示计划",
      plan: { weekly_plan: weeklyPlan },
      blockPlan: null,
    });
    expect(saved.success).toBe(true);
    expect((saved.data as Record<string, unknown>)["version"]).toBe(1);

    const current = core.getCurrentPlan().data as Record<string, unknown>;
    expect(current["version"]).toBe(1);
    expect(typeof current["updated_at"]).toBe("string");
    const plan = current["plan"] as Record<string, unknown>;
    expect(plan["message"]).toBe("演示计划");
    expect((plan["weekly_plan"] as Array<Record<string, unknown>>)[0]!["focus"]).toBe("演示焦点");

    const progress = core.updatePlanProgress({
      user_id: "default",
      conversation_id: "conv-1",
      plan_id: "",
      plan_version: null,
      task_key: "day-1::task-0",
      done: true,
      task_title: "演示任务",
      task_type: "learn",
      actual_minutes: 45,
      plan_message: "演示计划",
    });
    expect(progress.success).toBe(true);
    expect((progress.data as Record<string, unknown>)["task_progress"]).toEqual({
      "day-1::task-0": true,
    });
  });
});

describe("copilot run：自由模式", () => {
  it("mock 模型下走意图闸门，不硬造计划", async () => {
    const core = makeCore();
    const response = await core.run(RUN_PAYLOAD);

    expect(response.status).toBe("ready");
    expect(response.mode).toBe("intent-gate");
    expect(response.message.length).toBeGreaterThan(0);
    expect(response.plan).toBeNull();
    expect(response.clarification).toBeNull();
    expect(response.blockPlan).toBeNull();
    expect(response.model_provider).toBe("mock");
    expect(response.is_fallback).toBe(true);

    const normalized = (response.request as Record<string, unknown>)["normalized"] as Record<
      string,
      unknown
    >;
    expect(normalized["available_minutes_per_day"]).toBe(90);
    expect(normalized["learning_goal"]).toBe(RUN_PAYLOAD.input);
  });

  it("离线规划模式：先补齐关键约束再排计划", async () => {
    const core = makeCore({ offline: true });
    const response = await core.run(RUN_PAYLOAD);

    expect(response.status).toBe("needs_clarification");
    expect(response.mode).toBe("clarify-first");
    expect(response.model_provider).toBe("offline-rule");
    expect(response.plan).toBeNull();
    expect((response.clarification?.questions ?? []).map((question) => question.id)).toEqual([
      "deadline",
      "weak_points",
    ]);
  });
});

describe("copilot run：SSE 事件流", () => {
  it("先报阶段再给结果，最后一条 done 的结果与直接调用一致", async () => {
    const streamed = makeCore();
    const events: Array<{ type: string; label?: string; result?: unknown }> = [];
    for await (const event of streamed.runStream(RUN_PAYLOAD)) {
      events.push(event as { type: string; label?: string });
    }

    expect(events.length).toBeGreaterThan(1);
    expect(events[events.length - 1]!.type).toBe("done");
    for (const event of events.slice(0, -1)) {
      expect(event.type).toBe("stage");
      expect(String(event.label ?? "").length).toBeGreaterThan(0);
    }

    const direct = await makeCore().run(RUN_PAYLOAD);
    expect(events[events.length - 1]!.result).toEqual(direct);

    // SSE 线上格式：data: {json}\n\n
    const encoded = encodeSseEvent(events[events.length - 1] as never);
    expect(encoded.startsWith("data: ")).toBe(true);
    expect(encoded.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(encoded.slice(6, -2))).toEqual(events[events.length - 1]);
  });
});

describe("copilot run：自由模式的确认闭环", () => {
  it("确认澄清答案后产出计划，且检索上下文如实说明图谱为空", async () => {
    const core = withFakeLlm(makeCore());
    const payload: StudyPilotRunRequest = { ...RUN_PAYLOAD, input: PLAN_REQUEST_INPUT };

    const runResponse = await core.run(payload);
    expect(runResponse.status).toBe("needs_clarification");
    expect(runResponse.model_provider).toBe("deepseek");
    expect(runResponse.model_used).toBe("fake-llm-v0");
    expect(runResponse.is_fallback).toBe(false);

    const confirm = await core.confirm({
      sessionId: runResponse.clarification!.sessionId,
      answers: answersFor(runResponse),
    });

    expect(confirm.status).toBe("ready");
    expect(confirm.mode).toBe("backend-live");
    expect(confirm.clarification).toBeNull();
    expect(confirm.message).toBe("这是假模型给出的鼓励语。");
    expect(confirm.next_steps).toEqual(["建议一"]);

    const normalized = (confirm.request as Record<string, unknown>)["normalized"] as Record<
      string,
      unknown
    >;
    expect(normalized["deadline"]).toBe("这周内");
    expect(normalized["weak_points"]).toEqual(["基础概念不稳"]);

    const plan = confirm.plan!;
    expect(plan.weekly_plan[0]!.day_index).toBe(1);
    expect(plan.retrieved_context.join("\n")).toContain("当前已有 0 个节点、0 条边");
  });
});

describe("copilot run：积木模式的确认与展开", () => {
  it("确认后拿到 Day 1 积木，展开成周并沿用选中的积木风格", async () => {
    const core = withFakeLlm(makeCore());
    const payload: StudyPilotRunRequest = {
      ...RUN_PAYLOAD,
      input: PLAN_REQUEST_INPUT,
      planningMode: "blocks",
      mode: "blocks",
    };

    const runResponse = await core.run(payload);
    expect(runResponse.status).toBe("needs_clarification");
    expect(runResponse.blockPlan).toBeNull();

    const confirm = await core.confirm({
      sessionId: runResponse.clarification!.sessionId,
      answers: answersFor(runResponse),
    });
    expect(confirm.mode).toBe("blocks-co-create");
    const blockPlan = confirm.blockPlan!;
    expect(blockPlan.blocks.map((block) => block.id)).toEqual([
      "diagnosis",
      "core-study",
      "practice",
      "review",
    ]);
    // 澄清里给了「周末轻一点」的时间约束，应写进积木说明
    expect(blockPlan.description).toContain("已额外考虑你的时间约束：周末轻一点。");

    const normalized = (confirm.request as Record<string, unknown>)
      ["normalized"] as Parameters<SynapseCore["expandBlocks"]>[0];
    const expanded = await core.expandBlocks(normalized, blockPlan);

    expect(expanded.mode).toBe("blocks-expanded-week");
    expect(expanded.blockPlan).toBeNull();
    const weeklyPlan = expanded.plan!.weekly_plan;
    expect(weeklyPlan.length).toBeGreaterThan(1);
    expect(weeklyPlan[0]!.tasks).toHaveLength(4);
    // Day 1 直接来自积木的当前选中项
    expect(weeklyPlan[0]!.tasks.map((task) => task.title)).toEqual(
      blockPlan.blocks.map((block) => block.options[block.selectedIndex]!.title),
    );
  });
});
