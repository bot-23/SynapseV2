/**
 * 积木计划服务（纯函数，无 IO）。
 * 翻译自 Synapse/backend/app/domain/block_plans.py，语义逐字保留；
 * 输出以 baseline/golden/domain_block_plan.json 为冻结基线。
 */

import type {
  BlockItem,
  BlockOption,
  BlockPlan,
  StudyDayPlan,
  StudyPlanRequest,
  StudyTask,
  TaskType,
} from "../protocol/study";
import { floorDiv, replaceFirst } from "./pyCompat";

interface BlockPlanStyle {
  diagnosis_style: string;
  core_style: string;
  practice_style: string;
  review_style: string;
  selected_titles: Record<string, string>;
  durations: Record<string, number>;
}

interface FollowupTemplateTask {
  title: string;
  task_type: TaskType;
  ratio: number;
  reason: string;
}

interface FollowupTemplate {
  focus: string;
  carry_over: string[];
  tasks: FollowupTemplateTask[];
}

export interface BlockPlanDeps {
  infer_topic: (goal: string, weakPoints: string[]) => string;
  short_goal: (text: string, limit?: number) => string;
  duration: (dailyMinutes: number, ratio: number) => number;
}

export class BlockPlanService {
  constructor(private readonly deps: BlockPlanDeps) {}

  build_block_plan(payload: StudyPlanRequest, retrievedContext: string[]): BlockPlan {
    const limit = payload.available_minutes_per_day;
    const weakPointText = payload.weak_points.length
      ? payload.weak_points.join("、")
      : this.deps.infer_topic(payload.learning_goal, payload.weak_points);
    const focusPreference = payload.preferences.join(" ");
    const coreSelectedIndex = focusPreference.includes("先做题找问题") ? 1 : 0;
    const practiceSelectedIndex = focusPreference.includes("题练结合") ? 1 : 0;
    const reviewSelectedIndex = focusPreference.includes("考前冲刺") ? 1 : 0;
    const topic = this.deps.infer_topic(payload.learning_goal, payload.weak_points);
    const evidenceHit = retrievedContext.find((item) => item.startsWith("资料命中["));
    let evidenceHint = evidenceHit ? replaceFirst(evidenceHit, "资料命中[", "") : "";
    evidenceHint = evidenceHint.includes("]:")
      ? evidenceHint.slice(evidenceHint.indexOf("]:") + 2).trim()
      : evidenceHint;
    const constraintPreference = payload.preferences.find((preference) =>
      preference.startsWith("时间约束："),
    );
    const constraintNote = constraintPreference
      ? constraintPreference.replaceAll("时间约束：", "")
      : "";

    const diagDur = Math.min(15, floorDiv(limit, 5));
    const reviewDur = Math.min(10, floorDiv(limit, 8));
    const remaining = limit - diagDur - reviewDur;
    const coreDur = Math.min(remaining, Math.max(15, floorDiv(remaining * 2, 3)));
    const practiceDur = Math.max(0, remaining - coreDur);

    return {
      title: "积木计划模式",
      description:
        "我先把 Day 1 拆成可替换的学习计划块，你可以逐块替换，不用整版重做。" +
        (constraintNote ? ` 已额外考虑你的时间约束：${constraintNote}。` : ""),
      day: "Day 1",
      limitMinutes: limit,
      blocks: [
        {
          id: "diagnosis",
          label: "学习诊断",
          selectedIndex: 0,
          options: [
            {
              title: "知识点快速诊断",
              detail: `围绕 ${weakPointText} 先做小测，快速定位真正卡点。`,
              duration: diagDur,
            },
            {
              title: "错题回顾诊断",
              detail: "从最近错题或作业里找反复出错的题型。",
              duration: Math.max(diagDur, Math.min(20, floorDiv(limit, 3))),
            },
          ],
        },
        {
          id: "core-study",
          label: "核心学习",
          selectedIndex: coreSelectedIndex,
          options: [
            {
              title: `${topic} 核心概念集中复习`,
              detail: evidenceHint
                ? evidenceHint.slice(0, 80)
                : `先把 ${topic} 的定义、公式和典型思路过一遍。`,
              duration: coreDur,
            },
            {
              title: "教材例题精读",
              detail: `顺着 ${topic} 的例题把解题链路重新走一遍，再标记卡住步骤。`,
              duration: Math.min(coreDur + 5, limit),
            },
            {
              title: "专题视频与笔记",
              detail: `如果今天状态一般，就先用输入型学习块把 ${topic} 思路补顺。`,
              duration: Math.max(
                coreDur,
                Math.min(limit - diagDur - reviewDur, floorDiv(limit, 2)),
              ),
            },
          ],
        },
        {
          id: "practice",
          label: "练习巩固",
          selectedIndex: practiceSelectedIndex,
          options: [
            {
              title: `${topic} 典型题限时训练`,
              detail: "做一组题并记录卡住的步骤，先暴露真正不会的点。",
              duration: practiceDur,
            },
            {
              title: "分层习题训练",
              detail: `从 ${topic} 基础题过渡到综合题，降低挫败感。`,
              duration: Math.min(practiceDur + 5, limit - diagDur - reviewDur),
            },
          ],
        },
        {
          id: "review",
          label: "复盘收尾",
          selectedIndex: reviewSelectedIndex,
          options: [
            {
              title: "十分钟学习复盘",
              detail: "写下今天的收获、卡点和明天第一件要做的事。",
              duration: reviewDur,
            },
            {
              title: "错题归档与复述",
              detail: "把错题按原因归类，再口头复述一遍关键方法。",
              duration: Math.min(reviewDur + 5, 15),
            },
          ],
        },
      ],
    };
  }

  expand_to_weekly_plan(blockPlan: BlockPlan, payload: StudyPlanRequest): StudyDayPlan[] {
    const dayOne = this._block_plan_to_day_plan(blockPlan, payload);
    const totalDays = Math.min(payload.available_days_per_week, 5);
    if (totalDays <= 1) {
      return [dayOne];
    }

    const style = this._summarize_block_plan_style(blockPlan);
    const followupDays = this._build_followup_days_from_block_style(payload, style, totalDays);
    return [dayOne, ...followupDays];
  }

  private _block_plan_to_day_plan(
    blockPlan: BlockPlan,
    payload: StudyPlanRequest,
  ): StudyDayPlan {
    const blockTypeMap: Record<string, TaskType> = {
      diagnosis: "practice",
      "core-study": "learn",
      practice: "practice",
      review: "review",
    };
    const tasks: StudyTask[] = [];
    const focusParts: string[] = [];
    const carryOver: string[] = [];
    for (const block of blockPlan.blocks) {
      const selected = block.options.length ? block.options[block.selectedIndex] : undefined;
      if (!selected) {
        continue;
      }
      focusParts.push(block.label);
      carryOver.push(selected.title);
      tasks.push({
        title: selected.title,
        task_type: blockTypeMap[block.id] ?? "learn",
        duration_minutes: selected.duration,
        reason: selected.detail,
      });
    }
    const focus =
      focusParts.slice(0, 2).join(" / ") || this.deps.short_goal(payload.learning_goal, 24);
    return { day_index: 1, focus, tasks, carry_over: carryOver };
  }

  private _summarize_block_plan_style(blockPlan: BlockPlan): BlockPlanStyle {
    const selected: Record<string, BlockOption> = {};
    for (const block of blockPlan.blocks) {
      const option = this._selected_block_option(block);
      if (option) {
        selected[block.id] = option;
      }
    }

    const diagnosisTitle = selected["diagnosis"]?.title ?? "";
    const coreTitle = selected["core-study"]?.title ?? "";
    const practiceTitle = selected["practice"]?.title ?? "";
    const reviewTitle = selected["review"]?.title ?? "";

    const diagnosisStyle = diagnosisTitle.includes("错题") ? "mistake" : "quick-check";
    let coreStyle: string;
    if (coreTitle.includes("例题")) {
      coreStyle = "example";
    } else if (coreTitle.includes("视频") || coreTitle.includes("笔记")) {
      coreStyle = "input";
    } else {
      coreStyle = "concept";
    }
    const practiceStyle = practiceTitle.includes("分层") ? "layered" : "timed";
    const reviewStyle =
      reviewTitle.includes("错题") || reviewTitle.includes("复述") ? "mistake" : "light";

    const durations: Record<string, number> = {};
    for (const block of blockPlan.blocks) {
      const option = this._selected_block_option(block);
      if (option) {
        durations[block.id] = Math.max(10, option.duration);
      }
    }
    return {
      diagnosis_style: diagnosisStyle,
      core_style: coreStyle,
      practice_style: practiceStyle,
      review_style: reviewStyle,
      selected_titles: Object.fromEntries(
        Object.entries(selected).map(([blockId, option]) => [blockId, option.title]),
      ),
      durations,
    };
  }

  private _build_followup_days_from_block_style(
    payload: StudyPlanRequest,
    style: BlockPlanStyle,
    totalDays: number,
  ): StudyDayPlan[] {
    const topic = this.deps.infer_topic(payload.learning_goal, payload.weak_points);
    const coreStyle = style.core_style || "concept";
    const practiceStyle = style.practice_style || "timed";
    const reviewStyle = style.review_style || "light";
    const diagnosisStyle = style.diagnosis_style || "quick-check";

    const followupTemplates = [
      this._block_style_day_template(topic, 2, coreStyle, practiceStyle, reviewStyle, diagnosisStyle, style),
      this._block_style_day_template(topic, 3, coreStyle, practiceStyle, reviewStyle, diagnosisStyle, style),
      this._block_style_day_template(topic, 4, coreStyle, practiceStyle, reviewStyle, diagnosisStyle, style),
      this._block_style_day_template(topic, 5, coreStyle, practiceStyle, reviewStyle, diagnosisStyle, style),
    ];

    const dayPlans: StudyDayPlan[] = [];
    for (let dayIndex = 2; dayIndex <= totalDays; dayIndex += 1) {
      const template = followupTemplates[Math.min(dayIndex - 2, followupTemplates.length - 1)]!;
      const tasks = template.tasks.map((item) => ({
        title: item.title,
        task_type: item.task_type,
        duration_minutes: this.deps.duration(payload.available_minutes_per_day, item.ratio),
        reason: item.reason,
      }));
      dayPlans.push({
        day_index: dayIndex,
        focus: template.focus,
        tasks,
        carry_over: [...template.carry_over],
      });
    }
    return dayPlans;
  }

  private _block_style_day_template(
    topic: string,
    dayIndex: number,
    coreStyle: string,
    practiceStyle: string,
    reviewStyle: string,
    diagnosisStyle: string,
    style: BlockPlanStyle,
  ): FollowupTemplate {
    if (dayIndex === 2) {
      const [coreTitle, coreReason] = this._followup_core_task(topic, coreStyle, "carry");
      const [practiceTitle, practiceReason] = this._followup_practice_task(topic, practiceStyle, "build");
      const [reviewTitle, reviewReason] = this._followup_review_task(topic, reviewStyle, "close");
      return {
        focus: this._block_style_focus(coreStyle, practiceStyle, "承接 Day 1"),
        carry_over: this._block_style_carry_over(style, ["core-study", "practice"]),
        tasks: [
          { title: coreTitle, task_type: "learn", ratio: 0.28, reason: coreReason },
          { title: practiceTitle, task_type: "practice", ratio: 0.44, reason: practiceReason },
          { title: reviewTitle, task_type: "review", ratio: 0.2, reason: reviewReason },
        ],
      };
    }
    if (dayIndex === 3) {
      const [diagnosisTitle, diagnosisReason] = this._followup_diagnosis_task(topic, diagnosisStyle, "check");
      const [practiceTitle, practiceReason] = this._followup_practice_task(topic, practiceStyle, "push");
      const [reviewTitle, reviewReason] = this._followup_review_task(topic, reviewStyle, "mistake");
      return {
        focus: this._block_style_focus(diagnosisStyle, practiceStyle, "卡点复查"),
        carry_over: this._block_style_carry_over(style, ["diagnosis", "practice", "review"]),
        tasks: [
          { title: diagnosisTitle, task_type: "practice", ratio: 0.2, reason: diagnosisReason },
          { title: practiceTitle, task_type: "practice", ratio: 0.42, reason: practiceReason },
          { title: reviewTitle, task_type: "review", ratio: 0.22, reason: reviewReason },
        ],
      };
    }
    if (dayIndex === 4) {
      const [coreTitle, coreReason] = this._followup_core_task(topic, coreStyle, "bridge");
      const [practiceTitle, practiceReason] = this._followup_practice_task(topic, practiceStyle, "timed");
      return {
        focus: this._block_style_focus(coreStyle, practiceStyle, "应用衔接"),
        carry_over: this._block_style_carry_over(style, ["core-study", "practice"]),
        tasks: [
          { title: coreTitle, task_type: "learn", ratio: 0.22, reason: coreReason },
          {
            title: practiceTitle,
            task_type: practiceStyle === "timed" ? "mock_exam" : "practice",
            ratio: 0.48,
            reason: practiceReason,
          },
          {
            title: `把 ${topic} 今天暴露的 2 个卡点写成提醒卡片`,
            task_type: "review",
            ratio: 0.16,
            reason: "让 Day 5 的收口更聚焦，不用再从头翻整套内容。",
          },
        ],
      };
    }
    const [reviewTitle, reviewReason] = this._followup_review_task(topic, reviewStyle, "final");
    return {
      focus: this._block_style_focus(practiceStyle, reviewStyle, "收口检查"),
      carry_over: this._block_style_carry_over(style, ["practice", "review"]),
      tasks: [
        {
          title: `做一次 ${topic} 的整体验收小测，尽量按正式节奏完成`,
          task_type: "mock_exam",
          ratio: 0.45,
          reason: "用一次完整检查确认这周沿着当前积木节奏推进后，薄弱点有没有真的收住。",
        },
        {
          title: reviewTitle,
          task_type: "review",
          ratio: 0.25,
          reason: reviewReason,
        },
      ],
    };
  }

  private _followup_core_task(
    topic: string,
    coreStyle: string,
    phase: string,
  ): [string, string] {
    if (coreStyle === "example") {
      if (phase === "carry") {
        return [
          `重走 Day 1 的 ${topic} 例题，并把关键步骤改写成自己的解题提示`,
          "你在 Day 1 选了例题精读，后续就顺着例题迁移，而不是突然切回纯概念灌输。",
        ];
      }
      if (phase === "bridge") {
        return [
          `从昨天做过的 ${topic} 题里挑 2 题，反推它们对应的例题模型`,
          "先把例题模型和实际题目重新连起来，后面的综合练习会更顺。",
        ];
      }
    }
    if (coreStyle === "input") {
      if (phase === "carry") {
        return [
          `补一段 ${topic} 的视频或笔记，再把 3 个关键结论写成自己的版本`,
          "既然 Day 1 选了输入型学习块，后续也继续保留输入整理的节奏。",
        ];
      }
      if (phase === "bridge") {
        return [
          `把这几天的 ${topic} 笔记压缩成一页速记提纲`,
          "把输入内容再压缩一次，后面做题时更容易快速调用。",
        ];
      }
    }
    if (phase === "bridge") {
      return [
        `回看 ${topic} 的定义、判定条件和最容易混淆的一处细节`,
        "在进入更综合的练习前，先把容易松动的概念再压实一遍。",
      ];
    }
    return [
      `把 ${topic} 的核心概念重新口述一遍，再补 1 个容易混淆的小点`,
      "Day 1 如果偏概念梳理，后续就继续沿着概念 -> 练习的节奏推进。",
    ];
  }

  private _followup_practice_task(
    topic: string,
    practiceStyle: string,
    phase: string,
  ): [string, string] {
    if (practiceStyle === "layered") {
      if (phase === "build") {
        return [
          `完成 ${topic} 的分层练习：先基础题，再过渡到 2 道变式题`,
          "你当前选的是分层习题训练，后续就保持由浅入深，不突然跳到一整套限时卷。",
        ];
      }
      if (phase === "push") {
        return [
          `把 ${topic} 分层练习往上推一档，专门处理昨天还不稳的那类题`,
          "继续沿着分层练习往上抬难度，比突然切到满负荷综合题更稳。",
        ];
      }
      return [
        `做一组偏综合的 ${topic} 分层题，检查基础题和变式题能不能串起来`,
        "先保留分层节奏，再逐步接近综合应用。",
      ];
    }
    if (phase === "build") {
      return [
        `做一组 ${topic} 典型题，先按正常节奏完成，再补 1 题限时重做`,
        "Day 1 选了典型题限时训练，后面就继续保留题感驱动的推进方式。",
      ];
    }
    if (phase === "push") {
      return [
        `做一轮 ${topic} 限时练习，重点看卡住时能不能自己把步骤接上`,
        "把时间压力稍微提起来，检查 Day 1 的诊断和练习有没有真正生效。",
      ];
    }
    return [
      `做一组偏综合的 ${topic} 限时题，练稳定输出`,
      "把前几天的节奏收拢成更接近实战的一轮练习。",
    ];
  }

  private _followup_review_task(
    topic: string,
    reviewStyle: string,
    phase: string,
  ): [string, string] {
    if (reviewStyle === "mistake") {
      if (phase === "close") {
        return [
          `把今天的 ${topic} 错题按“不会/会但做错/粗心”分三类归档`,
          "你已经选了错题归档与复述，后续复盘也继续围绕错因展开，不会断掉。",
        ];
      }
      if (phase === "mistake") {
        return [
          `挑 2 道最卡的 ${topic} 题，口头复述正确做法和失误原因`,
          "继续沿着错题复述这条线，把会错的地方真正讲明白。",
        ];
      }
      return [
        `回看这周的 ${topic} 错题归档，只保留最容易反复错的 3 条提醒`,
        "收口阶段不再堆信息，只留下最值得你下次继续盯的点。",
      ];
    }
    if (phase === "final") {
      return [
        `写一段 ${topic} 本周复盘，记下最有用的方法和下周第一件事`,
        "如果你偏轻复盘，这里就用更轻量但不断线的方式收口。",
      ];
    }
    return [
      `用 10 分钟写下今天 ${topic} 最清楚和最模糊的各 1 点`,
      "轻复盘适合每天都做一点，能把节奏保持住。",
    ];
  }

  private _followup_diagnosis_task(
    topic: string,
    diagnosisStyle: string,
    _phase: string,
  ): [string, string] {
    if (diagnosisStyle === "mistake") {
      return [
        `从这两天的 ${topic} 错题里挑 3 题，确认到底是概念问题还是步骤问题`,
        "Day 1 用的是错题回顾诊断，后续检查也继续从真实错题出发。",
      ];
    }
    return [
      `先做一个 10 到 15 分钟的 ${topic} 快速自测，看看 Day 1 的卡点有没有缓过来`,
      "Day 1 先做了快速诊断，Day 3 再回测一次，更容易看出补漏有没有起效。",
    ];
  }

  private _block_style_focus(leftStyle: string, rightStyle: string, stage: string): string {
    const labelMap: Record<string, string> = {
      example: "例题迁移",
      input: "输入整理",
      concept: "概念压实",
      layered: "分层练习",
      timed: "限时练习",
      mistake: "错因复盘",
      "quick-check": "快速复查",
      light: "轻量复盘",
    };
    const left = labelMap[leftStyle] ?? leftStyle;
    const right = labelMap[rightStyle] ?? rightStyle;
    return `${stage} · ${left} / ${right}`;
  }

  private _block_style_carry_over(style: BlockPlanStyle, blockIds: string[]): string[] {
    const selectedTitles = style.selected_titles;
    if (!selectedTitles || typeof selectedTitles !== "object") {
      return [];
    }
    return blockIds
      .map((blockId) => (selectedTitles[blockId] ?? "").trim())
      .filter((title) => title.length > 0);
  }

  private _selected_block_option(block: BlockItem): BlockOption | undefined {
    if (!block.options.length) {
      return undefined;
    }
    const index = Math.max(0, Math.min(block.selectedIndex, block.options.length - 1));
    return block.options[index];
  }
}
