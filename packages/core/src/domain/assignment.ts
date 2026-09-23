/**
 * 作业式计划（纯函数，零依赖，离线可用）。
 *
 * 「目标式计划」回答的是「我想学什么」，作业式计划回答的是「我必须交什么」：
 * 老师布置的作业自带截止日与数量，系统要做的是解析出来、摊到截止前的每一天、盯着打卡。
 *
 * 这里只放确定性逻辑：日期词表解析、数量估算、按截止日倒排摊量、倒计时。
 * 没配模型 Key 时整条链路照样跑得通 —— 这是本模块存在的意义。
 */

import type {
  AssignmentDaySlot,
  AssignmentItem,
  AssignmentSlotTask,
} from "../protocol/study.js";
import { fit_tasks_to_minutes } from "./planFit.js";
import { add_days, days_between } from "./dateMath.js";
import { detect_subject_from_text } from "./subjectInfer.js";

/** 每天任务默认铺排天数（作业一般在一周内交）。 */
export const ASSIGNMENT_HORIZON_DAYS = 7;

/** 单位 → 单件分钟数。约定：1题≈3分钟、1页≈10分钟、1单词≈0.5分钟。 */
const UNIT_MINUTES: Readonly<Record<string, number>> = {
  题: 3,
  页: 10,
  单词: 0.5,
  字: 0.05,
  张: 30,
  篇: 20,
  遍: 5,
  个: 3,
  套: 20,
  组: 10,
};

const UNIT_ALIASES: Readonly<Record<string, string>> = {
  道题: "题",
  小题: "题",
  大题: "题",
  道: "题",
  个单词: "单词",
  单词表: "单词",
  个字: "字",
};

/**
 * 可计量的单位。
 * 刻意**不含**「课」「章」「单元」：「抄写第 5 课」里的 5 是课次标识，不是数量，
 * 把它当数量会凭空造出「5 课」这种不存在的作业量。
 */
const UNIT_PATTERN = "道题|小题|大题|道|题|个单词|单词表|单词|页|张|篇|份|遍|套|组|个字|字|个";

/** 区间数量：「第1-20题」「1~20题」「3到5页」→ 总量（20 / 3），不是结束序号。 */
const RANGE_QUANTITY_RE = new RegExp(
  `第?\\s*(\\d+)\\s*(?:[-~～至到—]|\\s)\\s*(\\d+)\\s*(${UNIT_PATTERN})`,
);

/** 单位在前的区间：「习题1-20」「单词 30-50」——汉语里更常见的说法。 */
const UNIT_FIRST_RANGE_RE = new RegExp(
  `(${UNIT_PATTERN})\\s*(\\d{1,3})\\s*(?:[-~～至到—]|\\s)\\s*(\\d{1,3})`,
);

/** 单位重复的区间：「第3页到第5页」「1题至10题」——两端都写了单位。 */
const UNIT_BOTH_RANGE_RE = new RegExp(
  `第?\\s*(\\d{1,3})\\s*(${UNIT_PATTERN})\\s*(?:到|至|[-~～—])\\s*第?\\s*(\\d{1,3})\\s*(${UNIT_PATTERN})`,
);

/** 单值数量：「20题」「3页」；前面不紧跟字母数字，避免把「Unit3单词」的 3 当数量。 */
const SINGLE_QUANTITY_RE = new RegExp(`(^|[^A-Za-z0-9])(\\d+)\\s*(${UNIT_PATTERN})`);

/** 中文数字数量：「两篇」「十个」「一份」——中文作业里比阿拉伯数字更常见。 */
const CN_QUANTITY_RE = new RegExp(`([一二两三四五六七八九十]{1,3})\\s*(${UNIT_PATTERN})`);

const CN_DIGITS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 解析「十 / 十五 / 二十 / 二十三」这类中文数字；无法确定时返回 null。 */
function parse_cn_number(raw: string): number | null {
  const text = (raw || "").trim();
  if (!text) {
    return null;
  }
  if (text === "十") {
    return 10;
  }
  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : (CN_DIGITS[text[0]!] ?? 0);
    const ones =
      tenIndex === text.length - 1 ? 0 : (CN_DIGITS[text[tenIndex + 1]!] ?? 0);
    const value = tens * 10 + ones;
    return value > 0 ? value : null;
  }
  return text.length === 1 ? (CN_DIGITS[text] ?? null) : null;
}

/** 相对日期词表，越具体的越靠前。 */
const RELATIVE_DAY_WORDS: ReadonlyArray<readonly [string, number]> = [
  ["大后天", 3],
  ["后天", 2],
  ["明天", 1],
  ["明日", 1],
  ["明晚", 1],
  ["今天", 0],
  ["今日", 0],
  ["今晚", 0],
];

const WEEKDAY_CHARS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  末: 7,
};

const WEEKDAY_RE = /(下周|下星期|下礼拜|周|星期|礼拜)([一二三四五六日天末])/;
const MONTH_DAY_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/;
const SLASH_DAY_RE = /(?:^|[^\d/\-.])(\d{1,2})\s*\/\s*(\d{1,2})\s*[日号]?/;
const DAY_NUMBER_RE = /(\d{1,2})\s*号/;
const DAYS_LATER_RE = /(?:还有|再有|再|剩下|剩|过)\s*(\d{1,3})\s*天/;

/** 作业词：出现这些词才认为是在说老师布置的任务。 */
const HOMEWORK_WORDS = [
  "作业",
  "习题",
  "练习册",
  "卷子",
  "试卷",
  "要交",
  "上交",
  "提交",
  "默写",
  "背诵",
  "抄写",
  "实验报告",
  "周记",
  "读后感",
  "打卡",
  "背单词",
  "错题",
];

/** 截止时间提示词：没有它就不是作业（避免「我想学数学」被误判成作业）。 */
const DUE_HINT_RE =
  /(今天|今日|今晚|明天|明日|明晚|后天|大后天|下周|下星期|下礼拜|周[一二三四五六日天末]|星期[一二三四五六日天末]|礼拜[一二三四五六日天末]|\d{1,2}\s*月\s*\d{1,2}|\d{1,2}\s*号|\d{1,3}\s*天(后|内)|截止)/;

/** 一条解析出来的作业草稿（还没落库）。 */
export interface AssignmentDraft {
  subject: string;
  title: string;
  quantity: number;
  unit: string;
  due_date: string;
  estimated_minutes: number;
  /** 这句草稿来自哪段原话 */
  source_text: string;
}

function normalize_unit(raw: string): string {
  const value = (raw || "").trim();
  return UNIT_ALIASES[value] ?? value;
}

function extract_quantity(text: string): { quantity: number; unit: string } {
  // 「第3页到第5页」：两端都带单位，且单位要一致才算一个区间
  const both = UNIT_BOTH_RANGE_RE.exec(text);
  if (both) {
    const from = Math.min(Number(both[1]), Number(both[3]));
    const to = Math.max(Number(both[1]), Number(both[3]));
    if (to > from && normalize_unit(both[2]!) === normalize_unit(both[4]!)) {
      return { quantity: to - from + 1, unit: normalize_unit(both[2]!) };
    }
  }
  const range = RANGE_QUANTITY_RE.exec(text);
  if (range) {
    const first = Number(range[1]);
    const last = Number(range[2]);
    if (Number.isFinite(first) && Number.isFinite(last)) {
      const from = Math.min(first, last);
      const to = Math.max(first, last);
      if (to > from) {
        return { quantity: to - from + 1, unit: normalize_unit(range[3]!) };
      }
    }
  }
  const unitFirst = UNIT_FIRST_RANGE_RE.exec(text);
  if (unitFirst) {
    const first = Number(unitFirst[2]);
    const last = Number(unitFirst[3]);
    if (Number.isFinite(first) && Number.isFinite(last)) {
      const from = Math.min(first, last);
      const to = Math.max(first, last);
      if (to > from) {
        return { quantity: to - from + 1, unit: normalize_unit(unitFirst[1]!) };
      }
    }
  }
  const single = SINGLE_QUANTITY_RE.exec(text);
  if (single) {
    const quantity = Number(single[2]);
    if (Number.isFinite(quantity) && quantity > 0) {
      return { quantity, unit: normalize_unit(single[3]!) };
    }
  }
  const cn = CN_QUANTITY_RE.exec(text);
  if (cn) {
    const quantity = parse_cn_number(cn[1]!);
    if (quantity && quantity > 0) {
      return { quantity, unit: normalize_unit(cn[2]!) };
    }
  }
  return { quantity: 0, unit: "" };
}

/** 从 ISO 日期串取星期（1=周一 … 7=周日；非法日期返回 0）。 */
function iso_weekday(date: string): number {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time)) {
    return 0;
  }
  const day = new Date(time).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 把「月-日」拼成 YYYY-MM-DD；已过去的日期顺延一年。 */
function compose_month_day(today: string, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = Number(today.slice(0, 4));
  const candidate = `${year}-${pad(month)}-${pad(day)}`;
  const diff = days_between(today, candidate);
  if (diff !== null && diff < 0) {
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return `${nextYear}-${pad(nextMonth)}-${pad(day)}`;
  }
  return candidate;
}

/**
 * 解析相对日期，返回绝对日期 YYYY-MM-DD；解析不出返回 null。
 * 支持：今天/明天/后天/大后天、「还有 X 天」、周X/星期X/礼拜X、下周X、M月D日、M/D、D号。
 */
export function parse_assignment_due(text: string, today: string): string | null {
  const value = String(text ?? "");
  if (!value.trim()) {
    return null;
  }

  const monthDay = MONTH_DAY_RE.exec(value);
  if (monthDay) {
    const resolved = compose_month_day(today, Number(monthDay[1]), Number(monthDay[2]));
    if (resolved) {
      return resolved;
    }
  }

  const slashDay = SLASH_DAY_RE.exec(value);
  if (slashDay) {
    const resolved = compose_month_day(today, Number(slashDay[1]), Number(slashDay[2]));
    if (resolved) {
      return resolved;
    }
  }

  const daysLater = DAYS_LATER_RE.exec(value);
  if (daysLater) {
    const days = Number(daysLater[1]);
    if (Number.isFinite(days) && days >= 0) {
      return add_days(today, Math.min(365, days));
    }
  }

  const weekday = WEEKDAY_RE.exec(value);
  if (weekday) {
    const target = WEEKDAY_CHARS[weekday[2]!];
    const current = iso_weekday(today);
    if (target && current) {
      const marker = weekday[1]!;
      // 「整理一下周五交」里的「下周五」其实是「一下 + 周五」，看前一个字就能分辨
      const isNextWeek = marker.startsWith("下") && value[weekday.index - 1] !== "一";
      const delta = isNextWeek ? 7 - current + target : (target - current + 7) % 7;
      return add_days(today, delta);
    }
  }

  for (const [word, offset] of RELATIVE_DAY_WORDS) {
    if (value.includes(word)) {
      return add_days(today, offset);
    }
  }

  const dayNumber = DAY_NUMBER_RE.exec(value);
  if (dayNumber) {
    return compose_month_day(today, Number(today.slice(5, 7)), Number(dayNumber[1]));
  }

  return null;
}

/** 按单位估算总时长；没说单位时按 fallback（默认半小时）算。 */
export function estimate_assignment_minutes(
  quantity: number,
  unit: string,
  fallback = 30,
): number {
  const perUnit = UNIT_MINUTES[unit];
  if (quantity > 0 && perUnit) {
    return Math.max(5, Math.min(240, Math.round(quantity * perUnit)));
  }
  return Math.max(5, Math.min(240, Math.round(fallback || 30)));
}

/** 倒计时文案：「D-2」「今天截止」「已逾期 1 天」。 */
export function assignment_countdown(dueDate: string, today: string): string {
  const diff = days_between(today, dueDate);
  if (diff === null) {
    return "";
  }
  if (diff > 0) {
    return `D-${diff}`;
  }
  if (diff === 0) {
    return "今天截止";
  }
  return `已逾期 ${-diff} 天`;
}

/** 逾期判定：过了截止日且没做完。 */
export function is_assignment_overdue(item: AssignmentItem, today: string): boolean {
  if (item.status === "done") {
    return false;
  }
  const diff = days_between(today, item.due_date);
  return diff !== null && diff < 0;
}

/** 把入库的作业状态刷新成「今天」视角（逾期 / 待办 / 已完成）。 */
export function refresh_assignment_statuses(
  items: AssignmentItem[],
  today: string,
): AssignmentItem[] {
  return items.map((item) => {
    if (item.status === "done") {
      return item;
    }
    const status = is_assignment_overdue(item, today) ? "overdue" : "pending";
    return item.status === status ? item : { ...item, status };
  });
}

/** 强作业名词：出现这些词基本可以确定是老师布置的任务，优先于目标句式判定。 */
const STRONG_HOMEWORK_NOUNS = [
  "作业",
  "习题",
  "练习册",
  "卷子",
  "试卷",
  "实验报告",
  "周记",
  "读后感",
  "错题",
];

/** 目标句式动词：出现这些词说明用户在说「我想学」，而不是「我必须交」。 */
const GOAL_VERBS = ["开始", "打算", "想要", "计划", "坚持", "准备"];

/** 这句话是不是在说老师布置的作业（离线兜底判定）。 */
export function looks_like_assignment(text: string): boolean {
  const value = String(text ?? "").trim();
  if (!value) {
    return false;
  }
  if (!DUE_HINT_RE.test(value)) {
    return false;
  }
  if (STRONG_HOMEWORK_NOUNS.some((word) => value.includes(word))) {
    return true;
  }
  // 「明天开始背单词」有截止词和作业词，但语义是立目标，不是交作业。
  if (GOAL_VERBS.some((word) => value.includes(word))) {
    return false;
  }
  if (HOMEWORK_WORDS.some((word) => value.includes(word))) {
    return true;
  }
  return extract_quantity(value).quantity > 0;
}

/** 去掉日期词与「要交/提交」这类尾巴，留下任务本体作为标题。 */
function clean_title(fragment: string, subject: string): string {
  let title = fragment
    .replace(/下周[一二三四五六日天末]/g, "")
    .replace(/下?[周星期礼拜][一二三四五六日天末]/g, "")
    .replace(/[今明后大]天|今晚|明晚|今日/g, "")
    .replace(/还有\s*\d{1,3}\s*天/g, "")
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, "")
    .replace(/\d{1,2}\s*号/g, "");
  let previous = "";
  while (previous !== title) {
    previous = title;
    title = title.replace(/[，,。；;、:\s：]*(要交|上交|提交|截止|之前|以前|完成|做完|交)$/, "").trim();
  }
  title = title.replace(/^[，,。；;、:\s：]+|[，,。；;、:\s：]+$/g, "");
  if (subject && title.startsWith(subject)) {
    title = title.slice(subject.length).replace(/^[，,。；;、:\s：]+/, "");
  }
  return title.trim() || "作业";
}

/**
 * 把一段话拆成若干作业草稿。
 *
 * 先按逗号/分号/句号切开，再看每段是否自带日期或数量：
 * 都不带、且剥掉日期词后几乎没内容的短句，视为上一句的续写
 * （「数学第三章习题1-20，明天交」的后半截），合并回去，避免拆成两条作业。
 */
export function parse_assignment_items(text: string, today: string): AssignmentDraft[] {
  const rawParts = String(text ?? "")
    .split(/[，,；;。\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const merged: string[] = [];
  for (const part of rawParts) {
    // 剥掉日期词、数字与「要交」这类动词后还剩多少实质内容
    const coreText = part
      .replace(/[今明后大天周星期礼拜下月日号前后\s\d要交]/g, "")
      .trim();
    if (merged.length && coreText.length <= 2) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}${part}`;
      continue;
    }
    merged.push(part);
  }

  const drafts: AssignmentDraft[] = [];
  for (const fragment of merged) {
    const dueDate = parse_assignment_due(fragment, today);
    if (!dueDate) {
      continue;
    }
    const { quantity, unit } = extract_quantity(fragment);
    const subject = detect_subject_from_text(fragment) || (unit === "单词" ? "英语" : "");
    drafts.push({
      subject,
      title: clean_title(fragment, subject),
      quantity,
      unit,
      due_date: dueDate,
      estimated_minutes: estimate_assignment_minutes(quantity, unit),
      source_text: fragment,
    });
  }
  return drafts;
}

/** 单条作业在截止前的每日份额。 */
interface DailyShare {
  offset: number;
  quantity: number;
  minutes: number;
  /** 数量区间在整条作业里的起止序号（从 1 开始），用于「第 8-14 题」这类文案 */
  from_index: number;
  to_index: number;
}

/**
 * 把一条作业摊到 [今天, 截止日] 的每一天。
 * 逾期项（截止日已过）全部压在今天补做 —— 不假装时间还在，也不静默丢弃。
 */
function split_item_across_days(
  item: AssignmentItem,
  today: string,
  horizon: number,
): DailyShare[] {
  const remaining = days_between(today, item.due_date);
  const days = remaining === null || remaining < 0 ? 1 : Math.min(horizon, remaining + 1);
  const shares: DailyShare[] = [];
  const quantity = Math.max(0, Math.trunc(item.quantity));
  const baseQuantity = quantity > 0 ? Math.floor(quantity / days) : 0;
  const remainder = quantity > 0 ? quantity % days : 0;
  let cursor = 1;
  for (let offset = 0; offset < days; offset += 1) {
    const shareQuantity = quantity > 0 ? baseQuantity + (offset < remainder ? 1 : 0) : 0;
    const fromIndex = cursor;
    const toIndex = cursor + shareQuantity - 1;
    cursor += shareQuantity;
    shares.push({
      offset,
      quantity: shareQuantity,
      minutes: Math.max(1, Math.round(item.estimated_minutes / days)),
      from_index: fromIndex,
      to_index: toIndex,
    });
  }
  return shares;
}

function slot_title(item: AssignmentItem, share: DailyShare, countdown: string): string {
  const subject = item.subject ? `${item.subject}：` : "";
  let amount = "";
  if (item.quantity > 0) {
    if (item.unit === "题" && share.to_index >= share.from_index) {
      amount =
        share.from_index === share.to_index
          ? `（第 ${share.from_index} 题）`
          : `（第 ${share.from_index}-${share.to_index} 题）`;
    } else {
      amount = `（${share.quantity}${item.unit}）`;
    }
  }
  return `作业 · 截止${countdown}｜${subject}${item.title}${amount}`;
}

/**
 * 把当天任务收进每日预算。
 * 复用短期计划的 `fit_tasks_to_minutes`：它只做「原地改时长 + 从尾部丢弃」，
 * 顺序不变，因此可以按下标对齐回作业槽位。
 */
function fit_slot_tasks(tasks: AssignmentSlotTask[], budget: number): AssignmentSlotTask[] {
  const fitted = fit_tasks_to_minutes(
    tasks.map((task) => ({
      title: task.title,
      task_type: "practice" as const,
      duration_minutes: task.minutes,
      reason: task.title,
    })),
    budget,
  );
  return fitted.map((task, index) => ({ ...tasks[index]!, minutes: task.duration_minutes }));
}

/**
 * 按截止日排期：每条作业从今天起均匀摊到截止日，再按每日时长预算收口。
 * 已完成的作业不再排；逾期项排在今天。
 */
export function build_assignment_schedule(args: {
  items: AssignmentItem[];
  today: string;
  daily_minutes: number;
  horizon_days?: number;
}): AssignmentDaySlot[] {
  const horizon = Math.max(
    1,
    Math.min(30, Math.trunc(args.horizon_days ?? ASSIGNMENT_HORIZON_DAYS)),
  );
  const budget = Math.max(15, Math.min(720, Math.trunc(args.daily_minutes || 60)));
  const active = args.items
    .filter((item) => item.status !== "done" && item.title)
    .sort((a, b) => {
      if (a.due_date !== b.due_date) {
        return a.due_date < b.due_date ? -1 : 1;
      }
      return b.estimated_minutes - a.estimated_minutes;
    });
  if (!active.length) {
    return [];
  }

  const buckets = new Map<number, AssignmentSlotTask[]>();
  let earliestDue = "";
  for (const item of active) {
    const countdown = assignment_countdown(item.due_date, args.today);
    for (const share of split_item_across_days(item, args.today, horizon)) {
      if (share.offset >= horizon) {
        continue;
      }
      const bucket = buckets.get(share.offset) ?? [];
      bucket.push({
        assignment_id: item.id,
        title: slot_title(item, share, countdown),
        subject: item.subject,
        quantity: share.quantity,
        unit: item.unit,
        minutes: share.minutes,
        due_date: item.due_date,
      });
      buckets.set(share.offset, bucket);
      if (!earliestDue || item.due_date < earliestDue) {
        earliestDue = item.due_date;
      }
    }
  }

  const schedule: AssignmentDaySlot[] = [];
  for (let offset = 0; offset < horizon; offset += 1) {
    const tasks = buckets.get(offset);
    if (!tasks || !tasks.length) {
      continue;
    }
    const fitted = fit_slot_tasks(tasks, budget);
    const nearestDue = fitted.reduce(
      (best, task) => (best && best < task.due_date ? best : task.due_date),
      "",
    );
    schedule.push({
      date: add_days(args.today, offset),
      day_index: offset + 1,
      countdown: assignment_countdown(nearestDue || earliestDue, args.today),
      tasks: fitted,
      total_minutes: fitted.reduce((sum, task) => sum + task.minutes, 0),
    });
  }
  return schedule;
}

/** 逾期项重排：把剩余工作量挪到从今天起的若干天内，并留痕原始截止日。 */
export function reschedule_overdue_items(
  items: AssignmentItem[],
  today: string,
  dailyMinutes: number,
): AssignmentItem[] {
  const budget = Math.max(15, Math.min(720, Math.trunc(dailyMinutes || 60)));
  return items.map((item) => {
    if (!is_assignment_overdue(item, today)) {
      return item;
    }
    const days = Math.max(
      1,
      Math.min(ASSIGNMENT_HORIZON_DAYS, Math.ceil(item.estimated_minutes / budget)),
    );
    return {
      ...item,
      due_date: add_days(today, days),
      original_due_date: item.original_due_date || item.due_date,
      rescheduled_at: today,
      status: "pending" as const,
    };
  });
}
