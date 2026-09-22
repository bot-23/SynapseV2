/**
 * 计划调整建议（纯函数）。
 * 翻译自 Synapse/backend/app/services/plan_adjuster.py，语义逐字保留。
 */

import { pyInt } from "./pyCompat.js";

export interface PlanAdjustment {
  daily_minutes: number;
  strategy_shift: string;
  focus_shift: string;
  reason: string;
  preferences: string[];
}

export function build_plan_adjustment(
  progressMap: Record<string, unknown>,
  defaultDailyMinutes: number,
): PlanAdjustment {
  if (!progressMap || Object.keys(progressMap).length === 0) {
    return {
      daily_minutes: defaultDailyMinutes,
      strategy_shift: "",
      focus_shift: "",
      reason: "",
      preferences: [],
    };
  }

  let attempts = 0;
  let doneCount = 0;
  let skipCount = 0;
  let learnDone = 0;
  let practiceDone = 0;

  for (const item of Object.values(progressMap)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    attempts += Math.max(1, pyInt(record["attempts"] || 1));
    const done = Boolean(record["done"]);
    doneCount += done ? 1 : 0;
    skipCount += done ? 0 : 1;
    const taskType = String(record["task_type"] ?? "");
    if (done && taskType === "learn") {
      learnDone += 1;
    }
    if (done && taskType === "practice") {
      practiceDone += 1;
    }
  }

  const completionRate = doneCount / Math.max(1, Object.keys(progressMap).length);
  let nextMinutes = defaultDailyMinutes;
  let strategyShift = "";
  let focusShift = "";
  const reasonParts: string[] = [];
  const preferences: string[] = [];

  if (skipCount >= 2 && completionRate < 0.5) {
    nextMinutes = Math.max(45, defaultDailyMinutes - 15);
    strategyShift = "shorter_tasks";
    reasonParts.push("最近跳过任务偏多，这次先整体降载并把任务拆短。");
    preferences.push("任务尽量拆成更短的小步");
  }

  if (practiceDone > learnDone && practiceDone >= 2) {
    focusShift = "practice_first";
    reasonParts.push("你最近练习类任务完成更稳定，所以这轮先练再补知识点。");
    preferences.push("优先安排练习，再回补知识梳理");
  }

  if (completionRate >= 0.75 && defaultDailyMinutes < 120) {
    nextMinutes = Math.min(120, Math.max(nextMinutes, defaultDailyMinutes + 10));
    reasonParts.push("你最近完成率不错，可以把每天时长略微拉高一点。");
  }

  return {
    daily_minutes: nextMinutes,
    strategy_shift: strategyShift,
    focus_shift: focusShift,
    reason: reasonParts.join(""),
    preferences,
  };
}
