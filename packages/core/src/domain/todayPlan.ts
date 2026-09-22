/**
 * 今日计划（待办列表）—— 三层计划的最下层。
 *
 * - 从短期计划按「今天是第几个学习日」切片出今天的条目
 * - 上一天没做完的自动顺延过来，并标记 `carried_from`
 * - 条目的 key 与短期计划的打卡标识一致，所以今日页勾选会同步回短期计划
 */

import type { ReviewItem, StudyDayPlan, StudyTask, TodayItem } from "../protocol/study.js";

/**
 * 复习条目在今日列表里的 key 前缀。
 * 勾选时据此判断该走 SM-2（复习）还是普通进度（计划任务）。
 */
export const REVIEW_ITEM_KEY_PREFIX = "review::";

/** 复习条目默认占用时长（分钟）。 */
const REVIEW_MINUTES = 20;

/**
 * 短期计划里一条任务的打卡标识：天 + 科目 + 标题。
 * 必须与界面（计划页）用同一个函数，否则今日页与短期计划的勾选会各记一套。
 */
export function plan_task_key(dayIndex: number, task: StudyTask): string {
  const subject = (task.subject || "未分类").trim() || "未分类";
  return `day-${dayIndex}::${subject}::${task.title.trim()}`;
}

export interface BuildTodayItemsInput {
  /** 短期计划的每日安排 */
  days: StudyDayPlan[];
  /** 今天是短期计划的第几个学习日（1 起）；0 或超出范围表示计划已走完 */
  dayIndex: number;
  /** 上一次的今日记录，用于把未完成项顺延过来 */
  previousItems: TodayItem[];
  /** 上一次记录的日期 */
  previousDate: string;
  today: string;
  /** 今天到期的复习项（调用方已按到期日排好），插在顺延项之后、当天切片之前 */
  dueReviews?: ReviewItem[];
}

/**
 * 重建今日列表。顺延项排在前面，方便一眼看到「昨天没做完的」。
 * 同 key 去重：既在顺延里又在今天切片里的条目只保留一条。
 */
export function build_today_items(input: BuildTodayItemsInput): TodayItem[] {
  const items: TodayItem[] = [];
  const seen = new Set<string>();
  const push = (item: TodayItem) => {
    if (!item.key || seen.has(item.key)) {
      return;
    }
    seen.add(item.key);
    items.push(item);
  };

  for (const item of input.previousItems) {
    if (item.done) {
      continue;
    }
    push({ ...item, carried_from: item.carried_from || input.previousDate });
  }

  for (const review of input.dueReviews ?? []) {
    push({
      key: `${REVIEW_ITEM_KEY_PREFIX}${review.id}`,
      title: `复习：${review.topic}`,
      subject: review.subject,
      task_type: "review",
      duration_minutes: REVIEW_MINUTES,
      done: false,
      carried_from: "",
      manual: false,
    });
  }

  const day = input.days.find((item) => item.day_index === input.dayIndex);
  if (day) {
    for (const task of day.tasks) {
      push({
        key: plan_task_key(day.day_index, task),
        title: task.title,
        subject: (task.subject || "未分类").trim() || "未分类",
        task_type: task.task_type,
        duration_minutes: task.duration_minutes,
        done: false,
        carried_from: "",
        manual: false,
      });
    }
  }

  return items;
}
