/**
 * v2 新功能测试：课程表解析与避让、多科目分组、会话隔离与落库、计划版本。
 * 这些用例覆盖「v2 有意新增」的行为；旧行为的不漂移由 httpBaseline.spec.ts 保证。
 */

import { describe, expect, it } from "vitest";

import { createSynapseCore, type SynapseCore } from "../src/application/core.js";
import { MemoryKvStore } from "../src/storage/kv.js";
import {
  apply_timetable_to_payload,
  build_timetable_context,
  is_entry_active_in_week,
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
  allocate_context_budget,
  collect_document_hits,
  summarize_context_sources,
} from "../src/domain/contextBudget.js";
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
import type {
  AssignmentItem,
  KnowledgeMasteryEntry,
  ReviewHintResult,
  StudyPlanRequest,
  TimetableEntry,
} from "../src/protocol/study.js";
import type { StudyPilotRunRequest } from "../src/protocol/frontend.js";
import { buildTeachPrompt } from "../src/application/prompts.js";
import {
  assignment_risk,
  build_assignment_schedule,
  looks_like_assignment,
  parse_assignment_due,
  parse_assignment_items,
} from "../src/domain/assignment.js";
import {
  ASSIGNMENT_PACK_HEADER,
  decode_assignment_pack,
  encode_assignment_pack,
} from "../src/domain/assignmentPack.js";
import { compute_mastery, summarize_mastery } from "../src/domain/kgMastery.js";
import {
  build_offline_hints,
  find_leaked_span,
  hints_leak_answer,
} from "../src/domain/reviewHints.js";
import { KgBuilder } from "../src/application/kgBuilder.js";
import { KgRetrievalProvider } from "../src/providers/kgRetrieval.js";

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

class KgMockLlm extends RecordingLlm {
  override async generateJson(): Promise<Record<string, unknown>> {
    return {
      nodes: [
        {
          name: "夹逼定理",
          category: "topic",
          subject: "高等数学",
          aliases: ["夹逼准则"],
          description: "利用上下界极限求目标极限",
        },
        {
          name: "函数极限",
          category: "topic",
          subject: "高等数学",
          aliases: [],
          description: "夹逼定理的前置知识",
        },
      ],
      edges: [
        {
          source_name: "函数极限",
          target_name: "夹逼定理",
          relation: "prerequisite_of",
        },
      ],
    };
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

  it("节次写法按默认作息表换算，且不会被误当成周次", () => {
    const result = parse_timetable_text(
      ["周一 高等数学 第1-2节", "周三 线性代数 第3-4节 1-16周"].join("\n"),
      { idGen: testIdGen },
    );

    expect(result.entries).toHaveLength(2);
    expect(result.unparsedLines).toEqual([]);
    expect(result.entries[0]).toMatchObject({
      name: "高等数学",
      weekday: 1,
      startMinute: 8 * 60,
      endMinute: 9 * 60 + 40,
    });
    expect(result.entries[0]!.weeks).toBe("");
    expect(result.entries[1]).toMatchObject({
      name: "线性代数",
      weekday: 3,
      weeks: "1-16",
      startMinute: 10 * 60,
      endMinute: 11 * 60 + 40,
    });
  });

  it("支持自定义作息表", () => {
    const result = parse_timetable_text("周一 高等数学 第1-2节", {
      idGen: testIdGen,
      periodSchedule: [
        { start_minute: 9 * 60, end_minute: 9 * 60 + 50 },
        { start_minute: 10 * 60, end_minute: 10 * 60 + 50 },
      ],
    });
    expect(result.entries[0]).toMatchObject({
      startMinute: 9 * 60,
      endMinute: 10 * 60 + 50,
    });
  });

  it("识别教室与教师，认不出的部分保留在课程名里", () => {
    const result = parse_timetable_text(
      ["周一 高等数学 08:00-09:40 A101 张三老师", "周二 大学物理 10:00-11:40 待定"].join("\n"),
      { idGen: testIdGen },
    );

    expect(result.entries[0]).toMatchObject({
      name: "高等数学",
      location: "A101",
      teacher: "张三",
    });
    // 「待定」既不像教室也不像教师，应并回课程名而不是乱猜
    expect(result.entries[1]).toMatchObject({
      name: "大学物理 待定",
      location: "",
      teacher: "",
    });
  });

  it("单双周与周次区间可用于过滤当周课表", () => {
    expect(is_entry_active_in_week("", 3)).toBe(true);
    expect(is_entry_active_in_week("单周", 3)).toBe(true);
    expect(is_entry_active_in_week("单周", 4)).toBe(false);
    expect(is_entry_active_in_week("双周", 4)).toBe(true);
    expect(is_entry_active_in_week("1-8", 9)).toBe(false);
    expect(is_entry_active_in_week("5", 5)).toBe(true);
    // 未提供周次（0）时不过滤，保持旧行为
    expect(is_entry_active_in_week("单周", 0)).toBe(true);
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

  it("选文件导入不再截断到 6000 字，且支持 Markdown", async () => {
    const core = createSynapseCore({ idGen: testIdGen });

    // 约 1.2 万字：旧实现会把 6000 字之后的内容静默丢掉
    const tail = "末尾标记词";
    const longText = `${"函数单调性讨论。".repeat(1500)}${tail}`;
    const attachments = await core.extractFiles([
      {
        name: "错题笔记.md",
        contentType: "text/markdown",
        data: new TextEncoder().encode(longText),
      },
    ]);

    const attachment = attachments[0]!;
    expect(attachment.extraction_status).toBe("done");
    const extracted = String(attachment.extracted_text);
    expect(extracted.length).toBeGreaterThan(6000);
    // 尾部内容没有被丢掉
    expect(extracted.endsWith(tail)).toBe(true);

    // 切出的片段数应与完整正文相符（旧上限下只能切出约 19 段）
    const imported = core.importDocument("default", "错题笔记.md", extracted);
    expect(imported.success).toBe(true);
    const listed = core.listDocuments().data as Record<string, unknown>;
    const doc = (listed["documents"] as Array<Record<string, unknown>>)[0]!;
    expect(Number(doc["chunk_count"])).toBeGreaterThan(25);
  });
});

describe("core v2：资料自动构建知识图谱", () => {
  it("模型抽取后可检索新节点，重复构建不产生重复节点", async () => {
    const core = createSynapseCore({ idGen: testIdGen });
    const imported = core.importDocument(
      "default",
      "高数错题笔记",
      "函数极限是夹逼定理的基础。夹逼定理通过上下界极限判断目标函数极限。",
    );
    expect(imported.success).toBe(true);
    const documents = (core.listDocuments().data as Record<string, unknown>)["documents"] as Array<
      Record<string, unknown>
    >;
    const docId = String(documents[0]!["doc_id"]);
    const builder = new KgBuilder(core.store, new KgMockLlm());
    const before = core.store.kgNodes().length;

    const first = await builder.buildKgFromDocument(docId);
    expect(first.added_nodes).toBe(3);
    expect(core.store.kgNodes().length).toBe(before + 3);
    expect(new KgRetrievalProvider(core.store).search("夹逼定理").join("\n")).toContain(
      "夹逼定理",
    );

    const second = await builder.buildKgFromDocument(docId);
    expect(second.added_nodes).toBe(0);
    expect(second.added_edges).toBe(0);
    expect(core.store.kgNodes().length).toBe(before + 3);
  });

  it("无 Key 时离线抽取知识点并加入明日复习队列", async () => {
    const core = createSynapseCore({
      idGen: testIdGen,
      config: { offlinePlanFallback: true },
    });
    const imported = core.importDocument(
      "default",
      "物理错题",
      "受力分析受力分析受力分析，牛顿定律牛顿定律，摩擦力摩擦力。",
    );
    const documents = (imported.data as Record<string, unknown>)["documents"] as Array<
      Record<string, unknown>
    >;
    const docId = String(documents[0]!["doc_id"]);

    const result = await core.buildKgFromDocument(docId);
    const data = result.data;
    expect(result.success).toBe(true);
    expect(data?.used_fallback).toBe(true);
    expect(Number(data?.added_nodes)).toBeGreaterThan(1);
    expect(Number(data?.added_reviews)).toBeGreaterThan(0);
    expect(core.store.get_reviews("default").length).toBe(Number(data?.added_reviews));
  });

  it("一键演示数据包含三天前计划、打卡、到期复习与资料图谱", async () => {
    const core = createSynapseCore({
      idGen: testIdGen,
      clock: { nowIso: () => "2026-09-23T08:00:00.000Z" },
      config: { offlinePlanFallback: true },
    });
    const result = await core.loadDemoData();

    expect(result.success).toBe(true);
    expect(core.store.get_plan("default")?.start_date).toBe("2026-09-20");
    expect(Object.values(core.progress.get_task_progress("default")).filter(Boolean)).toHaveLength(2);
    expect(core.listReviews().data?.due_count).toBeGreaterThanOrEqual(2);
    expect(core.store.kgNodes().some((node) => node.id.startsWith("doc_demo-mat"))).toBe(true);
  });
});

describe("core v2：资料结构化元数据（F1）", () => {
  const firstDoc = (core: SynapseCore): Record<string, unknown> => {
    const listed = core.listDocuments().data as Record<string, unknown>;
    return (listed["documents"] as Array<Record<string, unknown>>)[0]!;
  };

  it("导入时自动推断科目并补齐元数据", () => {
    const core = createSynapseCore({ idGen: testIdGen });
    const imported = core.importDocument(
      "default",
      "高三数学错题笔记.txt",
      "函数与导数：含参函数单调性讨论，先求导再按参数分类。圆锥曲线注意斜率不存在。",
    );
    expect(imported.success).toBe(true);

    const doc = firstDoc(core);
    expect(doc["subject"]).toBe("数学");
    expect(doc["source"]).toBe("upload");
    expect(doc["tags"]).toEqual([]);
    expect(Number(doc["char_count"])).toBeGreaterThan(0);
    expect(Number(doc["kg_node_count"])).toBe(0);
    expect(Number(doc["review_card_count"])).toBe(0);
  });

  it("粘贴来源会标记为 paste，也可显式指定科目", () => {
    const core = createSynapseCore({ idGen: testIdGen });
    core.importDocument("default", "随手记", "今天学了点东西，没什么关键词。", {
      source: "paste",
      subject: "物理",
    });

    const doc = firstDoc(core);
    expect(doc["source"]).toBe("paste");
    expect(doc["subject"]).toBe("物理");
  });

  it("改标题 / 科目 / 标签后可由列表读回", () => {
    const core = createSynapseCore({ idGen: testIdGen });
    const imported = core.importDocument("default", "无名资料", "一些内容。");
    const docId = String(
      ((imported.data as Record<string, unknown>)["documents"] as Array<Record<string, unknown>>)[0]![
        "doc_id"
      ],
    );

    const updated = core.updateDocument("default", docId, {
      file_name: "化学笔记",
      subject: "化学",
      tags: ["易错", "有机"],
    });
    expect(updated.success).toBe(true);

    const doc = firstDoc(core);
    expect(doc["file_name"]).toBe("化学笔记");
    expect(doc["subject"]).toBe("化学");
    expect(doc["tags"]).toEqual(["易错", "有机"]);
  });

  it("构图与抽卡后回写节点 ID 与卡片 ID", async () => {
    const core = createSynapseCore({ idGen: testIdGen, config: { offlinePlanFallback: true } });
    const imported = core.importDocument(
      "default",
      "物理错题",
      "受力分析受力分析受力分析，牛顿定律牛顿定律，摩擦力摩擦力。",
    );
    const docId = String(
      ((imported.data as Record<string, unknown>)["documents"] as Array<Record<string, unknown>>)[0]![
        "doc_id"
      ],
    );

    const built = await core.buildKgFromDocument(docId);
    expect(built.success).toBe(true);
    expect(Number(firstDoc(core)["kg_node_count"])).toBeGreaterThan(0);
    expect(Number(firstDoc(core)["review_card_count"])).toBeGreaterThan(0);

    // 重复抽卡幂等，不会重复建卡
    const before = core.store.get_reviews("default").length;
    const again = core.generateReviewCardsFromDocument("default", docId);
    expect(again.success).toBe(true);
    expect(core.store.get_reviews("default").length).toBe(before);
  });

  it("旧格式资料（无新字段）读取不报错且带默认值", () => {
    // 直接写入旧结构的原始记录，模拟升级前已存在的资料
    const kv = new MemoryKvStore();
    kv.set("documents:default", [
      {
        doc_id: "legacy-1",
        user_id: "default",
        file_name: "旧笔记.txt",
        excerpt: "旧内容",
        chunks: [{ chunk_id: "legacy-1-chunk-1", text: "旧内容", keywords: [] }],
      },
    ]);
    const core = createSynapseCore({ kv, idGen: testIdGen });

    const doc = firstDoc(core);
    expect(doc["file_name"]).toBe("旧笔记.txt");
    expect(doc["subject"]).toBe("");
    expect(doc["source"]).toBe("upload");
    expect(Number(doc["char_count"])).toBe(0);
    expect(Number(doc["kg_node_count"])).toBe(0);
    expect(Number(doc["chunk_count"])).toBe(1);
  });
});

describe("core v2：用户资料进入计划上下文", () => {
  const mathNotes = [
    "高三数学错题笔记（近一个月）",
    "一、函数与导数",
    "1. 含参函数单调性讨论：忘记先求导再对参数分类（a>0、a=0、a<0 三种情况）。",
    "2. 极值点偏移：构造对称函数后忘记说明单调性，结论不严谨。",
    "函数与导数是失分最多的板块，想每天抽 45 分钟专练，先从单调性讨论开始。",
  ].join("\n");

  it("配额分配保证资料不会被知识图谱挤出", () => {
    const context = allocate_context_budget([
      "图谱摘要：当前已有 9 个节点、10 条边。",
      "图谱命中：函数。",
      "图谱命中：单调性。",
      "图谱命中：导数。",
      "图谱建议路径：先知识点梳理，再做题验证。",
      "资料命中[高三数学错题笔记.txt]: 含参函数单调性讨论。",
      "课程表：已导入 1 节课。",
    ]);

    expect(context).toContain("资料命中[高三数学错题笔记.txt]: 含参函数单调性讨论。");
    expect(context).toHaveLength(7);
    expect(summarize_context_sources(context).document).toBe(1);
    expect(collect_document_hits(context)).toEqual([
      { file_name: "高三数学错题笔记.txt", excerpt: "含参函数单调性讨论。" },
    ]);
  });

  it("离线规则计划会在消息、理由和首个任务中引用命中的资料", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-23T00:00:00.000Z" },
      idGen: { next: () => `rag-${++idCounter}` },
      config: { offlinePlanFallback: true },
    });
    core.importDocument("default", "高三数学错题笔记.txt", mathNotes);

    const response = await core.run({
      ...runPayload("conv-rag"),
      input: "我要准备高考数学，函数与导数这块总是错，帮我在两周内补起来",
    });

    expect(response.plan).not.toBeNull();
    expect(response.plan!.retrieved_context.some((line) => line.startsWith("资料命中["))).toBe(
      true,
    );
    expect(response.message).toContain("高三数学错题笔记.txt");
    expect(response.reason).toContain("高三数学错题笔记.txt");
    expect(response.plan!.weekly_plan[0]!.tasks[0]!.reason).toContain(
      "高三数学错题笔记.txt",
    );
    const messages = (core.getMessages("conv-rag").data ?? []) as Array<{
      role: string;
      plan_data_json: string | null;
    }>;
    const assistant = messages.find((message) => message.role === "assistant");
    expect(JSON.parse(assistant!.plan_data_json!)).toMatchObject({
      retrieved_context: expect.arrayContaining([
        expect.stringContaining("资料命中[高三数学错题笔记.txt]"),
      ]),
    });
  });
});

describe("core v2：教学路径资料检索", () => {
  it("命中资料时把文件名和片段加入教学提示词", async () => {
    const prompts: string[] = [];
    const teachingLlm: LlmProvider = {
      describe: () => ({ provider: "deepseek", model: "teaching-test", status: "ready" }),
      generateWithTools: async () => ({
        tool_calls: [
          {
            name: "teach",
            args: { subject: "数学", action: "讲解", topic: "含参函数单调性讨论" },
          },
        ],
      }),
      generateText: async (prompt) => {
        prompts.push(prompt);
        return "依据你的《高三数学错题笔记.txt》，先求导再分类讨论参数。";
      },
      generateJson: async () => ({}),
      async *streamText() {
        yield "";
      },
    };
    const core = createSynapseCore({
      clock: { nowIso: () => "2026-09-23T00:00:00.000Z" },
      idGen: { next: () => `teach-${++idCounter}` },
    });
    core.workflow.providers = { ...core.workflow.providers, llm: teachingLlm };
    core.importDocument(
      "default",
      "高三数学错题笔记.txt",
      "含参函数单调性讨论：忘记先求导再对参数分类。",
    );

    const response = await core.run({
      ...runPayload("conv-teach"),
      input: "含参函数单调性讨论怎么做",
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("资料命中[高三数学错题笔记.txt]");
    expect(prompts[0]).toContain("如果片段不足以回答，请明确说明资料里没有覆盖");
    expect(response.message).toContain("高三数学错题笔记.txt");
  });

  it("没有资料时教学提示词与旧版逐字一致", () => {
    expect(buildTeachPrompt("数学", "讲解", "导数")).toBe(
      "用户需要教学帮助。学科：数学，动作：讲解，知识点：导数。请给出具体、可操作的教学内容（2-5句）。",
    );
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

describe("core v2：作业式计划（F3）", () => {
  /** 2026-03-04 是周三，用它固定「本周五 / 下周一」这类相对日期的解析结果。 */
  const TODAY = "2026-03-04";
  const fixedClock = { nowIso: () => `${TODAY}T09:00:00.000Z` };

  function assignmentItem(patch: Partial<AssignmentItem> = {}): AssignmentItem {
    return {
      id: `a-${++idCounter}`,
      subject: "数学",
      title: "第三章习题",
      quantity: 20,
      unit: "题",
      due_date: TODAY,
      estimated_minutes: 60,
      status: "pending",
      done_at: "",
      created_at: TODAY,
      source_text: "数学第三章习题1-20明天交",
      review_card_ids: [],
      plan_id: "",
      plan_version: null,
      original_due_date: "",
      rescheduled_at: "",
      ...patch,
    };
  }

  /** 自称 deepseek 的假模型：意图走工具调用，抽取走 JSON。 */
  class AssignmentLlm implements LlmProvider {
    readonly prompts: string[] = [];

    constructor(
      private readonly toolName: string,
      private readonly toolArgs: Record<string, unknown>,
      private readonly extraction: Record<string, unknown>,
    ) {}

    describe(): Record<string, unknown> {
      return { provider: "deepseek", model: "assignment-llm", status: "ready" };
    }

    async generateWithTools(
      prompt: string,
      _tools: unknown[],
      forceTool = "",
    ): Promise<GenerateWithToolsResult> {
      this.prompts.push(prompt);
      const name = forceTool || this.toolName;
      const args = name === "submit_assignment" ? this.toolArgs : { subject: "数学", goal: "备考" };
      return { tool_calls: [{ name, args }] };
    }

    async generateText(prompt: string): Promise<string> {
      this.prompts.push(prompt);
      return PLAN_JSON;
    }

    async generateJson(prompt: string): Promise<Record<string, unknown>> {
      this.prompts.push(prompt);
      return this.extraction;
    }

    async *streamText(): AsyncIterable<string> {
      yield "";
    }
  }

  it("离线日期解析覆盖 今天/明天/周五/下周一/月日/还有 X 天", () => {
    expect(parse_assignment_due("明天交", TODAY)).toBe("2026-03-05");
    expect(parse_assignment_due("后天要交", TODAY)).toBe("2026-03-06");
    expect(parse_assignment_due("周五前交", TODAY)).toBe("2026-03-06");
    expect(parse_assignment_due("下周一交", TODAY)).toBe("2026-03-09");
    expect(parse_assignment_due("3月10日交", TODAY)).toBe("2026-03-10");
    expect(parse_assignment_due("还有 5 天", TODAY)).toBe("2026-03-09");
    expect(parse_assignment_due("随便写点什么", TODAY)).toBeNull();
  });

  it("离线规则把一句话拆成多条作业，并推断科目、数量与估时", () => {
    const drafts = parse_assignment_items(
      "数学第三章习题1-20明天交，英语背Unit3单词周五默写",
      TODAY,
    );

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      subject: "数学",
      quantity: 20,
      unit: "题",
      due_date: "2026-03-05",
      estimated_minutes: 60,
    });
    expect(drafts[0]!.title).toContain("习题1-20");
    expect(drafts[1]).toMatchObject({ subject: "英语", due_date: "2026-03-06" });
    // 「Unit3」里的 3 不是数量，不能被当成 3 个单词
    expect(drafts[1]!.unit).not.toBe("单词");
  });

  it("排期按截止日摊量，且每天不超每日预算", () => {
    const schedule = build_assignment_schedule({
      items: [assignmentItem({ due_date: "2026-03-06" })],
      today: TODAY,
      daily_minutes: 30,
    });

    expect(schedule.map((day) => day.date)).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
    ]);
    for (const day of schedule) {
      expect(day.total_minutes).toBeLessThanOrEqual(30);
      expect(day.tasks.every((task) => task.title.startsWith("作业 · 截止"))).toBe(true);
    }
    expect(schedule[0]!.tasks[0]!.title).toContain("第 1-7 题");
  });

  it("有模型 Key 时走 JSON 抽取，返回作业看板并落库", async () => {
    const llm = new AssignmentLlm(
      "submit_assignment",
      { text: "数学第三章习题1-20明天交" },
      {
        items: [
          {
            subject: "数学",
            title: "第三章习题",
            quantity: 20,
            unit: "题",
            due_date: "2026-03-05",
            estimated_minutes: 60,
          },
        ],
        unparsed: "",
      },
    );
    const core = createSynapseCore({ clock: fixedClock, idGen: testIdGen });
    core.workflow.providers = { ...core.workflow.providers, llm };

    const response = await core.run({ ...runPayload("conv-assignment"), input: "数学第三章习题1-20明天交" });

    expect(response.mode).toBe("assignment-intake");
    expect(response.assignment?.total).toBe(1);
    expect(response.assignment?.items[0]).toMatchObject({
      subject: "数学",
      quantity: 20,
      due_date: "2026-03-05",
      status: "pending",
    });
    // 抽取提示词里必须带今天的日期，否则模型算不出绝对截止日
    expect(llm.prompts.some((prompt) => prompt.includes(`今天日期：${TODAY}`))).toBe(true);
    expect(core.store.get_assignments("default")).toHaveLength(1);
  });

  it("逾期项被标记并能在重排后挪到后续几天", async () => {
    const core = createSynapseCore({ clock: fixedClock, idGen: testIdGen });
    core.store.save_assignments("default", [
      assignmentItem({ due_date: "2026-03-02", estimated_minutes: 60 }),
    ]);

    const before = core.listAssignments();
    expect(before.data!["overdue_count"]).toBe(1);

    const after = core.rescheduleOverdueAssignments();
    expect(after.data!["overdue_count"]).toBe(0);
    const item = (after.data!["items"] as AssignmentItem[])[0]!;
    expect(item.original_due_date).toBe("2026-03-02");
    expect(item.due_date > TODAY).toBe(true);
    expect(item.status).toBe("pending");
  });

  it("解析不出时走澄清追问，用户补一句后重新解析成功", async () => {
    const llm = new AssignmentLlm(
      "submit_assignment",
      { text: "把这周的实验报告整理一下" },
      { items: [], unparsed: "把这周的实验报告整理一下" },
    );
    const core = createSynapseCore({ clock: fixedClock, idGen: testIdGen });
    core.workflow.providers = { ...core.workflow.providers, llm };

    const first = await core.run({
      ...runPayload("conv-assignment-clarify"),
      input: "把这周的实验报告整理一下",
    });
    expect(first.status).toBe("needs_clarification");
    expect(first.mode).toBe("assignment-intake");

    const second = await core.confirm({
      sessionId: first.clarification!.sessionId,
      answers: [{ questionId: "q1", answer: "周五交" }],
    });
    expect(second.assignment?.total).toBe(1);
    expect(second.assignment?.items[0]!.title).toContain("实验报告");
    expect(second.assignment?.items[0]!.due_date).toBe("2026-03-06");
  });

  it("打卡后状态翻转，并自动进入复习队列", async () => {
    const core = createSynapseCore({ clock: fixedClock, idGen: testIdGen });
    // mock provider 下走离线规则解析，不需要模型
    await core.createAssignments("default", "数学第三章习题1-20明天交");

    const items = core.listAssignments().data!["items"] as AssignmentItem[];
    expect(items).toHaveLength(1);

    const done = core.completeAssignment("default", items[0]!.id, true);
    const doneItem = done.data!["item"] as AssignmentItem;
    expect(doneItem.status).toBe("done");
    expect(doneItem.done_at).toBe(TODAY);
    expect(doneItem.review_card_ids.length).toBe(1);
    expect(core.store.get_reviews("default")).toHaveLength(1);

    // 取消打卡：状态回到待办，复习卡不重复生成
    const undone = core.completeAssignment("default", items[0]!.id, false);
    expect((undone.data!["item"] as AssignmentItem).status).toBe("pending");
    expect(core.store.get_reviews("default")).toHaveLength(1);
  });

  it("作业句式只认强信号，普通学习请求不会被误判", () => {
    expect(looks_like_assignment("数学第三章习题1-20明天交")).toBe(true);
    expect(looks_like_assignment("英语背Unit3单词周五默写")).toBe(true);
    expect(looks_like_assignment("帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟")).toBe(
      false,
    );
    expect(looks_like_assignment("我想系统学一下线性代数")).toBe(false);
  });
});

describe("core v2：学习仪表盘与数据导出（F4）", () => {
  const fixedClock = { nowIso: () => "2026-03-04T09:00:00.000Z" };

  it("载入演示数据后，仪表盘给出本周打卡与逾期作业", async () => {
    const core = createSynapseCore({ clock: fixedClock, idGen: testIdGen });
    await core.loadDemoData();

    const data = core.getDashboard().data!;
    const week = data["week"] as Record<string, unknown>;
    expect(Number(week["done_count"])).toBeGreaterThan(0);
    expect(Number((data["assignments"] as Record<string, unknown>)["overdue"])).toBe(1);
    expect(Number((data["today"] as Record<string, unknown>)["rate"])).toBeGreaterThanOrEqual(0);
    expect(Number((data["plan"] as Record<string, unknown>)["version"])).toBeGreaterThan(0);
  });

  it("导出包含资料、作业与复习队列，但不含 API Key", async () => {
    const core = createSynapseCore({ clock: fixedClock, idGen: testIdGen });
    core.saveApiKey("sk-should-never-be-exported");
    await core.createAssignments("default", "数学第三章习题1-20明天交");
    core.importDocument("default", "高三数学错题笔记", "函数与导数：含参函数单调性讨论要先求导。");

    const result = core.exportData();
    expect(result.success).toBe(true);
    const payload = result.data!["data"] as Record<string, unknown>;
    expect(payload["documents:default"]).toBeTruthy();
    expect(payload["assignments:default"]).toBeTruthy();
    expect(JSON.stringify(payload)).not.toContain("sk-should-never-be-exported");
    expect(String(result.data!["filename"])).toContain("synapse-export-");
  });
});

describe("core v2：作业包与扫码分发（F5）", () => {
  /** 2026-03-04 是周三，相对日期解析结果与 F3 保持一致。 */
  const TODAY = "2026-03-04";
  const fixedClock = { nowIso: () => `${TODAY}T09:00:00.000Z` };

  function packItem(patch: Partial<AssignmentItem> = {}): AssignmentItem {
    return {
      id: `pack-${++idCounter}`,
      subject: "数学",
      title: "第三章习题",
      quantity: 20,
      unit: "题",
      due_date: "2026-03-05",
      estimated_minutes: 60,
      status: "pending",
      done_at: "",
      created_at: TODAY,
      source_text: "数学第三章习题1-20明天交",
      review_card_ids: [],
      plan_id: "",
      plan_version: null,
      original_due_date: "",
      rescheduled_at: "",
      ...patch,
    };
  }

  /** 每次给一台独立设备（独立 KV），用来模拟「同学扫我的码」。 */
  function newCore(): SynapseCore {
    return createSynapseCore({ kv: new MemoryKvStore(), clock: fixedClock, idGen: testIdGen });
  }

  async function twoAssignments(core: SynapseCore): Promise<void> {
    await core.createAssignments("default", "数学第三章习题1-20明天交，英语背Unit3单词周五默写");
  }

  it("打包 → 解包字段逐字还原，空单位与 0 数量也不能丢", () => {
    const code = encode_assignment_pack([
      packItem(),
      packItem({
        subject: "英语",
        title: "背Unit3单词",
        quantity: 0,
        unit: "",
        estimated_minutes: 15,
        due_date: "2026-03-06",
      }),
    ]);
    expect(code.split("\n")[0]).toBe(ASSIGNMENT_PACK_HEADER);

    const { recognized, drafts, invalid } = decode_assignment_pack(code);
    expect(recognized).toBe(true);
    expect(invalid).toBe(0);
    expect(drafts).toEqual([
      {
        due_date: "2026-03-05",
        subject: "数学",
        title: "第三章习题",
        quantity: 20,
        unit: "题",
        estimated_minutes: 60,
      },
      {
        due_date: "2026-03-06",
        subject: "英语",
        title: "背Unit3单词",
        quantity: 0,
        unit: "",
        estimated_minutes: 15,
      },
    ]);
  });

  it("坏行只丢那一行，不整包作废；签名不对则整包不认", () => {
    const broken = [
      ASSIGNMENT_PACK_HEADER,
      "2026-03-05|数学|第三章习题|20|题|60",
      "只有三列|缺字段",
      "2026/03/06|英语|日期格式不对|1|篇|30",
      "2026-03-07|语文|周记|1|篇|30",
    ].join("\n");

    const result = decode_assignment_pack(broken);
    expect(result.recognized).toBe(true);
    expect(result.invalid).toBe(2);
    expect(result.drafts.map((draft) => draft.title)).toEqual(["第三章习题", "周记"]);

    expect(decode_assignment_pack("https://example.com/whatever").recognized).toBe(false);
    expect(decode_assignment_pack("").recognized).toBe(false);
  });

  it("导出未完成作业，导入到另一台设备后科目与截止日不丢，并自动进排期", async () => {
    const mine = newCore();
    await twoAssignments(mine);
    const pack = mine.exportAssignmentPack("default");
    expect(pack.success).toBe(true);
    expect(Number(pack.data!["count"])).toBe(2);

    const classmate = newCore();
    const result = classmate.importAssignmentPack("default", String(pack.data!["code"]));
    expect(result.success).toBe(true);
    expect(Number(result.data!["imported"])).toBe(2);
    expect(Number(result.data!["skipped"])).toBe(0);

    const board = classmate.listAssignments("default").data as unknown as {
      items: AssignmentItem[];
      schedule: unknown[];
    };
    expect(board.items.map((item) => `${item.subject}@${item.due_date}`).sort()).toEqual([
      "数学@2026-03-05",
      "英语@2026-03-06",
    ]);
    expect(board.schedule.length).toBeGreaterThan(0);
  });

  it("同一个包反复导入、互相转发，都长不出重复条目", async () => {
    const mine = newCore();
    await twoAssignments(mine);
    const code = String(mine.exportAssignmentPack("default").data!["code"]);

    const classmate = newCore();
    classmate.importAssignmentPack("default", code);
    const again = classmate.importAssignmentPack("default", code);
    expect(Number(again.data!["imported"])).toBe(0);
    expect(Number(again.data!["skipped"])).toBe(2);

    const board = classmate.listAssignments("default").data as unknown as { total: number };
    expect(board.total).toBe(2);
  });

  it("已完成的作业不会被打包发出去", async () => {
    const core = newCore();
    await twoAssignments(core);
    const items = (core.listAssignments("default").data as unknown as { items: AssignmentItem[] })
      .items;
    const first = items[0]!;
    core.completeAssignment("default", first.id, true);

    const pack = core.exportAssignmentPack("default");
    expect(Number(pack.data!["count"])).toBe(1);
    expect(Number(pack.data!["skipped_done"])).toBe(1);
    expect(String(pack.data!["code"])).not.toContain(first.title);
  });

  it("不是作业包的码会被明确拒绝，空清单不给打包", () => {
    const core = newCore();
    expect(core.exportAssignmentPack("default").success).toBe(false);

    const bad = core.importAssignmentPack("default", "随便一段文字");
    expect(bad.success).toBe(false);
    expect(bad.message).toContain("不是作业包");

    expect(core.importAssignmentPack("default", "   ").success).toBe(false);
  });
});

describe("core v2：图谱掌握度热力（G1）", () => {
  const TODAY = "2026-03-04";

  const nodes = [
    { id: "n-weak", name: "函数单调性", subject: "数学" },
    { id: "n-learning", name: "三角函数", subject: "数学" },
    { id: "n-mastered", name: "数列错位相减", subject: "数学" },
    { id: "n-untouched", name: "圆锥曲线", subject: "数学" },
  ];

  /** 按给定的评分序列真实推进一张卡（与线上走的是同一个 apply_sm2）。 */
  function card(subject: string, topic: string, grades: number[], id: string) {
    let item = create_review_item({ id, subject, topic, today: TODAY });
    for (const grade of grades) {
      item = apply_sm2(item, grade, TODAY);
    }
    return item;
  }

  it("四档判定：连对为掌握、连错为薄弱、单次为在学、无卡为未学", () => {
    const entries = compute_mastery(nodes, [
      card("数学", "函数单调性", [2, 2, 2], "c-weak"),
      card("数学", "三角函数", [4], "c-learning"),
      card("数学", "数列错位相减", [5, 5, 5], "c-mastered"),
    ]);

    const byId = new Map(entries.map((entry) => [entry.node_id, entry]));
    expect(byId.get("n-weak")!.level).toBe("weak");
    expect(byId.get("n-learning")!.level).toBe("learning");
    expect(byId.get("n-mastered")!.level).toBe("mastered");
    expect(byId.get("n-untouched")!.level).toBe("untouched");
    expect(byId.get("n-untouched")!.card_count).toBe(0);
    // 判定理由要能直接给人看，不能只有颜色
    expect(byId.get("n-mastered")!.reason).toContain("连续记住");
    expect(byId.get("n-weak")!.reason).toContain("1.54");
    expect(summarize_mastery(entries)).toEqual({
      weak: 1,
      learning: 1,
      mastered: 1,
      untouched: 1,
    });
  });

  it("关联不上的卡片被忽略；别名能对上节点；旧卡片缺字段不报错", () => {
    const entries = compute_mastery(
      [{ id: "n-alias", name: "函数单调性", subject: "数学", aliases: "单调性,函数单调性" }],
      [
        card("数学", "单调性", [5, 5, 5], "c-alias"),
        card("数学", "图谱里根本没有这个知识点", [2, 2, 2], "c-orphan"),
        { ...card("数学", "函数单调性", [], "c-legacy"), ease: undefined as unknown as number },
      ],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]!.card_count).toBe(2);
    // 别名卡是绿的、旧卡难度按默认 2.5 兜底，平均下来仍然是掌握
    expect(entries[0]!.level).toBe("mastered");
  });

  it("载入演示数据后图谱同时出现绿、黄、红三档，未学节点照旧标灰", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => `${TODAY}T09:00:00.000Z` },
      idGen: testIdGen,
    });
    await core.loadDemoData();

    const data = core.getKgMastery().data!;
    expect(Number(data["mastered"])).toBeGreaterThan(0);
    expect(Number(data["learning"])).toBeGreaterThan(0);
    expect(Number(data["weak"])).toBeGreaterThan(0);
    expect(Number(data["untouched"])).toBeGreaterThan(0);

    const entries = data["entries"] as KnowledgeMasteryEntry[];
    expect(entries).toHaveLength(core.store.kgNodes().length);

    // 反复载入演示数据不该把已经推进过的卡片再推一遍
    await core.loadDemoData();
    expect(core.getKgMastery().data!["mastered"]).toBe(data["mastered"]);
  });
});

describe("core v2：逾期风险预警与最小启动（G4）", () => {
  const TODAY = "2026-03-04";

  function riskItem(patch: Partial<AssignmentItem> = {}): AssignmentItem {
    return {
      id: `risk-${++idCounter}`,
      subject: "数学",
      title: "第三章习题",
      quantity: 20,
      unit: "题",
      due_date: "2026-03-05",
      estimated_minutes: 60,
      status: "pending",
      done_at: "",
      created_at: TODAY,
      source_text: "数学第三章习题1-20明天交",
      review_card_ids: [],
      plan_id: "",
      plan_version: null,
      original_due_date: "",
      rescheduled_at: "",
      ...patch,
    };
  }

  it("剩余量超过「剩余天数 × 日预算」八成才算可能逾期", () => {
    // 明天交 = 今天 + 明天，两天 × 60 分钟 = 120 分钟可用
    expect(assignment_risk(riskItem({ estimated_minutes: 60 }), TODAY, 60).at_risk).toBe(false);
    expect(assignment_risk(riskItem({ estimated_minutes: 96 }), TODAY, 60).at_risk).toBe(false);
    expect(assignment_risk(riskItem({ estimated_minutes: 120 }), TODAY, 60).at_risk).toBe(true);

    const tight = assignment_risk(riskItem({ estimated_minutes: 300 }), TODAY, 60);
    expect(tight.load).toBe(2.5);
    expect(tight.capacity_minutes).toBe(120);

    // 同样的量，截止日更远就不是风险了
    expect(
      assignment_risk(riskItem({ estimated_minutes: 300, due_date: "2026-03-11" }), TODAY, 60)
        .at_risk,
    ).toBe(false);
  });

  it("已完成不预警、已逾期交给红色信号、没有可用预算时直接算风险", () => {
    expect(assignment_risk(riskItem({ status: "done" }), TODAY, 60).at_risk).toBe(false);
    // 已逾期：剩余天数 0，不再报 at_risk（清单里已经有更重的红色「已逾期」）
    expect(assignment_risk(riskItem({ due_date: "2026-03-03" }), TODAY, 60).at_risk).toBe(false);
    // 日预算被课表挤成 0，只要还有量就是风险
    const noBudget = assignment_risk(riskItem({ estimated_minutes: 30 }), TODAY, 0);
    expect(noBudget.capacity_minutes).toBe(0);
    expect(noBudget.at_risk).toBe(true);
  });

  it("看板快照只标出真正排不开的那条", async () => {
    const core = createSynapseCore({
      clock: { nowIso: () => `${TODAY}T09:00:00.000Z` },
      idGen: testIdGen,
    });
    // 20 题 ≈ 60 分钟，明天交 → 60/(2×60)=0.5，安全
    await core.createAssignments("default", "数学第三章习题1-20明天交");
    let board = core.listAssignments("default").data as unknown as { at_risk_ids: string[] };
    expect(board.at_risk_ids).toEqual([]);

    // 100 页 ≈ 1000 分钟，明天交 → 早就超过 2 天 × 60 分钟的预算，提前亮黄灯
    await core.createAssignments("default", "物理练习册第1页到第100页明天交");
    board = core.listAssignments("default").data as unknown as { at_risk_ids: string[] };
    const items = (core.listAssignments("default").data as unknown as { items: AssignmentItem[] })
      .items;
    const risky = items.find((item) => item.subject === "物理")!;
    expect(risky.estimated_minutes).toBeGreaterThan(96);
    expect(board.at_risk_ids).toEqual([risky.id]);
  });

  it("先学 5 分钟：复用同一条打卡链路，但只记 5 分钟用时", () => {
    const core = createSynapseCore({
      clock: { nowIso: () => `${TODAY}T09:00:00.000Z` },
      idGen: testIdGen,
    });
    expect(core.addTodayItem("default", { title: "复习夹逼定理" }).success).toBe(true);

    const today = (core.getTodayPlan("default").data as Record<string, unknown>)["today"] as {
      items: Array<{ key: string; title: string; duration_minutes: number }>;
    };
    const target = today.items.find((item) => item.title === "复习夹逼定理")!;
    // 任务本身不止 5 分钟，所以「记 5 分钟」必须是真的覆盖，而不是碰巧相等
    expect(target.duration_minutes).toBeGreaterThan(5);

    expect(core.toggleTodayItem("default", target.key, 5).success).toBe(true);
    const record = core.store.get_progress("default")[target.key]!;
    expect(record.done).toBe(true);
    expect(record.actual_minutes).toBe(5);

    // 不传第三个参数时仍是老行为：按任务原时长记录
    expect(core.addTodayItem("default", { title: "整理错题" }).success).toBe(true);
    const nextToday = (core.getTodayPlan("default").data as Record<string, unknown>)["today"] as {
      items: Array<{ key: string; title: string; duration_minutes: number }>;
    };
    const plain = nextToday.items.find((item) => item.title === "整理错题")!;
    expect(core.toggleTodayItem("default", plain.key).success).toBe(true);
    expect(core.store.get_progress("default")[plain.key]!.actual_minutes).toBe(
      plain.duration_minutes,
    );
  });
});

describe("core v2：苏格拉底提示（G2）", () => {
  const TODAY = "2026-03-04";
  const fixedClock = { nowIso: () => `${TODAY}T09:00:00.000Z` };
  const NOTE = "函数与导数：含参函数单调性讨论要先求导，再按参数分类讨论。";

  /** 自称 deepseek 的假模型，吐固定的 JSON 提示。 */
  class HintLlm implements LlmProvider {
    readonly prompts: string[] = [];

    constructor(private readonly payload: Record<string, unknown>) {}

    describe(): Record<string, unknown> {
      return { provider: "deepseek", model: "hint-llm", status: "ready" };
    }

    async generateWithTools(): Promise<GenerateWithToolsResult> {
      return { tool_calls: [] };
    }

    async generateText(): Promise<string> {
      return "";
    }

    async generateJson(prompt: string): Promise<Record<string, unknown>> {
      this.prompts.push(prompt);
      return this.payload;
    }

    async *streamText(): AsyncIterable<string> {
      yield "";
    }
  }

  /** 造一张挂在真实资料上的复习卡：答案才有原文可取。 */
  function coreWithCard(): { core: SynapseCore; cardId: string } {
    const core = createSynapseCore({ clock: fixedClock, idGen: testIdGen });
    core.importDocument("default", "高三数学错题笔记.txt", NOTE);
    core.addReviewTopic("default", "数学", "含参函数单调性");
    return { core, cardId: core.store.get_reviews("default")[0]!.id };
  }

  it("有 Key 时由模型生成三级提示，并把提示缓存到卡片上", async () => {
    const { core, cardId } = coreWithCard();
    const llm = new HintLlm({
      hints: ["先想它属于函数哪一类问题", "把参数分开讨论", "第一步先求导"],
    });
    core.workflow.providers = { ...core.workflow.providers, llm };

    const result = await core.getReviewHints("default", cardId);
    expect(result.success).toBe(true);
    const data = result.data as unknown as ReviewHintResult;
    expect(data.hints).toHaveLength(3);
    expect(data.degraded).toBe(false);
    expect(data.cached).toBe(false);
    expect(data.filtered).toBe(0);

    // 提示词必须把标准答案交给模型，同时明确禁止泄露
    expect(llm.prompts[0]).toContain("含参函数单调性");
    expect(llm.prompts[0]).toContain("绝对不能出现在提示里");

    expect(core.store.get_reviews("default")[0]!.hint_texts).toEqual(data.hints);
  });

  it("重复点击直接读缓存，不再调模型", async () => {
    const { core, cardId } = coreWithCard();
    const llm = new HintLlm({ hints: ["提示一", "提示二", "提示三"] });
    core.workflow.providers = { ...core.workflow.providers, llm };

    await core.getReviewHints("default", cardId);
    expect(llm.prompts).toHaveLength(1);

    const second = await core.getReviewHints("default", cardId);
    expect(llm.prompts).toHaveLength(1);
    expect((second.data as unknown as ReviewHintResult).cached).toBe(true);
    expect((second.data as unknown as ReviewHintResult).hints).toEqual(["提示一", "提示二", "提示三"]);
  });

  it("没配 Key 时返回离线三级提示并标 degraded，绝不静默失败", async () => {
    const { core, cardId } = coreWithCard();

    const result = await core.getReviewHints("default", cardId);
    expect(result.success).toBe(true);
    expect(result.message).toContain("离线提示");
    const data = result.data as unknown as ReviewHintResult;
    expect(data.degraded).toBe(true);
    expect(data.hints).toHaveLength(3);
    // 离线提示是纯函数，不缓存——否则下次再点 `degraded` 就没法如实标记了
    expect(core.store.get_reviews("default")[0]!.hint_texts).toEqual([]);
  });

  it("模型把答案原话说出去时，那一条会被换成离线提示并计数", async () => {
    const { core, cardId } = coreWithCard();
    const llm = new HintLlm({
      hints: ["含参函数单调性讨论要先求导，再按参数分类讨论", "把参数分开讨论", "第一步先求导"],
    });
    core.workflow.providers = { ...core.workflow.providers, llm };

    const data = (await core.getReviewHints("default", cardId))
      .data as unknown as ReviewHintResult;
    expect(data.filtered).toBe(1);
    expect(data.hints[0]).not.toContain("含参函数单调性讨论要先求导");
    expect(data.hints[1]).toBe("把参数分开讨论");
    // 有泄露就不落缓存：下次点击相当于让模型重试一次
    expect(core.store.get_reviews("default")[0]!.hint_texts).toEqual([]);
  });

  it("答案只从用户自己的材料里取，取不到就留空并说明原因", async () => {
    const { core, cardId } = coreWithCard();
    const data = (await core.getReviewHints("default", cardId))
      .data as unknown as ReviewHintResult;
    expect(data.answer).toContain("含参函数单调性讨论要先求导");
    expect(data.answer_source).toContain("高三数学错题笔记.txt");

    // 队列里手动加的知识点没有对应资料，答案必须留空而不是编一个
    core.addReviewTopic("default", "物理", "刚体转动惯量");
    const other = core.store.get_reviews("default").find((item) => item.topic === "刚体转动惯量")!;
    const bare = (await core.getReviewHints("default", other.id))
      .data as unknown as ReviewHintResult;
    expect(bare.answer).toBe("");
    expect(bare.answer_source).toContain("还没有对应的资料");
  });

  it("泄露校验：连续 6 字重合才算泄露，太短的答案不判泄露", () => {
    expect(find_leaked_span("含参函数单调性讨论要先求导", "含参函数单调性讨论要先求导，再按参数分类")).toBe(
      "含参函数单调",
    );
    expect(find_leaked_span("单调性要怎么判断", "含参函数单调性讨论要先求导")).toBeNull();
    // 答案本身太短时不做判定，否则任何提示都会被误杀
    expect(find_leaked_span("先求导", "求导")).toBeNull();

    expect(
      hints_leak_answer(["含参函数单调性讨论要先求导"], "含参函数单调性讨论要先求导，再按参数分类"),
    ).toBe(true);
    expect(hints_leak_answer(["先想它属于函数哪一类", "把参数分开看"], "含参函数单调性讨论要先求导")).toBe(
      false,
    );
    expect(build_offline_hints("数学", "含参函数单调性")[0]).toContain("数学·含参函数单调性");
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
