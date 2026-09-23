/**
 * 课程表（纯函数，无 IO）。
 *
 * 能力：
 * - parse_timetable_text：把从教务系统/Excel 复制的课表文本解析成结构化条目
 * - summarize_day_busy：按星期汇总占用时段与空闲时长
 * - apply_timetable_to_payload：把课表约束注入计划请求（仅在存在课表时生效，
 *   因此不导入课表时旧行为与黄金样本完全不变）
 */

import type {
  DayBusySummary,
  StudyPlanRequest,
  TimetableEntry,
  TimetableParseResult,
} from "../protocol/study";
import type { IdGen } from "../ports/index";
import { systemIdGen } from "../ports/index";

const WEEKDAY_ALIASES: Array<[RegExp, number]> = [
  [/^(周一|星期一|礼拜一|周1|星期1|mon|monday)$/i, 1],
  [/^(周二|星期二|礼拜二|周2|星期2|tue|tues|tuesday)$/i, 2],
  [/^(周三|星期三|礼拜三|周3|星期3|wed|wednesday)$/i, 3],
  [/^(周四|星期四|礼拜四|周4|星期4|thu|thur|thurs|thursday)$/i, 4],
  [/^(周五|星期五|礼拜五|周5|星期5|fri|friday)$/i, 5],
  [/^(周六|星期六|礼拜六|周6|星期6|sat|saturday)$/i, 6],
  [/^(周日|周天|星期日|星期天|礼拜日|礼拜天|周7|星期7|sun|sunday)$/i, 7],
];

const SECTION_TIME_PATTERNS: RegExp[] = [
  // 8:00-9:40 / 08:00~09:40 / 8：00－9：40
  /(\d{1,2})[:：](\d{2})\s*[-~～—－至到]\s*(\d{1,2})[:：](\d{2})/,
  // 8:00 9:40（用空格分隔）
  /(\d{1,2})[:：](\d{2})\s+(\d{1,2})[:：](\d{2})/,
];

const WEEKDAY_TOKEN_RE =
  /(周一|周二|周三|周四|周五|周六|周日|周天|星期一|星期二|星期三|星期四|星期五|星期六|星期日|星期天|礼拜一|礼拜二|礼拜三|礼拜四|礼拜五|礼拜六|礼拜日|礼拜天)/;

/** 一节的时间区间（从 00:00 起算的分钟数）。 */
export interface PeriodTime {
  start_minute: number;
  end_minute: number;
}

/**
 * 默认作息模板（12 节，含常见大课间）。
 *
 * 教务系统导出的课表绝大多数写「第 1-2 节」而不是钟点，
 * 之前必须手抄时间才能导入；有了这张表就能直接换算。
 * 各校作息不同，可通过 ParseTimetableOptions.periodSchedule 覆盖。
 */
export const DEFAULT_PERIOD_SCHEDULE: readonly PeriodTime[] = [
  { start_minute: 8 * 60, end_minute: 8 * 60 + 45 },
  { start_minute: 8 * 60 + 55, end_minute: 9 * 60 + 40 },
  { start_minute: 10 * 60, end_minute: 10 * 60 + 45 },
  { start_minute: 10 * 60 + 55, end_minute: 11 * 60 + 40 },
  { start_minute: 14 * 60, end_minute: 14 * 60 + 45 },
  { start_minute: 14 * 60 + 55, end_minute: 15 * 60 + 40 },
  { start_minute: 16 * 60, end_minute: 16 * 60 + 45 },
  { start_minute: 16 * 60 + 55, end_minute: 17 * 60 + 40 },
  { start_minute: 19 * 60, end_minute: 19 * 60 + 45 },
  { start_minute: 19 * 60 + 55, end_minute: 20 * 60 + 40 },
  { start_minute: 20 * 60 + 50, end_minute: 21 * 60 + 35 },
  { start_minute: 21 * 60 + 45, end_minute: 22 * 60 + 30 },
];

/** 「第1-2节」「1-2节」「第3节」→ 起止节次。 */
const PERIOD_RE = /第?\s*(\d{1,2})\s*(?:[-~～—－至到]\s*(\d{1,2}))?\s*节/;

/** 教室：A101 / 101 / 教一101 / 文渊楼302 / 实验楼 这类明确编号。 */
const CLASSROOM_RE =
  /^(?:[A-Za-z\u4e00-\u9fa5]{0,4}\d{2,4}[A-Za-z]?|.{1,10}(?:楼|室|馆|报告厅|阶梯教室).{0,8})$/;

function toMinute(hour: number, minute: number): number {
  return hour * 60 + minute;
}

function normalizeFullWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

export function parseWeekday(token: string): number | null {
  const cleaned = token.trim().replace(/\s/g, "");
  for (const [pattern, weekday] of WEEKDAY_ALIASES) {
    if (pattern.test(cleaned)) {
      return weekday;
    }
  }
  return null;
}

function extractTimeRange(
  line: string,
): { startMinute: number; endMinute: number; matchedText: string } | null {
  for (const pattern of SECTION_TIME_PATTERNS) {
    const matched = pattern.exec(line);
    if (!matched) {
      continue;
    }
    const startMinute = toMinute(Number(matched[1]), Number(matched[2]));
    const endMinute = toMinute(Number(matched[3]), Number(matched[4]));
    if (endMinute <= startMinute || endMinute > 24 * 60) {
      continue;
    }
    return { startMinute, endMinute, matchedText: matched[0] };
  }
  return null;
}

/** 把「第 N-M 节」按作息表换算成具体时间；没有节次或超出作息表范围时返回 null。 */
function resolvePeriodRange(
  line: string,
  schedule: readonly PeriodTime[],
): { startMinute: number; endMinute: number; matchedText: string } | null {
  const matched = PERIOD_RE.exec(line);
  if (!matched) {
    return null;
  }
  const first = Number(matched[1]);
  const last = matched[2] ? Number(matched[2]) : first;
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return null;
  }
  const from = Math.min(first, last);
  const to = Math.max(first, last);
  if (from < 1 || to > schedule.length) {
    return null;
  }
  const startMinute = schedule[from - 1]!.start_minute;
  const endMinute = schedule[to - 1]!.end_minute;
  if (endMinute <= startMinute) {
    return null;
  }
  return { startMinute, endMinute, matchedText: matched[0] };
}

/**
 * 这条课在第 week 教学周是否要上。
 * weeks 为空 = 每周；"1-16" = 区间；"3" = 单个周次；"单周"/"双周" = 奇偶周。
 * week 非法（未提供/小于 1）时一律返回 true，保持「不传周次就全算」的旧行为。
 */
export function is_entry_active_in_week(weeks: string, week: number): boolean {
  const value = String(weeks ?? "").trim();
  if (!value) {
    return true;
  }
  if (!Number.isFinite(week) || week < 1) {
    return true;
  }
  if (value === "单周") {
    return week % 2 === 1;
  }
  if (value === "双周") {
    return week % 2 === 0;
  }
  const range = /^(\d{1,2})-(\d{1,2})$/.exec(value);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return week >= Math.min(from, to) && week <= Math.max(from, to);
  }
  if (/^\d{1,2}$/.test(value)) {
    return week === Number(value);
  }
  return true;
}

/**
 * 从「课程名 + 可能的教室/教师」里分离出结构化字段。
 *
 * 刻意保守：只有明确像教室的 token 才会被摘出来，教师必须带「老师/教师」后缀。
 * 认不出来的一律并回课程名 —— 否则会把课程名误当成教师名，比不解析更糟。
 */
function splitNameLocationTeacher(tokens: string[]): {
  name: string;
  location: string;
  teacher: string;
} {
  if (tokens.length <= 1) {
    return { name: tokens[0] ?? "", location: "", teacher: "" };
  }
  const nameParts: string[] = [tokens[0]!];
  let location = "";
  let teacher = "";
  for (const token of tokens.slice(1)) {
    if (!location && CLASSROOM_RE.test(token)) {
      location = token;
      continue;
    }
    const teacherMatch = /^([\u4e00-\u9fa5]{2,4})(?:老师|教师)$/.exec(token);
    if (!teacher && teacherMatch) {
      teacher = teacherMatch[1]!;
      continue;
    }
    nameParts.push(token);
  }
  return { name: nameParts.join(" "), location, teacher };
}

function extractWeeks(line: string): string {
  // 1-16周 / 第1-16周 / 1~16 / 单周 / 双周
  const rangeMatch = /(?:第)?\s*(\d{1,2})\s*[-~～—－至到]\s*(\d{1,2})\s*周?/.exec(line);
  if (rangeMatch) {
    return `${rangeMatch[1]}-${rangeMatch[2]}`;
  }
  const singleMatch = /(?:第)?\s*(\d{1,2})\s*周/.exec(line);
  if (singleMatch) {
    return singleMatch[1]!;
  }
  if (/单周/.test(line)) {
    return "单周";
  }
  if (/双周/.test(line)) {
    return "双周";
  }
  return "";
}

function stripKnownParts(line: string, parts: string[]): string {
  let rest = line;
  for (const part of parts) {
    if (part) {
      rest = rest.replace(part, " ");
    }
  }
  return rest;
}

function cleanFragment(text: string): string {
  return text.replace(/[\s,，、;；|]+/g, " ").trim();
}

export interface ParseTimetableOptions {
  defaultSubject?: string;
  idGen?: IdGen;
  /** 自定义作息表；缺省用 DEFAULT_PERIOD_SCHEDULE 换算「第 N-M 节」。 */
  periodSchedule?: readonly PeriodTime[];
}

/**
 * 解析课表文本。
 * 支持每行一门课（含星期与时间），也支持「星期表头 + 逐行课程」的表格粘贴。
 * 时间既可写钟点（08:00-09:40），也可写节次（第1-2节，按作息表换算）。
 */
export function parse_timetable_text(
  text: string,
  options: ParseTimetableOptions = {},
): TimetableParseResult {
  const idGen = options.idGen ?? systemIdGen;
  const schedule = options.periodSchedule ?? DEFAULT_PERIOD_SCHEDULE;
  const entries: TimetableEntry[] = [];
  const unparsedLines: string[] = [];
  const warnings: string[] = [];

  let currentWeekday: number | null = null;

  for (const rawLine of (text || "").split(/\r?\n/)) {
    const normalized = normalizeFullWidth(rawLine).trim();
    if (!normalized) {
      continue;
    }

    // 纯表头行：只更新「当前星期」上下文
    const weekdayToken = WEEKDAY_TOKEN_RE.exec(normalized);
    // 钟点优先；没有钟点时退回「第 N-M 节」+ 作息表
    const clockRange = extractTimeRange(normalized);
    const timeRange = clockRange ?? resolvePeriodRange(normalized, schedule);

    if (weekdayToken && !timeRange) {
      const parsed = parseWeekday(weekdayToken[0]);
      if (parsed) {
        currentWeekday = parsed;
        const rest = normalized.slice(weekdayToken.index + weekdayToken[0].length).trim();
        if (!rest) {
          continue;
        }
        // 表头后还有内容，视为「周一 高数 8:00-9:40」这类紧排文本，继续走下面的解析
      }
    }

    const resolvedWeekday = weekdayToken
      ? parseWeekday(weekdayToken[0])
      : currentWeekday;

    if (!timeRange || !resolvedWeekday) {
      unparsedLines.push(rawLine.trim());
      continue;
    }

    // 先摘掉时间/节次再解析周次，避免把「08:00-09:40」「1-2节」误认成周次区间
    const lineWithoutTime = normalized.replace(timeRange.matchedText, " ");
    const weeks = extractWeeks(lineWithoutTime);
    const rest = cleanFragment(
      stripKnownParts(lineWithoutTime, [
        weekdayToken?.[0] ?? "",
        weeks ? `${weeks}周` : "",
        weeks,
        "第",
        "周",
      ]),
    );

    if (!rest) {
      unparsedLines.push(rawLine.trim());
      continue;
    }

    // 教室/教师只在能明确识别时摘出，其余还原进课程名
    const parts = splitNameLocationTeacher(rest.split(/\s+/).filter(Boolean));
    const courseName = parts.name || rest;
    const subject = (options.defaultSubject ?? "").trim() || courseName;
    entries.push({
      id: idGen.next(),
      name: courseName,
      subject,
      weekday: resolvedWeekday,
      startMinute: timeRange.startMinute,
      endMinute: timeRange.endMinute,
      weeks,
      location: parts.location,
      teacher: parts.teacher,
    });
  }

  if (!entries.length && unparsedLines.length) {
    warnings.push("没能从这段文本里识别出课程，请检查是否包含星期与起止时间，或改为手动录入。");
  }
  if (unparsedLines.length && entries.length) {
    warnings.push(`有 ${unparsedLines.length} 行没识别出来，已列出供你手动校正。`);
  }

  return { entries, unparsedLines, warnings };
}

function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday - 1] ?? `周${weekday}`;
}

/**
 * 汇总某星期几的占用情况。
 * freeMinutes 以「可支配时间窗」计：默认按 08:00–22:00 共 840 分钟减去占用。
 * week 传 0（默认）时不按单双周/周次过滤，即把课表当作每周固定 —— 旧行为不变。
 */
export function summarize_day_busy(
  entries: TimetableEntry[],
  weekday: number,
  windowStartMinute = 8 * 60,
  windowEndMinute = 22 * 60,
  week = 0,
): DayBusySummary {
  const dayEntries = entries
    .filter((entry) => entry.weekday === weekday && is_entry_active_in_week(entry.weeks, week))
    .sort((a, b) => a.startMinute - b.startMinute);

  let busyMinutes = 0;
  let cursor = windowStartMinute;
  const busyRanges: string[] = [];

  for (const entry of dayEntries) {
    const start = Math.max(entry.startMinute, windowStartMinute);
    const end = Math.min(entry.endMinute, windowEndMinute);
    if (end <= start) {
      continue;
    }
    busyMinutes += end - Math.max(start, cursor);
    cursor = Math.max(cursor, end);
    busyRanges.push(`${formatMinute(entry.startMinute)}-${formatMinute(entry.endMinute)}`);
  }

  const windowMinutes = Math.max(0, windowEndMinute - windowStartMinute);
  return {
    day_index: weekday,
    busy_minutes: Math.max(0, busyMinutes),
    busy_ranges: busyRanges,
    free_minutes: Math.max(0, windowMinutes - Math.max(0, busyMinutes)),
    entries: dayEntries,
  };
}

/** 生成给计划生成用的课表上下文（无课表时返回空数组，保证旧行为不变）。 */
export function build_timetable_context(entries: TimetableEntry[], week = 0): string[] {
  if (!entries.length) {
    return [];
  }
  const lines: string[] = [`课程表：已导入 ${entries.length} 节课，计划需避开这些时段。`];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const summary = summarize_day_busy(entries, weekday, 8 * 60, 22 * 60, week);
    if (!summary.entries.length) {
      continue;
    }
    const names = summary.entries
      .map((entry) => `${entry.name}(${formatMinute(entry.startMinute)}-${formatMinute(entry.endMinute)})`)
      .join("、");
    lines.push(`${weekdayLabel(weekday)}：${names}；当天可支配约 ${summary.free_minutes} 分钟。`);
  }
  return lines;
}

/**
 * 把课表约束注入计划请求。
 * 仅在存在课表条目时改变 payload —— 未导入课表时返回原对象内容，旧行为不变。
 */
export function apply_timetable_to_payload(
  payload: StudyPlanRequest,
  entries: TimetableEntry[],
): StudyPlanRequest {
  if (!entries.length) {
    return payload;
  }

  const context = build_timetable_context(entries);
  const preferences = [...payload.preferences, ...context];

  // 用课表占用校正每天可用时长：
  // 只在「有课的星期」里取最紧张的一天（可支配 ≥ 60 分钟）作为上限，
  // 避免单天满课把整周预算压到不可用；没有任何可用课日时保持用户原本声明值。
  let constrained = Number.POSITIVE_INFINITY;
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const summary = summarize_day_busy(entries, weekday);
    if (!summary.entries.length || summary.free_minutes < 60) {
      continue;
    }
    constrained = Math.min(constrained, summary.free_minutes);
  }
  const ceiling = Number.isFinite(constrained)
    ? constrained
    : payload.available_minutes_per_day;
  const adjustedMinutes = Math.max(
    15,
    Math.min(720, Math.min(payload.available_minutes_per_day, ceiling)),
  );

  return {
    ...payload,
    available_minutes_per_day: adjustedMinutes,
    preferences,
  };
}

/** 列出课表涉及的科目（用于计划按科目分组的候选集）。 */
export function list_timetable_subjects(entries: TimetableEntry[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const subject = (entry.subject || entry.name).trim();
    if (!subject || seen.has(subject)) {
      continue;
    }
    seen.add(subject);
    result.push(subject);
  }
  return result;
}
