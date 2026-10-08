/**
 * 测验判分 + 错题本回归测试。
 *
 * 这是此前缺失的「学 → 练 → 测 → 补」闭环：判分必须确定性、离线可复现，
 * 错题必须真的沉淀下来并进入复习队列，否则错题本只是个摆设。
 */

import { describe, expect, it } from "vitest";

import { createSynapseCore } from "../src/application/core.js";
import { MemoryKvStore } from "../src/storage/kv.js";
import { grade_quiz, parse_quiz_json, type QuizQuestion } from "../src/domain/quiz.js";

const fixedClock = { nowIso: () => "2026-03-04T09:00:00.000Z" };

function question(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q1",
    subject: "高中数学",
    topic: "导数与单调性",
    stem: "f'(x) > 0 说明什么？",
    options: ["函数单调递增", "函数单调递减", "取到极值", "无法判断"],
    answer_index: 0,
    ...overrides,
  };
}

describe("测验：解析与判分", () => {
  it("解析模型 JSON：越界答案、选项不足的题一律丢弃", () => {
    const parsed = parse_quiz_json(
      {
        questions: [
          { stem: "有效题", options: ["A", "B", "C", "D"], answer_index: 2 },
          { stem: "答案越界", options: ["A", "B"], answer_index: 5 },
          { stem: "只有一个选项", options: ["A"], answer_index: 0 },
          { stem: "", options: ["A", "B"], answer_index: 0 },
        ],
      },
      "数学",
      "导数",
    );
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.answer_index).toBe(2);
    // 未提供 subject/topic 时用兜底值补齐
    expect(parsed[0]!.subject).toBe("数学");
    expect(parsed[0]!.topic).toBe("导数");
  });

  it("判分：未作答与越界都算错", () => {
    const questions = [
      question({ id: "q1", answer_index: 0 }),
      question({ id: "q2", answer_index: 1 }),
      question({ id: "q3", answer_index: 2 }),
    ];
    const grade = grade_quiz(questions, [0, 3, -1]);
    expect(grade.total).toBe(3);
    expect(grade.correct).toBe(1);
    expect(grade.score).toBe(33);
    expect(grade.wrong_indexes).toEqual([1, 2]);
  });
});

describe("错题本闭环：做错 → 入本 → 进复习", () => {
  it("交卷后错题自动进错题本，并排进复习队列", () => {
    const core = createSynapseCore({ kv: new MemoryKvStore(), clock: fixedClock });
    const questions = [
      question({ id: "q1", topic: "导数与单调性", answer_index: 0 }),
      question({ id: "q2", topic: "数列错位相减", answer_index: 1, stem: "错位相减要讨论什么？" }),
    ];

    // 第 1 题答对，第 2 题答错
    const result = core.submitQuiz("default", { questions, answers: [0, 0] });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect((data["grade"] as { score: number }).score).toBe(50);
    expect((data["wrong_items"] as unknown[]).length).toBe(1);

    const errors = core.listErrorItems("default").data as Record<string, unknown>;
    expect(errors["total"]).toBe(1);
    const item = (errors["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item["subject"]).toBe("高中数学");
    expect(item["topic"]).toBe("数列错位相减");
    expect(item["source"]).toBe("quiz");
    // 正确答案被记进错题，方便复习时对照
    expect(String(item["answer"]).length).toBeGreaterThan(0);

    // 错题的知识点进入了复习队列
    const reviews = core.listReviews("default").data as Record<string, unknown>;
    const keys = (reviews["items"] as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toContain("高中数学::数列错位相减");
  });

  it("同一道题重复做错不会重复入本", () => {
    const core = createSynapseCore({ clock: fixedClock });
    const questions = [question({ id: "q1", answer_index: 0 })];
    core.submitQuiz("default", { questions, answers: [1] });
    core.submitQuiz("default", { questions, answers: [1] });
    expect(core.listErrorItems("default").data?.["total"]).toBe(1);
  });

  it("手动录入可判重、可删除", () => {
    const core = createSynapseCore({ clock: fixedClock });
    const first = core.addErrorItem("default", {
      subject: "高中物理",
      topic: "受力分析",
      question: "斜面上物体的摩擦力方向？",
      answer: "与相对运动趋势相反",
    });
    expect(first.success).toBe(true);

    const dup = core.addErrorItem("default", {
      subject: "高中物理",
      topic: "受力分析",
      question: "斜面上物体的摩擦力方向？",
    });
    expect(dup.success).toBe(false);

    const items = core.listErrorItems("default").data?.["items"] as Array<{ id: string }>;
    expect(items.length).toBe(1);
    const removed = core.removeErrorItem("default", items[0]!.id);
    expect(removed.success).toBe(true);
    expect(core.listErrorItems("default").data?.["total"]).toBe(0);
  });

  it("缺少题目 / 题目列表为空时返回失败", () => {
    const core = createSynapseCore({ clock: fixedClock });
    expect(core.addErrorItem("default", {}).success).toBe(false);
    expect(core.submitQuiz("default", { questions: [], answers: [] }).success).toBe(false);
  });
});

describe("测验：无模型时诚实失败", () => {
  it("没配 Key 时出题返回失败，而不是造假题", async () => {
    const core = createSynapseCore({ clock: fixedClock });
    const result = await core.generateQuiz("default", { subject: "数学", topic: "导数" });
    expect(result.success).toBe(false);
  });
});
