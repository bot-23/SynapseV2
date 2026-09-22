/**
 * P1 验收测试：domain 翻译输出与 baseline/golden 黄金样本逐字一致。
 * 输入矩阵复制自 baseline/capture.py（保持同序、同键）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BlockPlanService } from "../src/domain/blockPlans.js";
import { RulePlanService } from "../src/domain/rulePlans.js";
import type { BlockPlan, StudyPlanRequest } from "../src/protocol/study.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(HERE, "../../../baseline/golden");

function loadGolden(name: string): unknown {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, name), "utf-8"));
}

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

describe("domain_rule_plan.json", () => {
  it("规则计划输出与黄金样本一致", () => {
    const actual = {
      study: rule.generate_rule_plan(makeRequest()),
      language: rule.generate_rule_plan(
        makeRequest({
          learning_goal: "我想提升英语四级词汇和阅读",
          available_days_per_week: 3,
          available_minutes_per_day: 45,
        }),
      ),
      assignment: rule.generate_rule_plan(
        makeRequest({
          learning_goal: "两周内完成操作系统课程实验报告",
          available_days_per_week: 7,
          available_minutes_per_day: 120,
        }),
      ),
      edge_single_day_15min: rule.generate_rule_plan(
        makeRequest({ available_days_per_week: 1, available_minutes_per_day: 15 }),
      ),
    };
    expect(actual).toEqual(loadGolden("domain_rule_plan.json"));
  });
});

describe("domain_helpers.json", () => {
  it("小函数矩阵与黄金样本一致", () => {
    const helperInputsTopic: Array<[string, string[]]> = [
      ["高等数学重点复习积分与极限", []],
      ["我要准备考研英语冲刺", []],
      ["  高数   复习  ", []],
      ["还有14天完成操作系统实验报告", []],
      ["", ["定积分", "微分方程", "级数", "多重积分"]],
    ];

    const pyStr = (value: unknown): string => (value === null ? "None" : String(value));

    const actual = {
      infer_plan_kind: Object.fromEntries(
        ["准备英语六级", "写课程论文报告", "复习高等数学", "准备 IELTS speaking"].map(
          (text) => [text, rule.infer_plan_kind(text)],
        ),
      ),
      infer_topic: Object.fromEntries(
        helperInputsTopic.map(([goal, wp]) => [
          `${goal}||${wp.join("/")}`,
          rule.infer_topic(goal, wp),
        ]),
      ),
      cleanup_topic: Object.fromEntries(
        ["我要复习高数还有14天", "每天60分钟考研英语", "本周完成实验报告", "想要准备期末考试"].map(
          (text) => [text, rule.cleanup_topic(text)],
        ),
      ),
      short_goal: Object.fromEntries(
        ["", "   ", "短目标", "这是一个非常非常长的学习目标用来验证超过二十四字符时会被截断并加上省略号"].map(
          (text) => [text, rule.short_goal(text)],
        ),
      ),
      duration: Object.fromEntries(
        ([[90, 0.4], [25, 0.35], [15, 0.5], [60, 0.05], [10, 0.9]] as Array<[number, number]>).map(
          ([daily, ratio]) => [`${daily}*${ratio}`, rule.duration(daily, ratio)],
        ),
      ),
      clamp_minutes: Object.fromEntries(
        ([
          ["abc", 30, 90],
          [null, 30, 90],
          [150, 30, 90],
          [-5, 30, 90],
          ["45", 30, 90],
        ] as Array<[unknown, number, number]>).map(([v, fb, up]) => [
          `${pyStr(v)}/${fb}/${up}`,
          rule.clamp_minutes(v, fb, up),
        ]),
      ),
      coerce_task_type: Object.fromEntries(
        (["learn", "practice", "review", "mock_exam", "exam", null, "", " Learn "] as unknown[]).map(
          (v) => [pyStr(v), rule.coerce_task_type(v)],
        ),
      ),
      clean_text: Object.fromEntries(
        (["  多处\t空白\n混排  ", null, 123, ""] as unknown[]).map((v) => [
          pyStr(v),
          rule.clean_text(v),
        ]),
      ),
    };
    expect(actual).toEqual(loadGolden("domain_helpers.json"));
  });
});

describe("domain_block_plan.json", () => {
  it("积木计划输出与黄金样本一致", () => {
    const blockDefault = block.build_block_plan(makeRequest(), []);
    const blockPreferred = block.build_block_plan(
      makeRequest({
        preferences: ["先做题找问题", "题练结合", "考前冲刺", "时间约束：晚上只有 30 分钟"],
      }),
      [],
    );
    const blockEvidence = block.build_block_plan(makeRequest(), [
      "资料命中[高数讲义]: 积分的换元法是本次考试重点",
      "普通检索片段",
    ]);
    const blockAlternate: BlockPlan = {
      ...blockDefault,
      blocks: blockDefault.blocks.map((b) => ({ ...b, selectedIndex: 1 })),
    };

    const actual = {
      default: blockDefault,
      preferred: blockPreferred,
      evidence: blockEvidence,
      expand_default: block.expand_to_weekly_plan(blockDefault, makeRequest()),
      expand_alternate: block.expand_to_weekly_plan(blockAlternate, makeRequest()),
      expand_single_day: block.expand_to_weekly_plan(
        blockDefault,
        makeRequest({ available_days_per_week: 1 }),
      ),
    };
    expect(actual).toEqual(loadGolden("domain_block_plan.json"));
  });
});
