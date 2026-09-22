/**
 * P2 验收测试：application/providers/storage 全流程输出与 baseline/golden 的
 * HTTP 黄金样本逐字一致。输入序列复制自 baseline/capture.py
 * （capture_http 全部步骤 + capture_fake 全部步骤，同一 store 顺序执行）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createSynapseCore } from "../src/application/core.js";
import type {
  GenerateWithToolsResult,
  LlmProvider,
} from "../src/providers/contracts.js";
import type {
  StudyPilotRunRequest,
  StudyPilotRunResponse,
} from "../src/protocol/frontend.js";
import type { BlockPlan, StudyPlanRequest } from "../src/protocol/study.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(HERE, "../../../baseline/golden");

function loadGolden(name: string): never {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, name), "utf-8")) as never;
}

/** 抹掉传输层 timestamp 字段（core 的 ApiResponse 不含该字段，由壳在传输时填充）。 */
function stripTimestamp(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripTimestamp);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "timestamp")
        .map(([key, v]) => [key, stripTimestamp(v)]),
    );
  }
  return value;
}

/** v2 新增字段：比对旧基线时剥离，证明旧行为未漂移；再单独断言新字段存在。 */
function stripV2PlanFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripV2PlanFields);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !["version", "updated_at", "change_summary"].includes(key))
        .map(([key, v]) => [key, stripV2PlanFields(v)]),
    );
  }
  return value;
}

const core = createSynapseCore({
  clock: { nowIso: () => "<timestamp>" },
  idGen: { next: () => "<uuid>" },
});

const RUN_PAYLOAD: StudyPilotRunRequest = {
  input: "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟",
  message: "",
  files: [],
  userProfile: { name: "基线同学", grade: "大二" },
  user_profile: null,
  planningMode: "free",
  mode: "free",
  memories: [],
};

const BLOCKS_PAYLOAD: StudyPilotRunRequest = { ...RUN_PAYLOAD, planningMode: "blocks" };

// 与 capture.py 的 FakeLLM 一致：describe 自称 deepseek，返回预设常量
const FAKE_PLAN_CONTENT = JSON.stringify({
  weekly_plan: [
    {
      day_index: 1,
      focus: "极限与连续",
      tasks: [
        { title: "梳理极限定义与判定条件", task_type: "learn", duration_minutes: 40, reason: "先建主干，后续练习不容易发散。" },
        { title: "限时完成一组极限计算题", task_type: "practice", duration_minutes: 50, reason: "用题目暴露真实薄弱环节。" },
      ],
    },
    {
      day_index: 2,
      focus: "导数应用",
      tasks: [
        { title: "复盘导数错题并补一个知识缺口", task_type: "review", duration_minutes: 30, reason: "避免只刷题不归纳。" },
        { title: "做一次导数应用限时小测", task_type: "mock_exam", duration_minutes: 60, reason: "验证计划是否覆盖关键问题。" },
      ],
    },
  ],
  final_message: "这是基线假模型给出的鼓励语，用于固定响应形状。",
  next_actions: ["基线建议一", "基线建议二"],
});

class FakeLlm implements LlmProvider {
  constructor(private readonly toolName = "create_plan", private readonly text = FAKE_PLAN_CONTENT) {}

  describe(): Record<string, unknown> {
    return { provider: "deepseek", model: "fake-llm-v0", status: "ready" };
  }

  async generateWithTools(
    _prompt: string,
    _tools: unknown[],
    forceTool = "",
  ): Promise<GenerateWithToolsResult> {
    const name = forceTool || this.toolName;
    const args =
      name === "create_plan" ? { goal: "准备高等数学期末考试", subject: "高等数学" } : {};
    return { tool_calls: [{ name, args }] };
  }

  async generateText(_prompt: string): Promise<string> {
    return this.text;
  }

  async generateJson(_prompt: string): Promise<Record<string, unknown>> {
    return JSON.parse(this.text) as Record<string, unknown>;
  }

  async *streamText(_prompt: string): AsyncIterable<string> {
    yield this.text.slice(0, 20);
    yield this.text.slice(20);
  }
}

function answersFor(response: StudyPilotRunResponse) {
  return (response.clarification?.questions ?? []).map((q) => ({
    questionId: q.id,
    answer: (q.suggestedAnswers.length ? q.suggestedAnswers : ["基线回答"])[0]!,
  }));
}

describe("http golden 回放（capture_http 序列）", () => {
  it("http_core.json：health / settings/status / knowledge-graph/summary", async () => {
    const golden = loadGolden("http_core.json");
    const actual = [
      { name: "GET /api/v1/health", json: { success: true, message: "ok", data: await core.health() } },
      { name: "GET /api/v1/settings/status", json: core.settingsStatus() },
      { name: "GET /api/v1/copilot/knowledge-graph/summary", json: core.getGraphSummary() },
    ];
    expect(stripTimestamp(actual.map((s) => s.json))).toEqual(
      stripTimestamp((golden as Array<{ json: unknown }>).slice(1).map((s) => s.json)),
    );
  });

  it("http_profile.json：画像读写", () => {
    const golden = loadGolden("http_profile.json") as Array<{ json: unknown }>;
    const actual = [
      core.getProfile(),
      core.saveProfile("default", "基线同学", "大二"),
      core.getProfile(),
    ];
    expect(stripTimestamp(actual)).toEqual(stripTimestamp(golden.map((s) => s.json)));
  });

  it("http_conversations.json：会话与消息 CRUD", () => {
    const golden = loadGolden("http_conversations.json") as Array<{ json: unknown }>;
    const actual = [
      core.listConversations(),
      core.saveConversation("conv-baseline-1", { title: "高数复习", planning_mode: "free" }),
      core.listConversations(),
      core.saveMessage("conv-baseline-1", "msg-baseline-1", {
        role: "user",
        content: "帮我准备高等数学期末考试",
      }),
      core.getMessages("conv-baseline-1"),
      core.deleteConversation("conv-baseline-1"),
      core.listConversations(),
    ];
    expect(stripTimestamp(actual)).toEqual(stripTimestamp(golden.map((s) => s.json)));
  });

  it("http_copilot_run_free.json：自由模式（mock LLM）", async () => {
    const golden = loadGolden("http_copilot_run_free.json") as Array<{ json: unknown }>;
    const actual = await core.run(RUN_PAYLOAD);
    expect(stripTimestamp([actual])).toEqual(stripTimestamp(golden.map((s) => s.json)));
  });

  it("http_copilot_run_stream.json：SSE 事件序列（mock LLM）", async () => {
    const golden = loadGolden("http_copilot_run_stream.json") as { events: unknown };
    const events = [];
    for await (const event of core.runStream(RUN_PAYLOAD)) {
      events.push(event);
    }
    expect(stripTimestamp(events)).toEqual(stripTimestamp(golden.events));
  });

  it("http_blocks_flow.json：积木模式 run（mock LLM，无 clarification）", async () => {
    const golden = loadGolden("http_blocks_flow.json") as Array<{ json?: unknown; skipped?: string }>;
    const actual = await core.run(BLOCKS_PAYLOAD);
    expect(stripTimestamp([actual])).toEqual(stripTimestamp([golden[0]!.json]));
    expect(actual.clarification).toBeNull();
    expect(golden[1]!.skipped).toBe("run 响应无 clarification");
  });

  it("http_plan_storage.json：save → current → progress", () => {
    const golden = loadGolden("http_plan_storage.json") as Array<{ json: unknown }>;
    const weeklyPlan = [
      {
        day_index: 1,
        focus: "基线焦点",
        tasks: [
          { title: "基线任务", task_type: "learn", duration_minutes: 45, reason: "基线理由" },
        ],
        carry_over: [],
      },
    ];
    const actual = [
      core.savePlan("default", {
        message: "基线计划",
        plan: { weekly_plan: weeklyPlan },
        blockPlan: null,
      }),
      core.getCurrentPlan(),
      core.updatePlanProgress({
        user_id: "default",
        conversation_id: "conv-baseline-1",
        plan_id: "",
        plan_version: null,
        task_key: "day-1::task-0",
        done: true,
        task_title: "基线任务",
        task_type: "learn",
        actual_minutes: 45,
        plan_message: "基线计划",
      }),
    ];
    expect(stripV2PlanFields(stripTimestamp(actual))).toEqual(
      stripV2PlanFields(stripTimestamp(golden.map((s) => s.json))),
    );
    // v2：新增版本号，首次保存即第 1 版
    const saveData = actual[0]!.data as Record<string, unknown>;
    const currentData = actual[1]!.data as Record<string, unknown>;
    expect(saveData["version"]).toBe(1);
    expect(currentData["version"]).toBe(1);
    expect(typeof currentData["updated_at"]).toBe("string");
  });
});

describe("http golden 回放（capture_fake 序列，FakeLLM 注入）", () => {
  it("http_fake_free_flow.json：run → confirm", async () => {
    core.workflow.providers = { ...core.workflow.providers, llm: new FakeLlm() };
    const golden = loadGolden("http_fake_free_flow.json") as Array<{ json?: unknown; skipped?: string }>;

    const runPayload: StudyPilotRunRequest = {
      ...RUN_PAYLOAD,
      input: "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟，给我制定计划",
    };
    const runResp = await core.run(runPayload);
    expect(stripTimestamp([runResp])).toEqual(stripTimestamp([golden[0]!.json]));

    const confirmResp = await core.confirm({
      sessionId: runResp.clarification!.sessionId,
      answers: answersFor(runResp),
    });
    expect(stripTimestamp([confirmResp])).toEqual(stripTimestamp([golden[1]!.json]));
  });

  it("http_fake_blocks_flow.json：run → confirm → expand-blocks", async () => {
    const golden = loadGolden("http_fake_blocks_flow.json") as Array<{ json?: unknown }>;
    const blocksPayload: StudyPilotRunRequest = {
      ...RUN_PAYLOAD,
      input: "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟，给我制定计划",
      planningMode: "blocks",
    };
    const runResp = await core.run(blocksPayload);
    expect(stripTimestamp([runResp])).toEqual(stripTimestamp([golden[0]!.json]));

    const confirmResp = await core.confirm({
      sessionId: runResp.clarification!.sessionId,
      answers: answersFor(runResp),
    });
    expect(stripTimestamp([confirmResp])).toEqual(stripTimestamp([golden[1]!.json]));

    const normalized = (confirmResp.request as Record<string, unknown>)["normalized"] as StudyPlanRequest;
    const blockPlan = confirmResp.blockPlan as BlockPlan;
    const expandResp = await core.expandBlocks(normalized, blockPlan);
    expect(stripTimestamp([expandResp])).toEqual(stripTimestamp([golden[2]!.json]));
  });

  it("http_fake_run_stream.json：SSE 事件序列（FakeLLM）", async () => {
    const golden = loadGolden("http_fake_run_stream.json") as { events: unknown };
    const runPayload: StudyPilotRunRequest = {
      ...RUN_PAYLOAD,
      input: "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟，给我制定计划",
    };
    const events = [];
    for await (const event of core.runStream(runPayload)) {
      events.push(event);
    }
    expect(stripTimestamp(events)).toEqual(stripTimestamp(golden.events));
  });
});
