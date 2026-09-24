/**
 * 规则计划服务（纯函数，无 IO）。
 * 翻译自 Synapse/backend/app/domain/rule_plans.py，语义逐字保留。
 */

import type {
  RulePlanResult,
  StudyDayPlan,
  StudyPlanRequest,
  TaskType,
} from "../protocol/study.js";
import { pyInt, pyTruncInt, stripChars } from "./pyCompat.js";

interface RuleTemplateTask {
  title: string;
  task_type: TaskType;
  ratio: number;
  reason: string;
}

interface RuleTemplate {
  focus: string;
  tasks: RuleTemplateTask[];
}

const PUNCT_SPLIT_RE = /[，。；;,.!?！？\n]/;

export class RulePlanService {
  generate_rule_plan(payload: StudyPlanRequest): RulePlanResult {
    const topic = this.infer_topic(payload.learning_goal, payload.weak_points);
    const planKind = this.infer_plan_kind(payload.learning_goal);
    const weeklyPlan = this.generate_rule_weekly_plan(payload, topic, planKind);

    const focus = payload.weak_points.length
      ? payload.weak_points.slice(0, 3).join("、")
      : topic;
    const deadlineNote = payload.deadline
      ? `我已把截止时间 ${payload.deadline} 作为节奏参考。`
      : "";
    const finalMessage =
      `我先按你输入的「${this.short_goal(payload.learning_goal)}」` +
      `整理了一版可执行计划，重点围绕 ${focus}。${deadlineNote}`;

    return {
      weekly_plan: weeklyPlan,
      final_message: finalMessage,
      next_actions: [
        "补充考试时间、每天可用时间或薄弱点，可以让计划更贴近真实约束。",
      ],
      status: "fallback",
      summary: "当前后端未启用 DeepSeek，已按用户输入和可用时间生成规则计划。",
    };
  }

  generate_rule_weekly_plan(
    payload: StudyPlanRequest,
    topic: string,
    planKind: string,
  ): StudyDayPlan[] {
    const totalDays = Math.min(payload.available_days_per_week, 5);
    const templates = this.rule_templates_for_kind(planKind, topic);
    const dayPlans: StudyDayPlan[] = [];

    for (let dayIndex = 1; dayIndex <= totalDays; dayIndex += 1) {
      const template = templates[Math.min(dayIndex - 1, templates.length - 1)]!;
      const tasks = template.tasks.map((item) => ({
        title: item.title,
        task_type: item.task_type,
        duration_minutes: this.duration(payload.available_minutes_per_day, item.ratio),
        reason: item.reason,
      }));
      dayPlans.push({
        day_index: dayIndex,
        focus: template.focus,
        tasks,
        carry_over: [],
      });
    }
    return dayPlans;
  }

  rule_templates_for_kind(planKind: string, topic: string): RuleTemplate[] {
    if (planKind === "language") {
      return [
        {
          focus: `${topic}输入与词汇整理`,
          tasks: [
            {
              title: `整理 ${topic} 高频词汇和表达`,
              task_type: "learn",
              ratio: 0.35,
              reason: "语言类任务先补输入材料，后续练习才有抓手。",
            },
            {
              title: `完成 ${topic} 句子跟读或默写`,
              task_type: "practice",
              ratio: 0.35,
              reason: "把被动认识转成主动输出。",
            },
          ],
        },
        {
          focus: `${topic}专项练习`,
          tasks: [
            {
              title: `做一组 ${topic} 阅读或语法题`,
              task_type: "practice",
              ratio: 0.5,
              reason: "用题目暴露真实薄弱环节。",
            },
            {
              title: `复盘 ${topic} 错题并补充例句`,
              task_type: "review",
              ratio: 0.3,
              reason: "语言错题需要沉淀为可复用表达。",
            },
          ],
        },
        {
          focus: `${topic}输出训练`,
          tasks: [
            {
              title: `围绕 ${topic} 完成一次限时写作或口述`,
              task_type: "mock_exam",
              ratio: 0.45,
              reason: "用限时输出检查能否真正调用知识。",
            },
            {
              title: `修订 ${topic} 输出中的 3 个问题`,
              task_type: "review",
              ratio: 0.3,
              reason: "及时修订比单纯继续刷题更有效。",
            },
          ],
        },
      ];
    }

    if (planKind === "assignment") {
      return [
        {
          focus: `${topic}任务拆解`,
          tasks: [
            {
              title: `列出 ${topic} 的交付要求和评分点`,
              task_type: "learn",
              ratio: 0.3,
              reason: "先明确交付标准，避免后面返工。",
            },
            {
              title: `搭建 ${topic} 的初版结构`,
              task_type: "practice",
              ratio: 0.45,
              reason: "先产出骨架，后续才能逐步填充。",
            },
          ],
        },
        {
          focus: `${topic}内容推进`,
          tasks: [
            {
              title: `完成 ${topic} 的核心内容草稿`,
              task_type: "practice",
              ratio: 0.55,
              reason: "把最难的主体内容提前完成。",
            },
            {
              title: `检查 ${topic} 中不确定的资料或公式`,
              task_type: "review",
              ratio: 0.25,
              reason: "及时标出风险点，避免最后集中爆雷。",
            },
          ],
        },
        {
          focus: `${topic}修订提交`,
          tasks: [
            {
              title: `按要求修订 ${topic} 并补齐格式`,
              task_type: "review",
              ratio: 0.45,
              reason: "提交前的格式和完整性会直接影响结果。",
            },
            {
              title: `做一次 ${topic} 提交前自检`,
              task_type: "mock_exam",
              ratio: 0.25,
              reason: "用清单方式降低遗漏概率。",
            },
          ],
        },
      ];
    }

    return [
      {
        focus: `${topic}概念梳理`,
        tasks: [
          {
            title: `梳理 ${topic} 的核心概念和公式`,
            task_type: "learn",
            ratio: 0.4,
            reason: "先建主干，后续练习不容易发散。",
          },
          {
            title: `定位 ${topic} 的易错例题`,
            task_type: "practice",
            ratio: 0.35,
            reason: "把目标转成当天可执行的练习。",
          },
        ],
      },
      {
        focus: `${topic}专项练习`,
        tasks: [
          {
            title: `完成一组 ${topic} 针对性练习`,
            task_type: "practice",
            ratio: 0.5,
            reason: "练习阶段优先消化前一天梳理的内容。",
          },
          {
            title: `复盘 ${topic} 错题并补一个知识缺口`,
            task_type: "review",
            ratio: 0.3,
            reason: "避免只刷题不归纳。",
          },
        ],
      },
      {
        focus: `${topic}综合检查`,
        tasks: [
          {
            title: `做一次 ${topic} 限时小测`,
            task_type: "mock_exam",
            ratio: 0.45,
            reason: "验证计划是否真的覆盖关键问题。",
          },
          {
            title: `整理 ${topic} 的错因清单`,
            task_type: "review",
            ratio: 0.35,
            reason: "把复盘结果变成下一轮计划输入。",
          },
        ],
      },
    ];
  }

  infer_plan_kind(text: string): string {
    const lowered = text.toLowerCase();
    if (
      ["英语", "单词", "词汇", "阅读", "写作", "四级", "六级", "ielts", "toefl"].some(
        (keyword) => lowered.includes(keyword),
      )
    ) {
      return "language";
    }
    if (
      ["作业", "报告", "论文", "实验", "项目", "presentation", "ppt"].some((keyword) =>
        lowered.includes(keyword),
      )
    ) {
      return "assignment";
    }
    return "study";
  }

  infer_topic(goal: string, weakPoints: string[]): string {
    let cleaned = stripChars(goal.replace(/\s+/g, " "), " ，。,.");
    if (cleaned.includes("重点")) {
      const subject = this.cleanup_topic(cleaned.split(PUNCT_SPLIT_RE)[0]!);
      const focusTail = this.cleanup_topic(
        cleaned.slice(cleaned.indexOf("重点") + "重点".length),
      );
      if (subject && focusTail && !subject.includes(focusTail)) {
        return this.short_goal(`${subject}${focusTail}`);
      }
    }

    for (const marker of ["复习", "学习", "准备", "完成", "搞定", "冲刺", "提升", "掌握"]) {
      if (cleaned.includes(marker)) {
        const tail = stripChars(
          cleaned.slice(cleaned.indexOf(marker) + marker.length),
          " ：:，。,.",
        );
        if (tail) {
          cleaned = tail;
          break;
        }
      }
    }

    cleaned = (cleaned.split(PUNCT_SPLIT_RE)[0] ?? "").trim();
    const topic = this.short_goal(this.cleanup_topic(cleaned) || goal);
    if (!topic && weakPoints.length) {
      return weakPoints.slice(0, 3).join("、");
    }
    return topic;
  }

  cleanup_topic(text: string): string {
    let cleaned = text.replace(/\s+/g, "");
    cleaned = cleaned.replace(/(还有?|还剩)?\d{1,3}天/g, "");
    cleaned = cleaned.replace(/每[天周]\d{1,3}分钟/g, "");
    cleaned = cleaned.replace(/每[天周]\d(?:\.\d)?小时/g, "");
    cleaned = cleaned.replace(/(这周|本周|下周|两周内|一周内|今天|明天|后天)/g, "");
    cleaned = cleaned.replace(/^(?:(?:我想|我要|想要|需要|要|准备|计划)+)/, "");
    cleaned = stripChars(cleaned, " ：:，。,.、");
    return cleaned;
  }

  short_goal(text: string, limit = 24): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "当前学习目标";
    }
    return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
  }

  duration(dailyMinutes: number, ratio: number): number {
    const value = pyTruncInt(dailyMinutes * ratio);
    return Math.max(10, Math.min(dailyMinutes, value));
  }

  clamp_minutes(value: unknown, fallback: number, upper: number): number {
    let minutes: number;
    try {
      minutes = pyInt(value);
    } catch {
      minutes = fallback;
    }
    return Math.max(0, Math.min(Math.max(0, upper), minutes));
  }

  coerce_task_type(value: unknown): string {
    const normalized = String(value ?? "").trim();
    return ["learn", "practice", "review", "mock_exam"].includes(normalized)
      ? normalized
      : "practice";
  }

  clean_text(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }
    return value.replace(/\s+/g, " ").trim();
  }
}
