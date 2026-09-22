/**
 * 长期计划（里程碑）—— 三层计划的最上层。
 *
 * 长期计划**不直接排每日任务**，只把总目标切成阶段：每段有目标日期与验收标准。
 * 每日任务由短期计划落地，短期再从长期当前阶段的阶段目标出发去排。
 *
 * 只在目标跨度超过一周时才存在（`should_build_long_term`），
 * 因此「本周内完成」这类目标的行为与旧版完全一致。
 */

import type { Milestone } from "../protocol/study";
import { add_days, days_between } from "./dateMath";

/** 超过这个天数才建长期计划；一周以内一律视为短期目标。 */
export const LONG_TERM_THRESHOLD_DAYS = 7;

/** 一段大约覆盖多少天（约 3 周），据此决定里程碑个数。 */
const DAYS_PER_STAGE = 21;
const MAX_STAGES = 6;

export interface BuildMilestonesInput {
  goal: string;
  deadline: string | null;
  today: string;
  subjects: string[];
}

/** 是否需要长期计划：有截止时间，且距今超过一周。 */
export function should_build_long_term(deadline: string | null, today: string): boolean {
  if (!deadline) {
    return false;
  }
  const total = days_between(today, deadline);
  return total !== null && total > LONG_TERM_THRESHOLD_DAYS;
}

function stage_title(index: number, count: number): string {
  if (count === 1) {
    return "整体推进";
  }
  if (index === 0) {
    return "打基础";
  }
  if (index === count - 1) {
    return "冲刺与验收";
  }
  return index % 2 === 1 ? "强化训练" : "专项突破";
}

function stage_acceptance(index: number, count: number, subjectText: string): string {
  if (index === count - 1) {
    return `能完整走一遍${subjectText}的模拟或真题，并说清剩余薄弱点`;
  }
  return `完成本阶段任务清单，${subjectText}的练习正确率稳定在 70% 以上`;
}

/**
 * 规则版里程碑：把总周期按约 3 周一段切开。
 * 既是模型不可用时的兜底，也用来给模型输出兜底（结果为空时回退到它）。
 */
export function build_rule_milestones(input: BuildMilestonesInput): Milestone[] {
  const total = input.deadline ? days_between(input.today, input.deadline) : null;
  if (total === null || total <= 0) {
    return [];
  }
  const stageCount = Math.max(1, Math.min(MAX_STAGES, Math.ceil(total / DAYS_PER_STAGE)));
  const stageDays = Math.ceil(total / stageCount);
  const subjectText = input.subjects.length ? input.subjects.join("、") : "本目标";

  const milestones: Milestone[] = [];
  for (let index = 0; index < stageCount; index += 1) {
    const startOffset = index * stageDays;
    // 最后一段必须咬住截止日期，否则整体会差一天
    const endOffset =
      index === stageCount - 1 ? total : Math.min(total, startOffset + stageDays - 1);
    const title = stage_title(index, stageCount);
    milestones.push({
      id: `m${index + 1}`,
      title,
      goal: `${subjectText} · ${title}`,
      subject: "",
      start_date: add_days(input.today, startOffset),
      due_date: add_days(input.today, endOffset),
      acceptance: stage_acceptance(index, stageCount, subjectText),
      status: index === 0 ? "active" : "pending",
    });
  }
  return milestones;
}

/** 当前应推进的里程碑：优先 active，其次第一个未完成的；全完成返回 null。 */
export function pick_active_milestone(milestones: Milestone[]): Milestone | null {
  return (
    milestones.find((item) => item.status === "active") ??
    milestones.find((item) => item.status !== "done") ??
    null
  );
}

/** 把某个阶段标成已完成，并把下一个未完成阶段置为 active。 */
export function complete_milestone(milestones: Milestone[], id: string): Milestone[] {
  const updated = milestones.map((item) =>
    item.id === id ? { ...item, status: "done" as const } : { ...item },
  );
  const next = updated.find((item) => item.status !== "done");
  for (const item of updated) {
    if (item.status === "active" && item.id !== next?.id) {
      item.status = "pending";
    }
  }
  if (next) {
    next.status = "active";
  }
  return updated;
}
