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
} from "../protocol/study.js";
import type { IdGen } from "../ports/index.js";
import { systemIdGen } from "../ports/index.js";

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
}

/**
 * 解析课表文本。
 * 支持每行一门课（含星期与时间），也支持「星期表头 + 逐行课程」的表格粘贴。
 */
export function parse_timetable_text(
  text: string,
  options: ParseTimetableOptions = {},
): TimetableParseResult {
  const idGen = options.idGen ?? systemIdGen;
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
    const timeRange = extractTimeRange(normalized);

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

    // 先摘掉时间区间再解析周次，避免把「08:00-09:40」误认成周次区间
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

    const subject = (options.defaultSubject ?? "").trim() || rest;
    entries.push({
      id: idGen.next(),
      name: rest,
      subject,
      weekday: resolvedWeekday,
      startMinute: timeRange.startMinute,
      endMinute: timeRange.endMinute,
      weeks,
      location: "",
      teacher: "",
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
 */
export function summarize_day_busy(
  entries: TimetableEntry[],
  weekday: number,
  windowStartMinute = 8 * 60,
  windowEndMinute = 22 * 60,
): DayBusySummary {
  const dayEntries = entries
    .filter((entry) => entry.weekday === weekday)
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
export function build_timetable_context(entries: TimetableEntry[]): string[] {
  if (!entries.length) {
    return [];
  }
  const lines: string[] = [`课程表：已导入 ${entries.length} 节课，计划需避开这些时段。`];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const summary = summarize_day_busy(entries, weekday);
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
