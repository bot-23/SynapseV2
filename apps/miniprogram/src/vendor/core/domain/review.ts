/**
 * 间隔重复调度（SM-2，纯函数，零依赖，离线可用）。
 *
 * 为什么值得做：原来的计划算法只是把任务平均铺开，完全没有「什么时候该复习」的概念。
 * SM-2 只需要「上次复习 + 难度系数」就能算出下次该复习的日期，是学习类产品的核心算法。
 *
 * 评分约定（0..5）：≥ 3 视为记住，< 3 视为忘记、间隔重置。
 */

import type { ReviewItem } from "../protocol/study";
import { add_days, days_between } from "./dateMath";

/** SM-2 原始取值：初始难度系数与下限。 */
export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;
/** 评分达到这个值才算记住。 */
export const PASS_GRADE = 3;
/** 单次间隔上限，避免变成半年后才再见。 */
export const MAX_INTERVAL_DAYS = 180;

export function review_key(subject: string, topic: string): string {
  const normalizedSubject = (subject || "未分类").trim() || "未分类";
  return `${normalizedSubject}::${(topic || "").trim()}`;
}

/**
 * 新建一个复习项：把「今天学过」当作第一次完成，
 * 于是首次复习排在明天（SM-2 的第一个间隔是 1 天）。
 */
export function create_review_item(args: {
  id: string;
  subject: string;
  topic: string;
  today: string;
}): ReviewItem {
  const subject = (args.subject || "未分类").trim() || "未分类";
  const topic = (args.topic || "").trim() || "未命名知识点";
  return {
    id: args.id,
    key: review_key(subject, topic),
    subject,
    topic,
    ease: DEFAULT_EASE,
    interval_days: 1,
    repetitions: 1,
    due_date: add_days(args.today, 1),
    last_reviewed_at: args.today,
    total_reviews: 0,
    lapses: 0,
    created_at: args.today,
  };
}

/** SM-2：按评分推进一个复习项，返回新对象（不改原对象）。 */
export function apply_sm2(item: ReviewItem, grade: number, today: string): ReviewItem {
  const clamped = Math.max(0, Math.min(5, Math.trunc(Number.isFinite(grade) ? grade : 0)));

  // 经典 SM-2：无论对错都调整难度系数（错的越离谱，ease 掉得越多）
  const nextEase = item.ease + (0.1 - (5 - clamped) * (0.08 + (5 - clamped) * 0.02));
  const ease = Math.max(MIN_EASE, Number(nextEase.toFixed(2)));

  let repetitions = item.repetitions;
  let interval = item.interval_days;
  let lapses = item.lapses;

  if (clamped >= PASS_GRADE) {
    if (repetitions <= 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(Math.max(1, item.interval_days) * ease);
    }
    repetitions += 1;
  } else {
    repetitions = 0;
    interval = 1;
    lapses += 1;
  }

  interval = Math.max(1, Math.min(MAX_INTERVAL_DAYS, interval));

  return {
    ...item,
    ease,
    repetitions,
    interval_days: interval,
    due_date: add_days(today, interval),
    last_reviewed_at: today,
    total_reviews: item.total_reviews + 1,
    lapses,
  };
}

/** 到期（含逾期）的复习项，越早到期的排越前；同一天按 key 稳定排序。 */
export function due_review_items(items: ReviewItem[], today: string): ReviewItem[] {
  return items
    .filter((item) => {
      const elapsed = days_between(item.due_date, today);
      return elapsed !== null && elapsed >= 0;
    })
    .sort((a, b) => {
      if (a.due_date !== b.due_date) {
        return a.due_date < b.due_date ? -1 : 1;
      }
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}

/**
 * 今天最多排几条复习。
 * 上限是为了避免某天把积压的复习全堆上来 —— 计划一旦做不完，整个系统就废了。
 */
export function pick_due_for_today(items: ReviewItem[], today: string, limit: number): ReviewItem[] {
  return due_review_items(items, today).slice(0, Math.max(0, limit));
}

/**
 * 今天该排几条复习：不超过时间预算（每条约 20 分钟），也不超过真正到期的条数，上限 6 条。
 * 有上限是为了避免某天把积压的复习一次全堆上来 —— 计划一旦做不完，整个系统就废了。
 */
export function daily_review_quota(pendingCount: number, dailyMinutes: number): number {
  if (pendingCount <= 0) {
    return 0;
  }
  const byTime = Math.max(1, Math.round(dailyMinutes / 20));
  return Math.max(1, Math.min(6, Math.min(byTime, pendingCount)));
}
