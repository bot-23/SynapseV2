/**
 * ICS 日历导入（纯函数，无 IO）。
 *
 * 为什么需要：课表目前只能靠「粘贴文本 / 手抄」，而教务系统与手机日历都能导出 .ics。
 * 解析 ICS 比解析截图课表可靠得多 —— 没有 OCR，也不依赖任何第三方库。
 *
 * 取舍：只取「每周重复」的日程（BYDAY / DTSTART 的星期），时间按墙上时钟读，
 * 不做时区换算 —— 教务导出的 ICS 基本都是本地时间（不带 Z），换算反而会引入偏差。
 */

import type { TimetableEntry, TimetableParseResult } from "../protocol/study.js";
import type { IdGen } from "../ports/index.js";
import { systemIdGen } from "../ports/index.js";

const ICS_WEEKDAY: Record<string, number> = {
  SU: 7,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export interface ParseIcsOptions {
  defaultSubject?: string;
  idGen?: IdGen;
}

/** ICS 允许折行：以空格/制表符开头的行是上一行的续行。 */
function unfoldIcsLines(text: string): string[] {
  const raw = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

interface IcsProperty {
  name: string;
  value: string;
}

function parseProperty(line: string): IcsProperty | null {
  const sep = line.indexOf(":");
  if (sep <= 0) {
    return null;
  }
  const head = line.slice(0, sep);
  const value = line.slice(sep + 1);
  const semi = head.indexOf(";");
  const name = (semi >= 0 ? head.slice(0, semi) : head).trim().toUpperCase();
  return { name, value };
}

/** 解析 YYYYMMDDTHHMMSS[Z]；纯日期（全天事件）返回 null。 */
function parseDateTime(value: string): { weekday: number; minute: number } | null {
  const matched = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?Z?$/.exec(value.trim());
  if (!matched) {
    return null;
  }
  const [, year, month, day, hour] = matched;
  if (hour === undefined) {
    return null;
  }
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  const weekday = ((date.getDay() + 6) % 7) + 1; // JS: 0=周日 → 1=周一
  const minute = Number(hour) * 60 + Number(matched[5] ?? 0);
  return { weekday, minute };
}

function extractTeacher(description: string): string {
  const matched = /(?:教师|老师|授课教师)[:：]\s*([^;，,\n]+)/.exec(description);
  return matched ? matched[1]!.trim().slice(0, 40) : "";
}

/** 解析 ICS 文本，抽取每周重复的课程条目。 */
export function parse_ics_timetable(
  text: string,
  options: ParseIcsOptions = {},
): TimetableParseResult {
  const idGen = options.idGen ?? systemIdGen;
  const entries: TimetableEntry[] = [];
  const unparsedLines: string[] = [];
  const warnings: string[] = [];

  const lines = unfoldIcsLines(text);
  if (!lines.some((line) => /^BEGIN:VCALENDAR/i.test(line))) {
    warnings.push("这不是标准的 ICS 日历文件（缺少 BEGIN:VCALENDAR）。");
    return { entries, unparsedLines, warnings };
  }

  let inEvent = false;
  let summary = "";
  let location = "";
  let description = "";
  let dtstart = "";
  let dtend = "";
  let bydays: string[] = [];

  const flush = (): void => {
    const start = parseDateTime(dtstart);
    const end = parseDateTime(dtend);
    if (!summary || !start || !end) {
      if (summary) {
        unparsedLines.push(summary);
      }
      return;
    }
    // DTEND 缺失/跨天时按「默认一节课 45 分钟」兜底
    const endMinute = end.minute > start.minute ? end.minute : Math.min(24 * 60, start.minute + 45);
    // RRULE 未给 BYDAY 时用 DTSTART 的星期
    const weekdays = bydays.length ? bydays : [String(start.weekday)];
    for (const token of weekdays) {
      const weekday = ICS_WEEKDAY[token.toUpperCase()] ?? start.weekday;
      entries.push({
        id: idGen.next(),
        name: summary,
        subject: (options.defaultSubject ?? "").trim() || summary,
        weekday,
        startMinute: start.minute,
        endMinute,
        weeks: "",
        location,
        teacher: extractTeacher(description),
      });
    }
  };

  const resetEvent = (): void => {
    summary = "";
    location = "";
    description = "";
    dtstart = "";
    dtend = "";
    bydays = [];
  };

  for (const line of lines) {
    const prop = parseProperty(line);
    if (!prop) {
      continue;
    }
    if (prop.name === "BEGIN" && prop.value.trim().toUpperCase() === "VEVENT") {
      inEvent = true;
      resetEvent();
      continue;
    }
    if (prop.name === "END" && prop.value.trim().toUpperCase() === "VEVENT") {
      if (inEvent) {
        flush();
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) {
      continue;
    }
    switch (prop.name) {
      case "SUMMARY":
        summary = unescapeIcs(prop.value);
        break;
      case "LOCATION":
        location = unescapeIcs(prop.value);
        break;
      case "DESCRIPTION":
        description = unescapeIcs(prop.value);
        break;
      case "DTSTART":
        dtstart = prop.value;
        break;
      case "DTEND":
        dtend = prop.value;
        break;
      case "RRULE": {
        const matched = /BYDAY=([^;]+)/i.exec(prop.value);
        if (matched) {
          bydays = matched[1]!
            .split(",")
            .map((token) => token.trim().replace(/^[+-]?\d+/, ""))
            .filter(Boolean);
        }
        break;
      }
    }
  }

  if (!entries.length) {
    warnings.push("没能从这份日历里识别出每周课程（需要带时间的 VEVENT）。");
  }
  if (unparsedLines.length) {
    warnings.push(`有 ${unparsedLines.length} 条日程没有时间信息，已跳过。`);
  }

  return { entries, unparsedLines, warnings };
}
