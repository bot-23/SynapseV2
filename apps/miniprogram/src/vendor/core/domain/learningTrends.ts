/**
 * 学习趋势的确定性聚合（纯函数）。
 *
 * 与周报的区别：周报是「单一窗口的快照」，趋势看的是「随时间变化的曲线」——
 * 完成度逐日曲线、各科目能力值走势，以及连续打卡。
 *
 * 与 weeklyReport 一样刻意不读 KV：输入全是普通对象，测试可用构造数据手算对比。
 */

import type { AssessmentRowLike, ProgressRowLike } from "./weeklyReport";
import { collect_active_days, compute_streak } from "./weeklyReport";
import { add_days, to_date } from "./dateMath";

/** 默认看最近 30 天。 */
export const TREND_DEFAULT_DAYS = 30;
/** 上限 180 天：再多也没人看，且逐日数组会徒增体积。 */
export const TREND_MAX_DAYS = 180;

export interface TrendPoint {
  date: string;
  done_count: number;
  minutes: number;
}

export interface SubjectTrendPoint {
  date: string;
  score: number;
}

export interface SubjectTrend {
  subject: string;
  points: SubjectTrendPoint[];
  first_score: number;
  last_score: number;
  delta: number;
}

export interface LearningTrends {
  days: number;
  from: string;
  to: string;
  daily: TrendPoint[];
  subjects: SubjectTrend[];
  totals: {
    done_count: number;
    minutes: number;
    active_days: number;
    streak_days: number;
  };
}

/** 进度行在周报口径上多带一个用时字段。 */
export interface TrendProgressRow extends ProgressRowLike {
  actual_minutes?: number;
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) {
    return TREND_DEFAULT_DAYS;
  }
  return Math.max(7, Math.min(TREND_MAX_DAYS, Math.trunc(days)));
}

/** 从能力快照 JSON 取 skill_score；取不到返回 null（旧数据缺字段时不参与）。 */
function skill_score(raw: unknown): number | null {
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

export function build_learning_trends(input: {
  progress: Record<string, TrendProgressRow>;
  assessments: readonly AssessmentRowLike[];
  today: string;
  days?: number;
}): LearningTrends {
  const days = clampDays(input.days ?? TREND_DEFAULT_DAYS);
  const from = add_days(input.today, -(days - 1));
  const to = input.today;

  // 逐日桶：只统计窗口内已完成的打卡。
  const buckets = new Map<string, { done: number; minutes: number }>();
  for (const row of Object.values(input.progress)) {
    if (!row || typeof row !== "object" || !row.done) {
      continue;
    }
    const day = to_date(String(row.updated_at ?? ""));
    if (!day || day < from || day > to) {
      continue;
    }
    const bucket = buckets.get(day) ?? { done: 0, minutes: 0 };
    bucket.done += 1;
    const minutes = Number(row.actual_minutes ?? 0);
    bucket.minutes += Number.isFinite(minutes) ? Math.max(0, Math.trunc(minutes)) : 0;
    buckets.set(day, bucket);
  }

  // 从早到晚补全每一天（没有打卡的天也要有点，曲线才连续）。
  const daily: TrendPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = add_days(to, -offset);
    const bucket = buckets.get(date);
    daily.push({ date, done_count: bucket?.done ?? 0, minutes: bucket?.minutes ?? 0 });
  }

  // 科目能力值曲线：同一天多条快照取最后一条。
  const bySubject = new Map<string, Map<string, number>>();
  for (const row of input.assessments) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const subject = String(row.subject ?? "").trim();
    const day = to_date(String(row.created_at ?? ""));
    if (!subject || !day || day < from || day > to) {
      continue;
    }
    const score = skill_score(row.abilities_snapshot_json);
    if (score === null) {
      continue;
    }
    const series = bySubject.get(subject) ?? new Map<string, number>();
    series.set(day, score);
    bySubject.set(subject, series);
  }

  const subjects: SubjectTrend[] = [];
  for (const [subject, series] of bySubject) {
    const points = [...series.entries()]
      .map(([date, score]) => ({ date, score }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!points.length) {
      continue;
    }
    const first = points[0]!.score;
    const last = points[points.length - 1]!.score;
    subjects.push({
      subject,
      points,
      first_score: first,
      last_score: last,
      delta: Math.round((last - first) * 100) / 100,
    });
  }
  subjects.sort((a, b) => b.last_score - a.last_score);

  return {
    days,
    from,
    to,
    daily,
    subjects,
    totals: {
      done_count: daily.reduce((sum, point) => sum + point.done_count, 0),
      minutes: daily.reduce((sum, point) => sum + point.minutes, 0),
      active_days: daily.filter((point) => point.done_count > 0).length,
      // 连续打卡按全部历史算（不限窗口），否则长连签会被窗口截断
      streak_days: compute_streak(collect_active_days(input.progress), to),
    },
  };
}
