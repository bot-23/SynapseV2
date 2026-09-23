/**
 * 学情周报的确定性聚合（纯函数）。
 *
 * 产品立场：周报里出现的每一个数字都由这里算出来 —— 模型只负责把它写成一段人话。
 * 所以这些函数既不接收、也不返回任何模型产物；没配 Key 时同一套数字换成模板文案照样成立。
 *
 * 这里也刻意不读 KV：输入全是普通对象，测试可以用构造数据手算对比。
 */

import type { AssignmentItem, WeeklyReportStats } from "../protocol/study.js";
import { add_days, to_date } from "./dateMath.js";

/** 周报窗口固定为「含今天在内的最近 7 天」。 */
export const REPORT_WINDOW_DAYS = 7;

/** 周报最多保留多少期（防止 KV 无限膨胀）。 */
export const REPORT_HISTORY_LIMIT = 8;

/** 叙述字数上限：模型写超了就截断，离线模板也照此收敛。 */
export const NARRATIVE_MAX_CHARS = 200;

/** 叙述里最多点名几个科目，避免能力值一多就把字数挤爆。 */
const MAX_ABILITY_NAMES = 3;

export interface ProgressRowLike {
  done?: boolean;
  updated_at?: string;
}

export interface AssessmentRowLike {
  subject?: string;
  abilities_snapshot_json?: string;
  created_at?: string;
}

export interface ReviewRowLike {
  last_reviewed_at?: string;
}

export interface WeeklyReportInput {
  progress: Record<string, ProgressRowLike>;
  assessments: readonly AssessmentRowLike[];
  reviews: readonly ReviewRowLike[];
  assignments: readonly AssignmentItem[];
  today: string;
}

/** 统计窗口：含今天在内的最近 7 天。 */
export function report_window(today: string): { from: string; to: string } {
  return { from: add_days(today, -(REPORT_WINDOW_DAYS - 1)), to: today };
}

function in_range(day: string, fromDate: string, toDate: string): boolean {
  // YYYY-MM-DD 定长，字典序即时间序
  return Boolean(day) && day >= fromDate && day <= toDate;
}

/** 窗口内动过的任务数，以及其中已完成的数量。 */
export function count_progress_window(
  progress: Record<string, ProgressRowLike>,
  fromDate: string,
  toDate: string,
): { done_count: number; total_count: number } {
  let done = 0;
  let total = 0;
  for (const row of Object.values(progress)) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const day = to_date(String(row.updated_at ?? ""));
    if (!in_range(day, fromDate, toDate)) {
      continue;
    }
    total += 1;
    if (row.done) {
      done += 1;
    }
  }
  return { done_count: done, total_count: total };
}

/** 全部打卡日（不限窗口）—— 连续打卡天数按它算。 */
export function collect_active_days(progress: Record<string, ProgressRowLike>): string[] {
  const days: string[] = [];
  for (const row of Object.values(progress)) {
    if (!row || typeof row !== "object" || !row.done) {
      continue;
    }
    const day = to_date(String(row.updated_at ?? ""));
    if (day) {
      days.push(day);
    }
  }
  return days;
}

/** 连续打卡天数：从今天往前数；今天还没打卡时从昨天起算，不算断签。 */
export function compute_streak(activeDays: readonly string[], today: string): number {
  const days = new Set(activeDays.filter(Boolean));
  if (!days.size) {
    return 0;
  }
  let cursor = days.has(today) ? today : add_days(today, -1);
  let streak = 0;
  // 上限兜底：日期不可解析时 add_days 会原样返回，避免死循环
  while (days.has(cursor) && streak < REPORT_WINDOW_DAYS * 520) {
    streak += 1;
    cursor = add_days(cursor, -1);
  }
  return streak;
}

/** 从能力快照 JSON 里取该科目的能力值；取不到返回 null（旧数据缺字段时不参与比较）。 */
function skill_score_of(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const score = Number((parsed as Record<string, unknown>)["skill_score"]);
    return Number.isFinite(score) ? score : null;
  } catch {
    return null;
  }
}

/**
 * 各科目能力值变化：窗口末的一次快照 − 窗口前的最后一次快照。
 *
 * 窗口前没有快照时（新用户 / 第一次打卡就在本周）退化为「窗口内首末之差」，
 * 保证新手第一周也能看到变化，而不是一片空白。
 */
export function compute_ability_delta(
  assessments: readonly AssessmentRowLike[],
  fromDate: string,
  toDate: string,
): Record<string, number> {
  const beforeLast = new Map<string, { day: string; score: number }>();
  const duringFirst = new Map<string, { day: string; score: number }>();
  const duringLast = new Map<string, { day: string; score: number }>();

  for (const row of assessments) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const subject = String(row.subject ?? "").trim();
    const day = to_date(String(row.created_at ?? ""));
    if (!subject || !day || day > toDate) {
      continue;
    }
    const score = skill_score_of(row.abilities_snapshot_json);
    if (score === null) {
      continue;
    }
    if (day < fromDate) {
      const kept = beforeLast.get(subject);
      if (!kept || day >= kept.day) {
        beforeLast.set(subject, { day, score });
      }
      continue;
    }
    const first = duringFirst.get(subject);
    if (!first || day < first.day) {
      duringFirst.set(subject, { day, score });
    }
    const last = duringLast.get(subject);
    if (!last || day >= last.day) {
      duringLast.set(subject, { day, score });
    }
  }

  const delta: Record<string, number> = {};
  for (const [subject, last] of duringLast) {
    const baseline = beforeLast.get(subject)?.score ?? duringFirst.get(subject)?.score;
    if (baseline === undefined) {
      continue;
    }
    const value = Math.round((last.score - baseline) * 100) / 100;
    if (value !== 0) {
      delta[subject] = value;
    }
  }
  return delta;
}

/** 窗口内有过复习记录的知识点条数。 */
export function count_reviewed(
  reviews: readonly ReviewRowLike[],
  fromDate: string,
  toDate: string,
): number {
  let count = 0;
  for (const item of reviews) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const day = to_date(String(item.last_reviewed_at ?? ""));
    if (in_range(day, fromDate, toDate)) {
      count += 1;
    }
  }
  return count;
}

/** 当前仍在逾期的作业条数。 */
export function count_overdue(assignments: readonly AssignmentItem[], today: string): number {
  return assignments.filter(
    (item) => item && item.status !== "done" && Boolean(item.due_date) && item.due_date < today,
  ).length;
}

/** 完成率：整数百分比；没有可数任务时按 0 处理，不返回 NaN。 */
export function completion_rate(doneCount: number, totalCount: number): number {
  if (totalCount <= 0) {
    return 0;
  }
  return Math.round((doneCount / totalCount) * 100);
}

/** 把各路原始记录聚合成一份周报统计。 */
export function summarize_weekly_report(input: WeeklyReportInput): WeeklyReportStats {
  const { from, to } = report_window(input.today);
  const counted = count_progress_window(input.progress, from, to);
  return {
    window_start: from,
    window_end: to,
    done_count: counted.done_count,
    total_count: counted.total_count,
    completion_rate: completion_rate(counted.done_count, counted.total_count),
    ability_delta: compute_ability_delta(input.assessments, from, to),
    overdue_count: count_overdue(input.assignments, input.today),
    review_done: count_reviewed(input.reviews, from, to),
    streak_days: compute_streak(collect_active_days(input.progress), input.today),
  };
}

function format_delta(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

/**
 * 离线叙述：用真实统计数字拼一段模板文案。
 *
 * 这是「没配模型 Key 也能出周报」的底线 —— 宁可语气朴素，也不能出现没算过的数字。
 */
export function build_offline_narrative(stats: WeeklyReportStats): string {
  const parts: string[] = [];
  if (stats.total_count > 0) {
    parts.push(
      `本周你动过 ${stats.total_count} 项任务，完成 ${stats.done_count} 项，完成率 ${stats.completion_rate}%。`,
    );
  } else {
    parts.push("本周还没有任务完成记录，先从今天最小的一步开始。");
  }

  const subjects = Object.keys(stats.ability_delta).slice(0, MAX_ABILITY_NAMES);
  if (subjects.length) {
    parts.push(
      `能力值变化：${subjects.map((name) => `${name} ${format_delta(stats.ability_delta[name]!)}`).join("、")}。`,
    );
  }

  parts.push(
    stats.overdue_count > 0
      ? `风险点：还有 ${stats.overdue_count} 项作业逾期，建议先重排到后面几天。`
      : "风险点：暂时没有逾期作业。",
  );

  parts.push(
    `本周复习了 ${stats.review_done} 个知识点，连续打卡 ${stats.streak_days} 天。` +
      (stats.review_done > 0 ? "下周建议把复习卡排到每天固定时段，保持这个节奏。" : "下周建议先完成一项任务，把它排进复习队列。"),
  );

  return truncate_narrative(parts.join(""));
}

/** 限长：超了就截断，避免模型啰嗦或模板组合过长。 */
export function truncate_narrative(text: string, limit = NARRATIVE_MAX_CHARS): string {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
