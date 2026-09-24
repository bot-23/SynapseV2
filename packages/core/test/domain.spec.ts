/**
 * domain 层的规则计划 / 积木计划 / 小函数工具测试。
 *
 * 这里断言的是「当前实现的行为」：输入矩阵覆盖正常路径与边界（空输入、单日、
 * 极短时长、非法分钟数）。修改行为时这些用例会失败，需要显式确认是有意为之。
 */

import { describe, expect, it } from "vitest";

import { BlockPlanService } from "../src/domain/blockPlans.js";
import { RulePlanService } from "../src/domain/rulePlans.js";
import type { BlockPlan, StudyPlanRequest } from "../src/protocol/study.js";

const NORMALIZED_REQUEST: StudyPlanRequest = {
  user_id: "default",
  current_level: "大二",
  learning_goal: "准备高等数学期末考试",
  available_days_per_week: 5,
  available_minutes_per_day: 90,
  deadline: "2026-10-02",
  weak_points: ["积分", "极限"],
  preferences: [],
  need_user_confirmation: true,
};

function makeRequest(overrides: Partial<StudyPlanRequest> = {}): StudyPlanRequest {
  return { ...NORMALIZED_REQUEST, ...overrides };
}

const rule = new RulePlanService();
const block = new BlockPlanService({
  infer_topic: (goal, weakPoints) => rule.infer_topic(goal, weakPoints),
  short_goal: (text, limit) => rule.short_goal(text, limit),
  duration: (daily, ratio) => rule.duration(daily, ratio),
});

describe("规则计划：按目标类型产出可执行的一周计划", () => {
  it("学习类目标：天数取可用天数与 5 的较小值，任务时长按比例分配", () => {
    const result = rule.generate_rule_plan(makeRequest());

    expect(result.status).toBe("fallback");
    expect(result.summary).toContain("未启用 DeepSeek");
    expect(result.next_actions).toHaveLength(1);
    expect(result.final_message).toBe(
      "我先按你输入的「准备高等数学期末考试」整理了一版可执行计划，" +
        "重点围绕 积分、极限。我已把截止时间 2026-10-02 作为节奏参考。",
    );

    expect(result.weekly_plan.map((day) => day.day_index)).toEqual([1, 2, 3, 4, 5]);
    expect(result.weekly_plan.map((day) => day.focus)).toEqual([
      "高等数学期末考试概念梳理",
      "高等数学期末考试专项练习",
      "高等数学期末考试综合检查",
      "高等数学期末考试综合检查",
      "高等数学期末考试综合检查",
    ]);
    expect(result.weekly_plan[0]!.tasks.map((task) => task.duration_minutes)).toEqual([36, 31]);
    expect(result.weekly_plan[0]!.tasks[0]).toEqual({
      title: "梳理 高等数学期末考试 的核心概念和公式",
      task_type: "learn",
      duration_minutes: 36,
      reason: "先建主干，后续练习不容易发散。",
    });
    expect(result.weekly_plan[0]!.carry_over).toEqual([]);
  });

  it("语言类目标：走输入 → 专项 → 输出的三段模板", () => {
    const result = rule.generate_rule_plan(
      makeRequest({
        learning_goal: "我想提升英语四级词汇和阅读",
        available_days_per_week: 3,
        available_minutes_per_day: 45,
      }),
    );

    expect(result.weekly_plan).toHaveLength(3);
    expect(result.weekly_plan.map((day) => day.focus)).toEqual([
      "英语四级词汇和阅读输入与词汇整理",
      "英语四级词汇和阅读专项练习",
      "英语四级词汇和阅读输出训练",
    ]);
    expect(result.weekly_plan[2]!.tasks[0]!.task_type).toBe("mock_exam");
    expect(result.weekly_plan[0]!.tasks.map((task) => task.duration_minutes)).toEqual([15, 15]);
  });

  it("作业类目标：先拆解要求，再推进内容，最后修订提交", () => {
    const result = rule.generate_rule_plan(
      makeRequest({
        learning_goal: "两周内完成操作系统课程实验报告",
        available_days_per_week: 7,
        available_minutes_per_day: 120,
      }),
    );

    expect(result.weekly_plan).toHaveLength(5);
    expect(result.weekly_plan[0]!.focus).toBe("操作系统课程实验报告任务拆解");
    expect(result.weekly_plan[2]!.focus).toBe("操作系统课程实验报告修订提交");
    expect(result.weekly_plan[2]!.tasks.map((task) => task.task_type)).toEqual([
      "review",
      "mock_exam",
    ]);
  });

  it("只有一天且每天 15 分钟时，任务时长被抬到下限 10 分钟", () => {
    const result = rule.generate_rule_plan(
      makeRequest({ available_days_per_week: 1, available_minutes_per_day: 15 }),
    );

    expect(result.weekly_plan).toHaveLength(1);
    expect(result.weekly_plan[0]!.tasks.map((task) => task.duration_minutes)).toEqual([10, 10]);
  });
});

describe("规则计划：小函数矩阵", () => {
  it("infer_plan_kind 按关键词区分语言 / 作业 / 学习", () => {
    expect(rule.infer_plan_kind("准备英语六级")).toBe("language");
    expect(rule.infer_plan_kind("写课程论文报告")).toBe("assignment");
    expect(rule.infer_plan_kind("复习高等数学")).toBe("study");
    expect(rule.infer_plan_kind("准备 IELTS speaking")).toBe("language");
  });

  it("infer_topic 从目标里剥掉意图词与时间词", () => {
    const cases: Array<[string, string[], string]> = [
      ["高等数学重点复习积分与极限", [], "积分与极限"],
      ["我要准备考研英语冲刺", [], "考研英语冲刺"],
      ["  高数   复习  ", [], "高数复习"],
      ["还有14天完成操作系统实验报告", [], "操作系统实验报告"],
      // 空目标时 short_goal 兜底成「当前学习目标」，所以不会走到薄弱点分支
      ["", ["定积分", "微分方程", "级数", "多重积分"], "当前学习目标"],
    ];
    for (const [goal, weakPoints, expected] of cases) {
      expect(rule.infer_topic(goal, weakPoints)).toBe(expected);
    }
  });

  it("cleanup_topic 去掉时间词、量词与开头的意图词", () => {
    expect(rule.cleanup_topic("我要复习高数还有14天")).toBe("复习高数");
    expect(rule.cleanup_topic("每天60分钟考研英语")).toBe("考研英语");
    expect(rule.cleanup_topic("本周完成实验报告")).toBe("完成实验报告");
    expect(rule.cleanup_topic("想要准备期末考试")).toBe("期末考试");
  });

  it("short_goal 空输入兜底、超长截断加省略号", () => {
    expect(rule.short_goal("")).toBe("当前学习目标");
    expect(rule.short_goal("   ")).toBe("当前学习目标");
    expect(rule.short_goal("短目标")).toBe("短目标");
    expect(
      rule.short_goal("这是一个非常非常长的学习目标用来验证超过二十四字符时会被截断并加上省略号"),
    ).toBe("这是一个非常非常长的学习目标用来验证超过二十四字…");
  });

  it("duration 夹在 [10, 每日可用分钟] 区间内", () => {
    expect(rule.duration(90, 0.4)).toBe(36);
    expect(rule.duration(25, 0.35)).toBe(10);
    expect(rule.duration(15, 0.5)).toBe(10);
    expect(rule.duration(60, 0.05)).toBe(10);
    expect(rule.duration(10, 0.9)).toBe(10);
  });

  it("clamp_minutes 非法值回落默认、越界被夹住", () => {
    expect(rule.clamp_minutes("abc", 30, 90)).toBe(30);
    expect(rule.clamp_minutes(null, 30, 90)).toBe(30);
    expect(rule.clamp_minutes(150, 30, 90)).toBe(90);
    expect(rule.clamp_minutes(-5, 30, 90)).toBe(0);
    expect(rule.clamp_minutes("45", 30, 90)).toBe(45);
  });

  it("coerce_task_type 只认白名单，其余回落 practice", () => {
    const cases: Array<[unknown, string]> = [
      ["learn", "learn"],
      ["practice", "practice"],
      ["review", "review"],
      ["mock_exam", "mock_exam"],
      ["exam", "practice"],
      [null, "practice"],
      ["", "practice"],
      [" Learn ", "practice"],
    ];
    for (const [value, expected] of cases) {
      expect(rule.coerce_task_type(value)).toBe(expected);
    }
  });

  it("clean_text 只接受字符串，空白折叠成单个空格", () => {
    expect(rule.clean_text("  多处\t空白\n混排  ")).toBe("多处 空白 混排");
    expect(rule.clean_text(null)).toBe("");
    expect(rule.clean_text(123)).toBe("");
    expect(rule.clean_text("")).toBe("");
  });
});

describe("积木计划：Day 1 分块替换与展开成周", () => {
  it("默认四块，时长按 诊断 / 核心 / 练习 / 复盘 切分且不超过每日上限", () => {
    const plan = block.build_block_plan(makeRequest(), []);

    expect(plan.title).toBe("积木计划模式");
    expect(plan.day).toBe("Day 1");
    expect(plan.limitMinutes).toBe(90);
    expect(plan.blocks.map((item) => item.id)).toEqual([
      "diagnosis",
      "core-study",
      "practice",
      "review",
    ]);
    expect(plan.blocks.map((item) => item.selectedIndex)).toEqual([0, 0, 0, 0]);
    // 15 + 43 + 22 + 10 = 90，正好用满当天可用时间
    expect(plan.blocks.map((item) => item.options[item.selectedIndex]!.duration)).toEqual([
      15, 43, 22, 10,
    ]);
    expect(plan.blocks.flatMap((item) => item.options).every((option) => option.duration >= 0)).toBe(
      true,
    );
  });

  it("偏好命中时切换默认选中项，并记录时间约束", () => {
    const plan = block.build_block_plan(
      makeRequest({
        preferences: ["先做题找问题", "题练结合", "考前冲刺", "时间约束：晚上只有 30 分钟"],
      }),
      [],
    );

    expect(plan.blocks.map((item) => item.selectedIndex)).toEqual([0, 1, 1, 1]);
    expect(plan.description).toContain("已额外考虑你的时间约束：晚上只有 30 分钟。");
  });

  it("资料命中会写进核心学习块的说明里", () => {
    const plan = block.build_block_plan(makeRequest(), [
      "资料命中[高数讲义]: 积分的换元法是本次考试重点",
      "普通检索片段",
    ]);

    const coreStudy = plan.blocks.find((item) => item.id === "core-study")!;
    expect(coreStudy.options[0]!.detail).toBe("积分的换元法是本次考试重点");
  });

  it("展开成周：第一天沿用选中的积木，后续天数补齐到可用天数上限", () => {
    const plan = block.build_block_plan(makeRequest(), []);
    const weekly = block.expand_to_weekly_plan(plan, makeRequest());

    expect(weekly.map((day) => day.day_index)).toEqual([1, 2, 3, 4, 5]);
    expect(weekly[0]!.focus).toBe("学习诊断 / 核心学习");
    expect(weekly[0]!.tasks).toHaveLength(4);
    expect(weekly[0]!.carry_over).toEqual([
      "知识点快速诊断",
      "高等数学期末考试 核心概念集中复习",
      "高等数学期末考试 典型题限时训练",
      "十分钟学习复盘",
    ]);
    expect(weekly.slice(1).every((day) => day.tasks.length > 0)).toBe(true);
  });

  it("展开成周：换一个积木选项，第一天任务随之改变", () => {
    const plan = block.build_block_plan(makeRequest(), []);
    const alternate: BlockPlan = {
      ...plan,
      blocks: plan.blocks.map((item) => ({ ...item, selectedIndex: 1 })),
    };
    const weekly = block.expand_to_weekly_plan(alternate, makeRequest());

    expect(weekly[0]!.tasks[1]!.title).toBe("教材例题精读");
    expect(weekly[0]!.tasks[1]!.task_type).toBe("learn");
  });

  it("只安排一天时不补后续天数", () => {
    const payload = makeRequest({ available_days_per_week: 1 });
    const weekly = block.expand_to_weekly_plan(block.build_block_plan(payload, []), payload);

    expect(weekly).toHaveLength(1);
    expect(weekly[0]!.day_index).toBe(1);
  });
});
