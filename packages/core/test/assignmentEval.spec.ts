/**
 * 作业抽取质量评测（把「抽得准不准」变成数字）。
 *
 * 为什么单独一个文件：其余测试测的都是**确定性**（幂等、边界、字段形状），
 * 没有一条回答「模型/规则抽出来的作业对不对」。而截止日错一天，这个功能就从
 * 「帮你盯截止」变成「害你交晚」——必须量化。
 *
 * 口径：
 * - 抽取侧：句子 → 条目（科目 / 数量 / 单位 / 截止日），按顺序逐条比对。
 * - 判定侧：这句话到底是不是作业（`looks_like_assignment`），要求 100% 正确：
 *   误判会让「我想学」被当成作业，漏判会让作业掉进闲聊，两个方向都是产品事故。
 *
 * 固定“今天”是 2026-03-04（周三），所以 明天=03-05、后天=03-06、周五=03-06、
 * 下周一=03-09、下周三=03-11、下周五=03-13。
 */

import { describe, expect, it } from "vitest";

import {
  looks_like_assignment,
  parse_assignment_items,
} from "../src/domain/assignment.js";

const TODAY = "2026-03-04";

interface ExpectedItem {
  subject: string;
  quantity: number;
  unit: string;
  due: string;
}

interface EvalCase {
  text: string;
  items: ExpectedItem[];
}

/** 正样本：老师布置作业的真实句式。 */
const POSITIVE_CASES: EvalCase[] = [
  {
    text: "数学第三章习题1-20明天交",
    items: [{ subject: "数学", quantity: 20, unit: "题", due: "2026-03-05" }],
  },
  {
    text: "英语背Unit3单词周五默写",
    items: [{ subject: "英语", quantity: 0, unit: "", due: "2026-03-06" }],
  },
  {
    text: "物理第五章卷子一张明天交",
    items: [{ subject: "物理", quantity: 1, unit: "张", due: "2026-03-05" }],
  },
  {
    text: "语文作文800字下周一交",
    items: [{ subject: "语文", quantity: 800, unit: "字", due: "2026-03-09" }],
  },
  {
    text: "化学练习册第3页到第5页，后天交",
    items: [{ subject: "化学", quantity: 3, unit: "页", due: "2026-03-06" }],
  },
  {
    text: "生物实验报告一篇，下周五交",
    items: [{ subject: "生物", quantity: 1, unit: "篇", due: "2026-03-13" }],
  },
  {
    text: "数学卷子一张，后天交",
    items: [{ subject: "数学", quantity: 1, unit: "张", due: "2026-03-06" }],
  },
  {
    text: "英语默写单词30个，明天交",
    items: [{ subject: "英语", quantity: 30, unit: "个", due: "2026-03-05" }],
  },
  {
    // 「第5课」里的 5 是课次标识，不是数量
    text: "历史抄写第5课重点，明天交",
    items: [{ subject: "历史", quantity: 0, unit: "", due: "2026-03-05" }],
  },
  {
    text: "数学第三章习题1-20，明天交",
    items: [{ subject: "数学", quantity: 20, unit: "题", due: "2026-03-05" }],
  },
  {
    text: "语文文言文背诵两篇，下周一交",
    items: [{ subject: "语文", quantity: 2, unit: "篇", due: "2026-03-09" }],
  },
  {
    text: "计算机数据结构实验报告，下周一交",
    items: [{ subject: "计算机", quantity: 0, unit: "", due: "2026-03-09" }],
  },
  {
    text: "地理填图册第10页到第12页，明天交",
    items: [{ subject: "地理", quantity: 3, unit: "页", due: "2026-03-05" }],
  },
  {
    text: "政治练习题20道，周五交",
    items: [{ subject: "政治", quantity: 20, unit: "题", due: "2026-03-06" }],
  },
  {
    text: "化学方程式默写20个，明天交",
    items: [{ subject: "化学", quantity: 20, unit: "个", due: "2026-03-05" }],
  },
  {
    text: "数学错题整理10题，今天交",
    items: [{ subject: "数学", quantity: 10, unit: "题", due: "2026-03-04" }],
  },
  {
    text: "生物作业课本第30页习题1-5，后天交",
    items: [{ subject: "生物", quantity: 5, unit: "题", due: "2026-03-06" }],
  },
  {
    text: "物理实验报告一份，下周三交",
    items: [{ subject: "物理", quantity: 1, unit: "份", due: "2026-03-11" }],
  },
  {
    text: "政治背诵十个知识点，明天交",
    items: [{ subject: "政治", quantity: 10, unit: "个", due: "2026-03-05" }],
  },
  {
    text: "英语听写20个单词，明天交",
    items: [{ subject: "英语", quantity: 20, unit: "单词", due: "2026-03-05" }],
  },
  {
    text: "数学卷子一张明天交，英语作文一篇周五交",
    items: [
      { subject: "数学", quantity: 1, unit: "张", due: "2026-03-05" },
      { subject: "英语", quantity: 1, unit: "篇", due: "2026-03-06" },
    ],
  },
  {
    text: "语文周记一篇，下周五交",
    items: [{ subject: "语文", quantity: 1, unit: "篇", due: "2026-03-13" }],
  },
];

/** 负样本：不是作业，不能被判成作业。 */
const NEGATIVE_CASES: string[] = [
  "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟",
  "我想系统学一下线性代数",
  "明天开始背单词",
  "这道题我不会做，能讲讲吗",
  "老师今天讲得太快了",
  "我今天有点累",
];

interface Metrics {
  count: number;
  due: number;
  subject: number;
  quantity: number;
  total: number;
}

function evaluate(): { metrics: Metrics; failures: string[] } {
  const metrics: Metrics = { count: 0, due: 0, subject: 0, quantity: 0, total: 0 };
  const failures: string[] = [];

  for (const testCase of POSITIVE_CASES) {
    const drafts = parse_assignment_items(testCase.text, TODAY);
    const expected = testCase.items;
    if (drafts.length === expected.length) {
      metrics.count += 1;
    } else {
      failures.push(
        `[条目数] 「${testCase.text}」期望 ${expected.length} 条，实得 ${drafts.length} 条`,
      );
    }

    for (let index = 0; index < expected.length; index += 1) {
      const want = expected[index]!;
      const got = drafts[index];
      metrics.total += 1;
      if (!got) {
        failures.push(`[缺失] 「${testCase.text}」第 ${index + 1} 条没有解析出来`);
        continue;
      }
      if (got.due_date === want.due) {
        metrics.due += 1;
      } else {
        failures.push(`[截止日] 「${testCase.text}」期望 ${want.due}，实得 ${got.due_date}`);
      }
      if (got.subject === want.subject) {
        metrics.subject += 1;
      } else {
        failures.push(`[科目] 「${testCase.text}」期望 ${want.subject}，实得 ${got.subject}`);
      }
      if (got.quantity === want.quantity && got.unit === want.unit) {
        metrics.quantity += 1;
      } else {
        failures.push(
          `[数量] 「${testCase.text}」期望 ${want.quantity}${want.unit}，实得 ${got.quantity}${got.unit}`,
        );
      }
    }
  }

  for (const text of NEGATIVE_CASES) {
    if (looks_like_assignment(text)) {
      failures.push(`[误判] 「${text}」不是作业，却被判成作业`);
    }
  }

  return { metrics, failures };
}

describe("core v2：作业抽取质量评测", () => {
  const { metrics, failures } = evaluate();
  const rate = (hit: number) => hit / metrics.total;
  const countRate = metrics.count / POSITIVE_CASES.length;

  it("抽取准确率达标（截止日/数量/科目）", () => {
    // 失败明细打印出来，便于直接定位是哪条规则不灵
    if (failures.length) {
      console.log(`[eval] 作业抽取失败明细（${failures.length} 条）：\n${failures.join("\n")}`);
    }
    console.log(
      `[eval] 作业抽取：条目数 ${(countRate * 100).toFixed(1)}%｜` +
        `截止日 ${(rate(metrics.due) * 100).toFixed(1)}%｜` +
        `数量 ${(rate(metrics.quantity) * 100).toFixed(1)}%｜` +
        `科目 ${(rate(metrics.subject) * 100).toFixed(1)}%` +
        `（共 ${POSITIVE_CASES.length} 句 / ${metrics.total} 条）`,
    );

    expect(countRate).toBeGreaterThanOrEqual(0.9);
    expect(rate(metrics.due)).toBeGreaterThanOrEqual(0.9);
    expect(rate(metrics.quantity)).toBeGreaterThanOrEqual(0.85);
    expect(rate(metrics.subject)).toBeGreaterThanOrEqual(0.9);
  });

  it("不是作业的句子一律不能误判（判定侧要求 100%）", () => {
    for (const text of NEGATIVE_CASES) {
      expect(looks_like_assignment(text), text).toBe(false);
    }
  });
});
