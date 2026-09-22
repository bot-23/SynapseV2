/**
 * 多科目识别与合并（纯函数）。
 *
 * 设计取舍：
 * - 只在「明确出现 2 个及以上已知科目」时才启用多科目分组，避免把「数学分析」误拆成两个科目。
 * - 合并时按科目数均分每日时长预算，再用统一的 fit_tasks_to_minutes 收敛到日预算内，
 *   因此合并后的每日总时长不会超过用户声明的可用时长。
 */

import type { StudyDayPlan, StudyTask, TimetableEntry } from "../protocol/study";
import { fit_tasks_to_minutes } from "./planFit";

/** 常见科目词表（保守匹配，仅用于识别用户显式提到的科目）。 */
const SUBJECT_VOCABULARY = [
  "高等数学", "高数", "线性代数", "线代", "概率论", "数理统计", "大学物理", "大物",
  "数据结构", "操作系统", "计算机网络", "计算机组成", "数据库", "编译原理", "离散数学",
  "经济学", "微观经济", "宏观经济", "会计", "统计学", "金融",
  "语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理",
  "日语", "法语", "德语", "韩语", "四级", "六级", "考研英语",
  "计网", "计组", "微积分", "电路", "雅思", "托福",
];

/** 长词优先，避免「数学」先于「高等数学」命中。 */
const SORTED_VOCABULARY = [...SUBJECT_VOCABULARY].sort((a, b) => b.length - a.length);

export interface DetectSubjectsInput {
  learningGoal: string;
  weakPoints?: string[];
  timetable?: TimetableEntry[];
}

/**
 * 识别文本里出现的**全部**科目候选（按出现顺序去重，可以只有 1 个）。
 * 用于「已确认科目」的并入：只说了「我要学英语」这种单科目时也要能识别出来。
 */
export function detect_subject_candidates(input: DetectSubjectsInput): string[] {
  const text = [input.learningGoal, ...(input.weakPoints ?? [])].join(" ");
  const found: Array<{ subject: string; index: number }> = [];
  const taken = new Array<boolean>(text.length).fill(false);

  for (const word of SORTED_VOCABULARY) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(word, from);
      if (index < 0) {
        break;
      }
      const overlaps = taken.slice(index, index + word.length).some(Boolean);
      if (!overlaps) {
        for (let i = index; i < index + word.length; i += 1) {
          taken[i] = true;
        }
        found.push({ subject: word, index });
      }
      from = index + word.length;
    }
  }

  for (const entry of input.timetable ?? []) {
    const subject = (entry.subject || entry.name || "").trim();
    if (!subject) {
      continue;
    }
    if (!found.some((item) => item.subject === subject)) {
      found.push({ subject, index: Number.MAX_SAFE_INTEGER });
    }
  }

  found.sort((a, b) => a.index - b.index);
  const unique: string[] = [];
  for (const item of found) {
    if (!unique.includes(item.subject)) {
      unique.push(item.subject);
    }
  }
  return unique;
}

/**
 * 识别用户本轮涉及的科目。
 * 少于 2 个时返回空数组（表示单科目，走旧行为）。
 */
export function detect_subjects(input: DetectSubjectsInput): string[] {
  const unique = detect_subject_candidates(input);
  return unique.length >= 2 ? unique : [];
}

/**
 * 答语/语气词开头，明显不是科目名。
 * 由「当然算数」曾被当成科目而来：模型会把用户对追问的短回答抠成科目。
 */
const NON_SUBJECT_PREFIXES = [
  "当然", "算数", "是的", "好的", "可以", "嗯", "没问题", "应该",
  "必须", "不需要", "不用", "还行", "随便", "不知道", "都行", "继续", "算了",
  "应付", "为了", "因为", "所以", "不是", "还是", "无所谓", "要不要",
];

/**
 * 校验一个「科目名」候选是否可用，不可用返回空串。
 * 用于把关模型返回的 subject，避免答句、整句、超长文本混进科目表。
 */
export function sanitize_subject_candidate(text: string): string {
  const value = (text || "").trim().replace(/\s+/g, " ");
  if (!value || value.length < 2 || value.length > 12) {
    return "";
  }
  if (/[。，、；：！？,.!?;:\n]/.test(value)) {
    return "";
  }
  if (/[吗呢吧]$/.test(value)) {
    return "";
  }
  if (NON_SUBJECT_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return "";
  }
  return value;
}

export interface SubjectPlan {
  subject: string;
  days: StudyDayPlan[];
}

/**
 * 把「每科一份日计划」合并成一份按天组织、任务带科目标签的周计划。
 * 每日预算按科目数均分，最后统一收敛，保证不超预算。
 */
export function merge_subject_plans(
  subjectPlans: SubjectPlan[],
  totalDays: number,
  dailyMinutes: number,
): StudyDayPlan[] {
  const valid = subjectPlans.filter((plan) => plan.days.length > 0);
  if (!valid.length) {
    return [];
  }
  if (valid.length === 1) {
    const only = valid[0]!;
    return only.days.slice(0, totalDays).map((day) => ({
      ...day,
      tasks: day.tasks.map((task) => ({ ...task, subject: only.subject })),
    }));
  }

  const days: StudyDayPlan[] = [];
  for (let dayIndex = 1; dayIndex <= totalDays; dayIndex += 1) {
    const mergedTasks: StudyTask[] = [];
    const focusParts: string[] = [];
    const carryOver: string[] = [];

    for (const plan of valid) {
      const day =
        plan.days.find((item) => item.day_index === dayIndex) ??
        plan.days[Math.min(dayIndex - 1, plan.days.length - 1)];
      if (!day) {
        continue;
      }
      focusParts.push(`${plan.subject}·${day.focus}`);
      for (const task of day.tasks) {
        mergedTasks.push({ ...task, subject: plan.subject });
      }
      for (const item of day.carry_over) {
        carryOver.push(`[${plan.subject}] ${item}`);
      }
    }

    if (!mergedTasks.length) {
      continue;
    }

    days.push({
      day_index: dayIndex,
      focus: focusParts.join(" / "),
      tasks: fit_tasks_to_minutes(mergedTasks, dailyMinutes),
      carry_over: carryOver,
    });
  }

  return days;
}

/**
 * 增量追加科目到已有周计划（v2）。
 *
 * 规则：
 * - 已有条目一律原样保留（顺序、时长、科目都不动）——打卡状态因此不会串到别的条目上
 * - 已过去的天（day_index < fromDayIndex）不追加
 * - 新任务只能吃掉当天的剩余预算；剩余不足 15 分钟就跳过该天
 */
export function append_subjects_to_days(
  existingDays: StudyDayPlan[],
  subjectPlans: SubjectPlan[],
  options: { dailyMinutes: number; fromDayIndex: number },
): { days: StudyDayPlan[]; added: number; skipped: string[] } {
  const days = existingDays.map((day) => ({ ...day, tasks: [...day.tasks] }));
  const skipped: string[] = [];
  let added = 0;

  for (const plan of subjectPlans) {
    for (const day of days) {
      if (day.day_index < options.fromDayIndex) {
        continue;
      }
      const sourceDay =
        plan.days.find((item) => item.day_index === day.day_index) ??
        plan.days[Math.min(day.day_index - 1, plan.days.length - 1)];
      if (!sourceDay || !sourceDay.tasks.length) {
        continue;
      }
      const used = day.tasks.reduce((sum, task) => sum + task.duration_minutes, 0);
      const remaining = options.dailyMinutes - used;
      if (remaining < 15) {
        skipped.push(`Day${day.day_index}·${plan.subject}`);
        continue;
      }
      const incoming = sourceDay.tasks.map((task) => ({ ...task, subject: plan.subject }));
      const fresh = fit_tasks_to_minutes(incoming, remaining).filter(
        (task) =>
          !day.tasks.some((item) => item.subject === task.subject && item.title === task.title),
      );
      if (!fresh.length) {
        continue;
      }
      day.tasks.push(...fresh);
      added += fresh.length;
      if (!day.focus.includes(plan.subject)) {
        day.focus = day.focus ? `${day.focus} / ${plan.subject}` : plan.subject;
      }
    }
  }

  return { days, added, skipped };
}

/** 按科目把任务分组（界面展示用，保持科目首次出现的顺序）。 */
export function group_tasks_by_subject(
  tasks: StudyTask[],
): Array<{ subject: string; tasks: StudyTask[] }> {
  const groups: Array<{ subject: string; tasks: StudyTask[] }> = [];
  for (const task of tasks) {
    const subject = (task.subject || "未分类").trim() || "未分类";
    let group = groups.find((item) => item.subject === subject);
    if (!group) {
      group = { subject, tasks: [] };
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}
