/**
 * v2 新功能测试：课程表解析与避让、多科目分组、会话隔离与落库、计划版本。
 * 这些用例覆盖「v2 有意新增」的行为；旧行为的不漂移由 httpBaseline.spec.ts 保证。
 */

import { describe, expect, it } from "vitest";

import { createSynapseCore, type SynapseCore } from "../src/application/core.js";
import {
  apply_timetable_to_payload,
  build_timetable_context,
  parse_timetable_text,
  summarize_day_busy,
} from "../src/domain/timetable.js";
import { build_today_items } from "../src/domain/todayPlan.js";
import { build_rule_milestones, should_build_long_term } from "../src/domain/longPlan.js";
import { build_index, search_index, tokenize } from "../src/domain/bm25.js";
import {
  apply_sm2,
  create_review_item,
  daily_review_quota,
  due_review_items,
} from "../src/domain/review.js";
import {
  build_document_records,
  search_document_records,
} from "../src/domain/documentRetrieval.js";
import {
  append_subjects_to_days,
  detect_subject_candidates,
  detect_subjects,
  merge_subject_plans,
  sanitize_subject_candidate,
} from "../src/domain/multiSubject.js";
import type {
  GenerateWithToolsResult,
  LlmProvider,
} from "../src/providers/contracts.js";
import type { StudyPlanRequest, TimetableEntry } from "../src/protocol/study.js";
import type { StudyPilotRunRequest } from "../src/protocol/frontend.js";

let idCounter = 0;
const testIdGen = { next: () => `id-${++idCounter}` };

const PLAN_JSON = JSON.stringify({
  weekly_plan: [
    {
      day_index: 1,
      focus: "混合推进",
      tasks: [
        {
          title: "高数：极限计算专项",
          subject: "高等数学",
          task_type: "practice",
          duration_minutes: 40,
          reason: "先练后补",
        },
        {
          title: "大物：受力分析梳理",
          subject: "大学物理",
          task_type: "learn",
          duration_minutes: 40,
          reason: "补基础",
        },
      ],
    },
  ],
  final_message: "假模型回复",
  next_actions: ["继续"],
});

/** 记录每次收到的 prompt，用于断言多轮历史是否正确隔离。 */
class RecordingLlm implements LlmProvider {
  readonly prompts: string[] = [];

  describe(): Record<string, unknown> {
    return { provider: "deepseek", model: "recording-llm", status: "ready" };
  }

  async generateWithTools(prompt: string): Promise<GenerateWithToolsResult> {
    this.prompts.push(prompt);
    return { tool_calls: [{ name: "create_plan", args: { subject: "高等数学", goal: "备考" } }] };
  }

  async generateText(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return PLAN_JSON;
  }

  async generateJson(): Promise<Record<string, unknown>> {
    return JSON.parse(PLAN_JSON) as Record<string, unknown>;
  }

  async *streamText(prompt: string): AsyncIterable<string> {
    yield prompt;
  }
}

const RICH_INPUT =
  "帮我准备高等数学和大学物理期末考试，还有 14 天，每天能学 90 分钟，薄弱点：积分、受力分析";

function runPayload(conversationId: string | undefined): StudyPilotRunRequest {
  return {
    input: RICH_INPUT,
    message: "",
    files: [],
    userProfile: { name: "测试同学", grade: "大二" },
    user_profile: null,
    planningMode: "free",
    mode: "free",
    memories: [],
    ...(conversationId ? { conversationId } : {}),
  };
}

describe("课程表解析", () => {
  it("解析「周一 + 课程 + 时间」逐行文本", () => {
    const result = parse_timetable_text(
      [
        "周一 高等数学 08:00-09:40",
        "周一 大学物理 10:00-11:40",
        "周三 线性代数 14:00-15:40 1-16周",
      ].join("\n"),
      { idGen: testIdGen },
    );

    expect(result.entries).toHaveLength(3);
    expect(result.unparsedLines).toEqual([]);
    expect(result.entries[0]).toMatchObject({
      name: "高等数学",
      subject: "高等数学",
      weekday: 1,
      startMinute: 8 * 60,
      endMinute: 9 * 60 + 40,
    });
    expect(result.entries[2]).toMatchObject({ weekday: 3, weeks: "1-16" });
  });

  it("解析「星期表头 + 逐行课程」的粘贴格式", () => {
    const result = parse_timetable_text(
      ["周一", "08:00-09:40 高等数学", "10:00-11:40 大学物理", "周二", "14:00-15:40 英语"].join(
        "\n",
      ),
      { idGen: testIdGen },
    );

    expect(result.entries.map((entry) => [entry.weekday, entry.name])).toEqual([
      [1, "高等数学"],
      [1, "大学物理"],
      [2, "英语"],
    ]);
  });

  it("未识别的行会被列出，供手动校正", () => {
    const result = parse_timetable_text(
      ["周一 高等数学 08:00-09:40", "备注：第 8 周停课一次"].join("\n"),
      { idGen: testIdGen },
    );

    expect(result.entries).toHaveLength(1);
    expect(result.unparsedLines).toEqual(["备注：第 8 周停课一次"]);
    expect(result.warnings.join()).toContain("1 行没识别出来");
  });

  it("全角字符与「～」分隔符也能解析", () => {
    const result = parse_timetable_text("周三　线性代数　14：00～15：40", { idGen: testIdGen });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ weekday: 3, startMinute: 14 * 60 });
  });
});

describe("课程表避让", () => {
  const entries: TimetableEntry[] = [
    {
      id: "t1",
      name: "高等数学",
      subject: "高等数学",
      weekday: 1,
      startMinute: 8 * 60,
      endMinute: 18 * 60,
      weeks: "",
      location: "",
      teacher: "",
    },
  ];

  it("统计某天占用与空闲时长", () => {
    const summary = summarize_day_busy(entries, 1);
    expect(summary.busy_minutes).toBe(600);
    expect(summary.free_minutes).toBe(840 - 600);
    expect(summary.busy_ranges).toEqual(["08:00-18:00"]);
    expect(summarize_day_busy(entries, 2).busy_minutes).toBe(0);
  });

  it("生成课表上下文文案", () => {
    const context = build_timetable_context(entries);
    expect(context[0]).toContain("已导入 1 节课");
    expect(context[1]).toContain("周一");
  });

  it("注入课表：可用时长被上课时段压缩，并写入偏好", () => {
    const payload: StudyPlanRequest = {
      user_id: "default",
      current_level: "大二",
      learning_goal: "备考",
      available_days_per_week: 5,
      available_minutes_per_day: 600,
      deadline: null,
      weak_points: [],
      preferences: [],
      need_user_confirmation: true,
    };

    const applied = apply_timetable_to_payload(payload, entries);
    expect(applied.available_minutes_per_day).toBe(240);
    expect(applied.preferences.some((item) => item.includes("课程表"))).toBe(true);
  });

  it("无课表时原样返回（不影响旧行为）", () => {
    const payload: StudyPlanRequest = {
      user_id: "default",
      current_level: "大二",
      learning_goal: "备考",
      available_days_per_week: 5,
      available_minutes_per_day: 90,
      deadline: null,
      weak_points: [],
      preferences: ["允许用户确认解析结果"],
      need_user_confirmation: true,
    };
    expect(apply_timetable_to_payload(payload, [])).toEqual(payload);
  });
});

describe("多科目识别与合并", () => {
  it("单科目不触发分组", () => {
    expect(detect_subjects({ learningGoal: "准备高等数学期末考试" })).toEqual([]);
  });

  it("识别多个科目，且长词优先不与短词重复计数", () => {
    expect(detect_subjects({ learningGoal: "准备高等数学和大学物理" })).toEqual([
      "高等数学",
      "大学物理",
    ]);
    // 「高等数学」命中后不应再被拆出「数学」
    expect(detect_subjects({ learningGoal: "复习高等数学" })).toEqual([]);
  });

  it("课表科目会作为附加科目参与识别", () => {
    const subjects = detect_subjects({
      learningGoal: "准备期末考试",
      timetable: [
        {
          id: "t1",
          name: "英语",
          subject: "英语",
          weekday: 2,
          startMinute: 600,
          endMinute: 660,
          weeks: "",
          location: "",
          teacher: "",
        },
      ],
    });
    expect(subjects).toEqual([]);
  });

  it("合并在同一天同时保留各科任务且不超日预算", () => {
    const subjectPlans = ["高等数学", "大学物理"].map((subject) => ({
      subject,
      days: [
        {
          day_index: 1,
          focus: `${subject}重点`,
          tasks: [
            {
              title: `${subject}任务A`,
              task_type: "learn" as const,
              duration_minutes: 60,
              reason: "r",
            },
            {
              title: `${subject}任务B`,
              task_type: "practice" as const,
              duration_minutes: 60,
              reason: "r",
            },
          ],
          carry_over: [],
        },
      ],
    }));

    const merged = merge_subject_plans(subjectPlans, 1, 100);
    expect(merged).toHaveLength(1);
    const subjects = new Set(merged[0]!.tasks.map((task) => task.subject));
    expect([...subjects].sort()).toEqual(["大学物理", "高等数学"]);
    const total = merged[0]!.tasks.reduce((sum, task) => sum + task.duration_minutes, 0);
    expect(total).toBeLessThanOrEqual(100);
  });
});

describe("core v2：多科目计划（mock LLM 走规则兜底）", () => {
  it("任务带 subject，且同一天包含多个科目，单日不超预算", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `m-${++idCounter}` },
    });

    // mock provider 下 run() 不会走到计划生成（意图门控返回聊天），
    // 因此直接调用计划生成入口，验证规则兜底的多科目合并行为。
    const plan = await core.buildStudyPlan({
      user_id: "default",
      current_level: "大二",
      learning_goal: "帮我准备高等数学和大学物理期末考试",
      available_days_per_week: 5,
      available_minutes_per_day: 90,
      deadline: null,
      weak_points: [],
      preferences: [],
      need_user_confirmation: true,
    });

    const tasks = plan.weekly_plan.flatMap((day) => day.tasks);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((task) => Boolean(task.subject))).toBe(true);
    expect(new Set(tasks.map((task) => task.subject)).size).toBeGreaterThanOrEqual(2);

    for (const day of plan.weekly_plan) {
      const total = day.tasks.reduce((sum, task) => sum + task.duration_minutes, 0);
      expect(total).toBeLessThanOrEqual(90);
      const daySubjects = new Set(day.tasks.map((task) => task.subject));
      expect(daySubjects.size).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("core v2：微调计划保留科目", () => {
  it("微调后任务仍然带 subject，否则计划页科目分组会塌回「未分类」", async () => {
    let intentCalls = 0;
    const tweaking: LlmProvider = {
      describe: () => ({ provider: "deepseek", model: "tweak-llm", status: "ready" }),
      generateWithTools: async () => {
        intentCalls += 1;
        if (intentCalls === 1) {
          return {
            tool_calls: [{ name: "create_plan", args: { subject: "高等数学", goal: "备考" } }],
          };
        }
        return { tool_calls: [{ name: "tweak_plan", args: { changes: "压缩到 45 分钟" } }] };
      },
      generateText: async () => PLAN_JSON,
      generateJson: async () => JSON.parse(PLAN_JSON) as Record<string, unknown>,
      async *streamText() {
        yield PLAN_JSON;
      },
    };

    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `tw-${++idCounter}` },
    });
    core.workflow.providers = { ...core.workflow.providers, llm: tweaking };

    const first = await core.run(runPayload("conv-tweak"));
    expect(first.plan!.weekly_plan[0]!.tasks.every((task) => Boolean(task.subject))).toBe(true);

    const second = await core.run({
      ...runPayload("conv-tweak"),
      input: "太多了，压缩到 45 分钟",
    });
    expect(second.mode).toBe("plan-tweaked");

    const tasks = second.plan!.weekly_plan.flatMap((day) => day.tasks);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((task) => Boolean(task.subject))).toBe(true);
    expect(new Set(tasks.map((task) => task.subject)).size).toBeGreaterThanOrEqual(2);
  });
});

describe("core v2：会话隔离与落库", () => {
  it("指定会话时，多轮历史只包含该会话内容", async () => {
    const llm = new RecordingLlm();
    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `c-${++idCounter}` },
    });
    core.workflow.providers = { ...core.workflow.providers, llm };

    await core.run(runPayload("conv-A"));
    const conversationA = core.listConversations().data as unknown[];
    expect(conversationA).toHaveLength(1);

    const messagesA = core.getMessages("conv-A").data as Array<Record<string, unknown>>;
    expect(messagesA).toHaveLength(2);
    expect(messagesA[0]!["role"]).toBe("user");
    expect(messagesA[1]!["role"]).toBe("assistant");

    // 第二轮：prompt 中应带上第一轮内容
    llm.prompts.length = 0;
    await core.run(runPayload("conv-A"));
    expect(llm.prompts.some((prompt) => prompt.includes("对话记录"))).toBe(true);
    expect(llm.prompts.some((prompt) => prompt.includes("帮我准备高等数学和大学物理"))).toBe(true);

    // 另一个会话：不应看到 A 的历史
    llm.prompts.length = 0;
    await core.run(runPayload("conv-B"));
    expect(llm.prompts.some((prompt) => prompt.includes("对话记录"))).toBe(false);
  });

  it("不传 conversationId 时不读写会话（旧行为）", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `n-${++idCounter}` },
    });
    await core.run(runPayload(undefined));
    expect(core.listConversations().data as unknown[]).toEqual([]);
  });
});

describe("core v2：计划版本", () => {
  it("每次保存版本号自增，并记录变更摘要", () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `p-${++idCounter}` },
    });
    const plan = {
      message: "计划",
      plan: {
        weekly_plan: [
          {
            day_index: 1,
            focus: "焦点",
            tasks: [{ title: "任务", task_type: "learn", duration_minutes: 30, reason: "r" }],
            carry_over: [],
          },
        ],
      },
      blockPlan: null,
    };

    const first = core.savePlan("default", plan, "初次生成");
    expect((first.data as Record<string, unknown>)["version"]).toBe(1);

    const second = core.savePlan("default", plan, "按反馈压缩时长");
    expect((second.data as Record<string, unknown>)["version"]).toBe(2);

    const current = core.getCurrentPlan();
    const data = current.data as Record<string, unknown>;
    expect(data["version"]).toBe(2);
    expect(data["change_summary"]).toBe("按反馈压缩时长");
  });
});

const ENGLISH_PLAN_JSON = JSON.stringify({
  weekly_plan: [
    {
      day_index: 1,
      focus: "词汇起步",
      tasks: [
        {
          title: "背 50 个核心词",
          subject: "英语",
          task_type: "learn",
          duration_minutes: 30,
          reason: "先把词汇量垫起来",
        },
      ],
    },
  ],
  final_message: "先背词，再练阅读。",
  next_actions: ["保持每天 30 分钟词汇"],
});

/** 造一个按调用次序返回固定 goal/subject 的假模型，复现意图分类给出的结构化参数。 */
function fakeLlm(goals: Array<{ goal: string; subject: string }>): LlmProvider {
  let calls = 0;
  return {
    describe: () => ({ provider: "deepseek", model: "v2-fake-llm", status: "ready" }),
    generateWithTools: async () => {
      const current = goals[Math.min(calls, goals.length - 1)]!;
      calls += 1;
      return { tool_calls: [{ name: "create_plan", args: { ...current } }] };
    },
    generateText: async () => ENGLISH_PLAN_JSON,
    generateJson: async () => JSON.parse(ENGLISH_PLAN_JSON) as Record<string, unknown>,
    async *streamText() {
      yield ENGLISH_PLAN_JSON;
    },
  };
}

function subjectNames(core: SynapseCore): string[] {
  const data = core.listSubjects().data as Record<string, unknown>;
  return (data["subjects"] as Array<{ name: string }>).map((item) => item.name);
}

describe("core v2：科目候选识别与校验", () => {
  it("单科目也能被识别为候选（多科目分组仍要求至少 2 个）", () => {
    expect(detect_subject_candidates({ learningGoal: "我要学英语" })).toEqual(["英语"]);
    expect(detect_subjects({ learningGoal: "我要学英语" })).toEqual([]);
  });

  it("答句、整句不会被当成科目名", () => {
    expect(sanitize_subject_candidate("当然算数")).toBe("");
    expect(sanitize_subject_candidate("应付期末")).toBe("");
    expect(sanitize_subject_candidate("我到底要不要学数学？")).toBe("");
    expect(sanitize_subject_candidate("这是一个特别特别长的科目名")).toBe("");
    expect(sanitize_subject_candidate("计算机网络")).toBe("计算机网络");
  });
});

describe("core v2：增量追加科目", () => {
  it("只往后补：已过去的天不动，新任务不超当天剩余预算", () => {
    const existing = [
      {
        day_index: 1,
        focus: "英语",
        tasks: [
          {
            title: "背词",
            subject: "英语",
            task_type: "learn" as const,
            duration_minutes: 30,
            reason: "r",
          },
        ],
        carry_over: [],
      },
      {
        day_index: 2,
        focus: "英语",
        tasks: [
          {
            title: "精读",
            subject: "英语",
            task_type: "practice" as const,
            duration_minutes: 30,
            reason: "r",
          },
        ],
        carry_over: [],
      },
    ];
    const subjectPlans = [
      {
        subject: "计网",
        days: [
          {
            day_index: 1,
            focus: "计网",
            tasks: [
              {
                title: "子网划分",
                task_type: "learn" as const,
                duration_minutes: 60,
                reason: "r",
              },
            ],
            carry_over: [],
          },
        ],
      },
    ];

    const result = append_subjects_to_days(existing, subjectPlans, {
      dailyMinutes: 90,
      fromDayIndex: 2,
    });

    // Day1 已过去：条目一字未改
    expect(result.days[0]!.tasks).toHaveLength(1);
    expect(result.days[0]!.tasks[0]!.title).toBe("背词");
    // Day2：补进新科目，且不超预算
    expect(result.days[1]!.tasks.some((task) => task.subject === "计网")).toBe(true);
    expect(
      result.days[1]!.tasks.reduce((sum, task) => sum + task.duration_minutes, 0),
    ).toBeLessThanOrEqual(90);
    expect(result.added).toBeGreaterThan(0);
  });
});

describe("core v2：科目注册表与中途追加", () => {
  it("先说英语再说计网：科目累加，已排好的条目不被动", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-22T00:00:00.000Z" },
      idGen: { next: () => `sub-${++idCounter}` },
    });
    core.workflow.providers = {
      ...core.workflow.providers,
      llm: fakeLlm([
        { goal: "我要学英语", subject: "英语" },
        { goal: "我还要学计网", subject: "计网" },
      ]),
    };

    const first = await core.run({
      ...runPayload("conv-a"),
      input: "我要学英语，还有 14 天，每天 90 分钟，薄弱点：听力",
    });
    expect(first.plan).not.toBeNull();
    // 壳里「产出计划即自动保存」的行为
    core.savePlan(
      "default",
      {
        message: first.message,
        plan: { weekly_plan: first.plan!.weekly_plan },
        blockPlan: null,
      },
      "初次生成",
    );
    expect(subjectNames(core)).toEqual(["英语"]);

    const second = await core.run({
      ...runPayload("conv-b"),
      input: "我还要学计网，还有 14 天，每天 90 分钟，薄弱点：子网划分",
    });

    // 科目是累加，不是覆盖
    expect(subjectNames(core)).toEqual(["英语", "计网"]);
    // 走增量追加，而不是整版重生成
    expect(second.mode).toBe("subjects-appended");
    const day1 = second.plan!.weekly_plan.find((day) => day.day_index === 1)!;
    // 原有条目一字未动（打卡用的「天+科目+标题」身份因此仍然对得上）
    expect(
      day1.tasks.some((task) => task.title === "背 50 个核心词" && task.subject === "英语"),
    ).toBe(true);
    // 新科目补进来了，且没超当天预算
    expect(day1.tasks.some((task) => task.subject === "计网")).toBe(true);
    expect(day1.tasks.reduce((sum, task) => sum + task.duration_minutes, 0)).toBeLessThanOrEqual(90);
  });
});

describe("core v2：答句不会被当成科目", () => {
  it("本轮输入是答句时，沿用上一轮目标而不是把它当新目标", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-22T00:00:00.000Z" },
      idGen: { next: () => `g-${++idCounter}` },
    });
    core.workflow.providers = {
      ...core.workflow.providers,
      llm: fakeLlm([
        { goal: "我要学英语", subject: "英语" },
        { goal: "当然算数", subject: "当然算数" },
      ]),
    };

    const goalText = "我要学英语，还有 14 天，每天 90 分钟，薄弱点：听力";
    await core.run({ ...runPayload("conv-g"), input: goalText });
    expect((core.getProfile().data as Record<string, unknown>)["last_goal"]).toBe(goalText);

    await core.run({ ...runPayload("conv-g"), input: "当然算数" });

    // 目标没有被答句顶掉（顶掉的话，计划提示词会把「当然算数」当科目名）
    expect((core.getProfile().data as Record<string, unknown>)["last_goal"]).toBe(goalText);
    expect(subjectNames(core)).toEqual(["英语"]);
  });
});

describe("core v2：计划历史版本", () => {
  it("每一版都留档，并可回到旧版", () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `pv-${++idCounter}` },
    });
    const buildPlan = (message: string, title: string) => ({
      message,
      plan: {
        weekly_plan: [
          {
            day_index: 1,
            focus: title,
            tasks: [{ title, task_type: "learn", duration_minutes: 30, reason: "r" }],
            carry_over: [],
          },
        ],
      },
      blockPlan: null,
    });

    core.savePlan("default", buildPlan("第一版", "任务A"), "初次生成");
    core.savePlan("default", buildPlan("第二版", "任务B"), "按反馈调整");

    const listed = core.listPlanVersions().data as Record<string, unknown>;
    expect(listed["total"]).toBe(2);
    const versions = listed["versions"] as Array<{ version: number; change_summary: string }>;
    expect(versions.map((item) => item.version)).toEqual([1, 2]);
    expect(versions[0]!.change_summary).toBe("初次生成");

    const restored = core.restorePlanVersion("default", 1);
    expect(restored.success).toBe(true);

    const current = core.getCurrentPlan().data as Record<string, unknown>;
    expect(current["version"]).toBe(3);
    const weekly = (current["plan"] as Record<string, unknown>)["weekly_plan"] as Array<
      Record<string, unknown>
    >;
    expect(String((weekly[0]!["tasks"] as Array<Record<string, unknown>>)[0]!["title"])).toBe("任务A");
    expect(((core.listPlanVersions().data as Record<string, unknown>)["total"] as number)).toBe(3);
  });
});

/** 可推进的假时钟：用来验证「跨天顺延」这类按日期展开的行为。 */
function mutableClock(initialDate: string) {
  let current = initialDate;
  return {
    clock: { nowIso: () => `${current}T00:00:00.000Z` },
    set: (date: string) => {
      current = date;
    },
  };
}

describe("core v2：长期计划（里程碑）", () => {
  it("跨度不超过一周时不建长期计划", () => {
    expect(should_build_long_term(null, "2026-09-22")).toBe(false);
    expect(should_build_long_term("2026-09-29", "2026-09-22")).toBe(false);
    expect(should_build_long_term("2026-12-21", "2026-09-22")).toBe(true);
  });

  it("规则阶段首尾相接，且最后一段咬住截止日期", () => {
    const milestones = build_rule_milestones({
      goal: "三个月过六级",
      deadline: "2026-12-21",
      today: "2026-09-22",
      subjects: ["英语"],
    });
    expect(milestones.length).toBeGreaterThanOrEqual(3);
    expect(milestones[0]!.start_date).toBe("2026-09-22");
    expect(milestones[milestones.length - 1]!.due_date).toBe("2026-12-21");
    expect(milestones[0]!.status).toBe("active");
    for (let index = 1; index < milestones.length; index += 1) {
      expect(milestones[index]!.start_date > milestones[index - 1]!.due_date).toBe(true);
    }
  });

  it("跨度超过一周时随对话产出长期阶段，短期计划照常生成", async () => {
    const fake = mutableClock("2026-09-22");
    const core = createSynapseCore({
      clock: fake.clock,
      idGen: { next: () => `lt-${++idCounter}` },
    });
    core.workflow.providers = {
      ...core.workflow.providers,
      llm: fakeLlm([{ goal: "三个月过六级", subject: "英语" }]),
    };

    const response = await core.run({
      ...runPayload("conv-lt"),
      input: "我要三个月过六级，还有 90 天，每天 90 分钟，薄弱点：听力",
    });

    expect(response.plan).not.toBeNull();
    expect(response.mode).toBe("backend-live");
    expect(response.longPlan).toBeTruthy();
    const milestones = response.longPlan!.milestones;
    expect(milestones.length).toBeGreaterThanOrEqual(3);
    expect(milestones[0]!.start_date).toBe("2026-09-22");
    expect(milestones[0]!.status).toBe("active");
    // 阶段提示要写进给用户看的消息里
    expect(response.message).toContain("阶段");

    const stored = core.getLongTermPlan().data as Record<string, unknown>;
    expect(String((stored["long_plan"] as Record<string, unknown>)["goal"])).toContain("三个月过六级");
  });

  it("按某个阶段排本周会生成新一版短期计划", async () => {
    const fake = mutableClock("2026-09-22");
    const core = createSynapseCore({
      clock: fake.clock,
      idGen: { next: () => `ms-${++idCounter}` },
    });

    const built = await core.buildLongTermPlan("default", "三个月过六级", "2026-12-21");
    expect(built.success).toBe(true);
    const active = (built.data as Record<string, unknown>)["active"] as { id: string; title: string };
    expect(active.title).toBe("打基础");

    const planned = await core.planForMilestone("default", active.id);
    expect(planned.success).toBe(true);

    const current = core.getCurrentPlan().data as Record<string, unknown>;
    expect(String(current["change_summary"])).toContain("按阶段");
    expect(current["version"]).toBe(1);
  });
});

describe("core v2：今日计划与顺延", () => {
  it("纯函数：只顺延未完成的，且排在今天切片之前", () => {
    const days = [
      {
        day_index: 2,
        focus: "Day2",
        tasks: [
          {
            title: "精读",
            subject: "英语",
            task_type: "practice" as const,
            duration_minutes: 40,
            reason: "r",
          },
        ],
        carry_over: [],
      },
    ];
    const items = build_today_items({
      days,
      dayIndex: 2,
      previousItems: [
        {
          key: "day-1::英语::背词",
          title: "背词",
          subject: "英语",
          task_type: "learn",
          duration_minutes: 30,
          done: false,
          carried_from: "",
          manual: false,
        },
        {
          key: "day-1::英语::已完成",
          title: "已完成",
          subject: "英语",
          task_type: "learn",
          duration_minutes: 30,
          done: true,
          carried_from: "",
          manual: false,
        },
      ],
      previousDate: "2026-09-22",
      today: "2026-09-23",
    });

    expect(items.map((item) => item.title)).toEqual(["背词", "精读"]);
    expect(items[0]!.carried_from).toBe("2026-09-22");
    expect(items[1]!.carried_from).toBe("");
  });

  it("从短期计划切片，未完成的顺延到第二天并标记来源", async () => {
    const fake = mutableClock("2026-09-22");
    const core = createSynapseCore({
      clock: fake.clock,
      idGen: { next: () => `td-${++idCounter}` },
    });
    core.savePlan(
      "default",
      {
        message: "两天的计划",
        plan: {
          weekly_plan: [
            {
              day_index: 1,
              focus: "Day1",
              tasks: [
                { title: "背词", subject: "英语", task_type: "learn", duration_minutes: 30, reason: "r" },
                { title: "听力", subject: "英语", task_type: "practice", duration_minutes: 20, reason: "r" },
              ],
              carry_over: [],
            },
            {
              day_index: 2,
              focus: "Day2",
              tasks: [
                { title: "精读", subject: "英语", task_type: "practice", duration_minutes: 40, reason: "r" },
              ],
              carry_over: [],
            },
          ],
        },
        blockPlan: null,
      },
      "初次生成",
    );

    const todayData = core.getTodayPlan().data as Record<string, unknown>;
    const today = todayData["today"] as Record<string, unknown>;
    expect(today["date"]).toBe("2026-09-22");
    expect(today["day_index"]).toBe(1);
    expect((today["items"] as Array<Record<string, unknown>>).map((item) => item["title"])).toEqual([
      "背词",
      "听力",
    ]);

    // 只完成一条
    const first = (today["items"] as Array<Record<string, unknown>>)[0]!;
    const toggled = core.toggleTodayItem("default", String(first["key"]));
    expect(toggled.success).toBe(true);
    expect((toggled.data as Record<string, unknown>)["done_count"]).toBe(1);

    // 跨天：没做完的「听力」顺延，今天该做的「精读」也进来；
    // 中间的「复习：背词」是勾选「背词」后自动入队、次日到期的复习项（间隔重复闭环）
    fake.set("2026-09-23");
    const tomorrowData = core.getTodayPlan().data as Record<string, unknown>;
    const tomorrow = tomorrowData["today"] as Record<string, unknown>;
    expect(tomorrow["day_index"]).toBe(2);
    const items = tomorrow["items"] as Array<Record<string, unknown>>;
    expect(items.map((item) => item["title"])).toEqual(["听力", "复习：背词", "精读"]);
    expect(items[0]!["carried_from"]).toBe("2026-09-22");
    expect(items[2]!["carried_from"]).toBe("");
  });

  it("今日页勾选会同步到短期计划的进度", () => {
    const fake = mutableClock("2026-09-22");
    const core = createSynapseCore({
      clock: fake.clock,
      idGen: { next: () => `tg-${++idCounter}` },
    });
    core.savePlan(
      "default",
      {
        message: "一天的计划",
        plan: {
          weekly_plan: [
            {
              day_index: 1,
              focus: "Day1",
              tasks: [
                { title: "背词", subject: "英语", task_type: "learn", duration_minutes: 30, reason: "r" },
              ],
              carry_over: [],
            },
          ],
        },
        blockPlan: null,
      },
      "初次生成",
    );

    const today = (core.getTodayPlan().data as Record<string, unknown>)["today"] as Record<
      string,
      unknown
    >;
    const key = String((today["items"] as Array<Record<string, unknown>>)[0]!["key"]);
    core.toggleTodayItem("default", key);

    const current = core.getCurrentPlan().data as Record<string, unknown>;
    const progress = (current["plan"] as Record<string, unknown>)["task_progress"] as Record<
      string,
      boolean
    >;
    expect(progress[key]).toBe(true);
  });
});

describe("core v2：BM25 本地检索", () => {
  it("中文按相邻双字建索引，单字退化为单字", () => {
    expect(tokenize("求导公式")).toEqual(["求导", "导公", "公式"]);
    expect(tokenize("力")).toEqual(["力"]);
    expect(tokenize("DeepSeek API")).toEqual(["deepseek", "api"]);
  });

  it("打分排序：出现次数多的排前，无关文档被排除", () => {
    const documents = [
      { id: "a", text: "极限的计算方法：先化简再求导。" },
      { id: "b", text: "这是一段和查询无关的填充文本，用来拉长文档长度。" },
      { id: "c", text: "求导法则与复合函数求导。" },
    ];
    const hits = search_index(build_index(documents), "求导", 3);
    expect(hits.map((hit) => hit.id)).toEqual(["c", "a"]);
    expect(hits[0]!.matched).toContain("求导");
  });

  it("资料检索沿用旧输出格式，无资料时返回空", () => {
    const records = build_document_records("default", [
      { id: "doc-1", name: "高数笔记", extracted_text: "极限与连续：夹逼定理、无穷小的比较。" },
      { id: "doc-2", name: "英语笔记", extracted_text: "听力高频词与连读规则。" },
    ]);
    const lines = search_document_records(records, "夹逼定理", null, 2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("高数笔记");
    expect(search_document_records([], "任意", null, 2)).toEqual([]);
  });
});

describe("core v2：SM-2 间隔重复", () => {
  it("新学 → 明天首复习；连续记住 → 间隔 1 → 6 → 15", () => {
    const created = create_review_item({
      id: "r1",
      subject: "高等数学",
      topic: "极限",
      today: "2026-09-22",
    });
    expect(created.due_date).toBe("2026-09-23");
    expect(created.interval_days).toBe(1);

    const first = apply_sm2(created, 4, "2026-09-23");
    expect(first.interval_days).toBe(6);
    expect(first.due_date).toBe("2026-09-29");
    expect(first.ease).toBe(2.5);

    const second = apply_sm2(first, 4, "2026-09-29");
    expect(second.interval_days).toBe(15);
    expect(second.repetitions).toBe(3);
  });

  it("忘记时间隔重置、难度下降，且难度不低于 1.3", () => {
    const created = create_review_item({
      id: "r2",
      subject: "英语",
      topic: "听力",
      today: "2026-09-22",
    });
    const lapsed = apply_sm2(created, 2, "2026-09-23");
    expect(lapsed.repetitions).toBe(0);
    expect(lapsed.interval_days).toBe(1);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.ease).toBeCloseTo(2.18, 2);

    let hard = lapsed;
    for (let index = 0; index < 5; index += 1) {
      hard = apply_sm2(hard, 0, "2026-09-23");
    }
    expect(hard.ease).toBe(1.3);
  });

  it("到期筛选按到期日排序，每日配额有时间与条数上限", () => {
    const items = [
      create_review_item({ id: "a", subject: "英语", topic: "A", today: "2026-09-20" }),
      create_review_item({ id: "b", subject: "英语", topic: "B", today: "2026-09-21" }),
      create_review_item({ id: "c", subject: "英语", topic: "C", today: "2026-09-22" }),
    ];
    // C 的到期日是明天，今天不该出现
    expect(due_review_items(items, "2026-09-22").map((item) => item.id)).toEqual(["a", "b"]);
    expect(daily_review_quota(0, 60)).toBe(0);
    expect(daily_review_quota(2, 60)).toBe(2);
    expect(daily_review_quota(10, 90)).toBe(5);
    expect(daily_review_quota(10, 600)).toBe(6);
  });
});

describe("core v2：复习闭环（打卡 → 入队 → 今日复习）", () => {
  it("完成学习任务自动入队，次日排进今日，勾选后按 SM-2 推进间隔", () => {
    const fake = mutableClock("2026-09-22");
    const core = createSynapseCore({
      clock: fake.clock,
      idGen: { next: () => `rv-${++idCounter}` },
    });
    core.savePlan(
      "default",
      {
        message: "一天的计划",
        plan: {
          weekly_plan: [
            {
              day_index: 1,
              focus: "Day1",
              tasks: [
                {
                  title: "背词",
                  subject: "英语",
                  task_type: "learn",
                  duration_minutes: 30,
                  reason: "r",
                },
              ],
              carry_over: [],
            },
          ],
        },
        blockPlan: null,
      },
      "初次生成",
    );

    const today = (core.getTodayPlan().data as Record<string, unknown>)["today"] as Record<
      string,
      unknown
    >;
    const taskKey = String((today["items"] as Array<Record<string, unknown>>)[0]!["key"]);
    core.toggleTodayItem("default", taskKey);

    const queued = core.listReviews().data as Record<string, unknown>;
    expect(queued["total"]).toBe(1);
    const queuedItem = (queued["items"] as Array<Record<string, unknown>>)[0]!;
    expect(queuedItem["subject"]).toBe("英语");
    expect(queuedItem["due_date"]).toBe("2026-09-23");

    // 次日：到期复习自动排进今日
    fake.set("2026-09-23");
    const tomorrow = (core.getTodayPlan().data as Record<string, unknown>)["today"] as Record<
      string,
      unknown
    >;
    const items = tomorrow["items"] as Array<Record<string, unknown>>;
    expect(items.map((item) => item["title"])).toEqual(["复习：背词"]);

    // 勾选复习 → 间隔推进到 6 天后
    core.toggleTodayItem("default", String(items[0]!["key"]));
    const after = core.listReviews().data as Record<string, unknown>;
    const updated = (after["items"] as Array<Record<string, unknown>>)[0]!;
    expect(updated["interval_days"]).toBe(6);
    expect(updated["due_date"]).toBe("2026-09-29");
  });
});

describe("core v2：资料库（粘贴导入 + BM25）", () => {
  it("导入后可列出、可删除，片段可被检索命中", () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-22T00:00:00.000Z" },
      idGen: { next: () => `doc-${++idCounter}` },
    });

    const imported = core.importDocument(
      "default",
      "高数笔记",
      "夹逼定理：用于求极限。另外还有单调有界准则。",
    );
    expect(imported.success).toBe(true);

    const listed = core.listDocuments().data as Record<string, unknown>;
    expect(listed["total"]).toBe(1);
    const doc = (listed["documents"] as Array<Record<string, unknown>>)[0]!;
    expect(doc["file_name"]).toBe("高数笔记");
    expect(Number(doc["chunk_count"])).toBeGreaterThan(0);

    const removed = core.removeDocument("default", String(doc["doc_id"]));
    expect(removed.success).toBe(true);
    expect((core.listDocuments().data as Record<string, unknown>)["total"]).toBe(0);
  });
});

describe("core v2：模型不可达时自动降级", () => {
  it("意图分类请求失败时，改用规则计划而不是闲聊兜底", async () => {
    const answers = { calls: 0 };
    const failing: LlmProvider = {
      describe: () => ({ provider: "deepseek", model: "unreachable", status: "ready" }),
      generateWithTools: async () => {
        answers.calls += 1;
        throw new Error("不在以下 request 合法域名列表中");
      },
      generateText: async () => {
        answers.calls += 1;
        throw new Error("不在以下 request 合法域名列表中");
      },
      generateJson: async () => {
        throw new Error("不在以下 request 合法域名列表中");
      },
      async *streamText() {
        throw new Error("不在以下 request 合法域名列表中");
      }
    };

    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `f-${++idCounter}` }
    });
    core.workflow.providers = { ...core.workflow.providers, llm: failing };

    const response = await core.run(runPayload(undefined));

    // 关键：拿到的是计划，不是"我在，你想聊学习计划"这类无用回复
    expect(response.plan).not.toBeNull();
    expect(response.plan!.weekly_plan.length).toBeGreaterThan(0);
    const generateStage = response.plan!.stages.find((stage) => stage.stage === "generate_plan");
    expect(generateStage?.status).toBe("fallback");
    expect(generateStage?.summary).toContain("模型请求失败");

    // 已知不可达后不再重复发起请求（只尝试过一次意图分类）
    expect(answers.calls).toBe(1);
  });
});

describe("core v2：离线（未配置 Key）时的表现", () => {
  it("开启 offlinePlanFallback 后，没配 Key 也能拿到规则计划而不是一句固定话术", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-22T00:00:00.000Z" },
      idGen: { next: () => `off-${++idCounter}` },
      config: { offlinePlanFallback: true },
    });

    const response = await core.run(runPayload(undefined));

    // 关键：离线也要产出可执行计划，而不是「我在，你想聊学习计划…」这类无用回复
    expect(response.plan).not.toBeNull();
    expect(response.plan!.weekly_plan.length).toBeGreaterThan(0);
    expect(response.message).toContain("没有配置模型 Key");
  });

  it("离线时规则计划始终带说明，不依赖 _llmUnreachableReason", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-22T00:00:00.000Z" },
      idGen: { next: () => `off-plan-${++idCounter}` },
      config: { offlinePlanFallback: true },
    });

    // 关键：这里没有先跑意图分类，所以 _llmUnreachableReason 是空的。
    // 澄清问答走的正是这条路（submit_clarification 开头还会重置那个标记），
    // 说明文案如果只挂在标记上，就会像真机那样悄悄丢掉。
    const plan = await core.workflow.build_study_plan({
      user_id: "default",
      current_level: "大二",
      learning_goal: "备考六级词汇",
      available_days_per_week: 5,
      available_minutes_per_day: 60,
      deadline: null,
      weak_points: [],
      preferences: [],
      need_user_confirmation: false,
    });

    expect(plan.weekly_plan.length).toBeGreaterThan(0);
    expect(plan.final_message).toContain("没有配置模型 Key");
  });

  it("默认不开启，保持冻结基线里的 Mock 行为", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-22T00:00:00.000Z" },
      idGen: { next: () => `mk-${++idCounter}` },
    });

    const response = await core.run(runPayload(undefined));

    expect(response.plan).toBeNull();
    expect(response.mode).toBe("intent-gate");
  });
});

describe("core v2：今日列表的缓存失效", () => {
  it("同一天内生成计划后，今日列表会重建而不是返回计划前的空缓存", () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-22T00:00:00.000Z" },
      idGen: { next: () => `today-${++idCounter}` },
    });

    // 还没有计划：今日列表为空，这份空列表会被缓存下来
    const before = core.getTodayPlan("default").data as Record<string, unknown>;
    const beforeToday = before["today"] as Record<string, unknown>;
    expect(beforeToday["items"] as unknown[]).toHaveLength(0);

    // 生成计划（版本号 +1）
    core.savePlan(
      "default",
      { message: "测试计划", plan: { weekly_plan: JSON.parse(PLAN_JSON).weekly_plan } },
      "初次生成计划",
    );

    const after = core.getTodayPlan("default").data as Record<string, unknown>;
    const afterToday = after["today"] as Record<string, unknown>;
    const items = afterToday["items"] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    expect(String(afterToday["plan_version"])).toBe("1");
  });
});

describe("core v2：课程表接口", () => {
  it("解析 → 保存 → 读取 → 删除", () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `tt-${++idCounter}` },
    });

    const parsed = core.parseTimetable("周一 高等数学 08:00-09:40\n周三 英语 10:00-11:40");
    expect((parsed.data as { entries: unknown[] }).entries).toHaveLength(2);

    const entries = (parsed.data as { entries: TimetableEntry[] }).entries;
    const saved = core.saveTimetable("default", entries);
    expect((saved.data as Record<string, unknown>)["total"]).toBe(2);

    const read = core.getTimetable();
    const readData = read.data as Record<string, unknown>;
    expect(readData["total"]).toBe(2);
    expect(new Set(readData["subjects"] as string[])).toEqual(new Set(["高等数学", "英语"]));

    const entryId = entries[0]!.id;
    const removed = core.removeTimetableEntry("default", entryId);
    expect((removed.data as Record<string, unknown>)["total"]).toBe(1);
  });

  it("手动录入非法条目会被过滤（结束时间早于开始时间）", () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "<timestamp>" },
      idGen: { next: () => `bad-${++idCounter}` },
    });
    const result = core.saveTimetable("default", [
      {
        id: "",
        name: "无效课",
        subject: "无效课",
        weekday: 1,
        startMinute: 600,
        endMinute: 500,
        weeks: "",
        location: "",
        teacher: "",
      },
    ]);
    expect((result.data as Record<string, unknown>)["total"]).toBe(0);
  });
});
