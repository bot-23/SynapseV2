/**
 * 输入扩展回归测试：docx 文本提取路由 + ICS 课表导入。
 *
 * 这两块此前都是空白 —— 只认 txt/md/pdf，课表只能粘贴文本或手抄。
 */

import { describe, expect, it } from "vitest";

import { createSynapseCore } from "../src/application/core.js";
import { extract_attachments } from "../src/application/fileExtract.js";
import { parse_ics_timetable } from "../src/domain/timetableIcs.js";

const fixedClock = { nowIso: () => "2026-03-04T09:00:00.000Z" };

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "SUMMARY:高等数学",
  "LOCATION:教一101",
  "DESCRIPTION:教师：张三",
  "DTSTART:20260302T080000",
  "DTEND:20260302T094000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:大学英语",
  "DTSTART:20260303T140000",
  "DTEND:20260303T153000",
  "RRULE:FREQ=WEEKLY;BYDAY=TU,TH",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

describe("ICS 课表导入", () => {
  it("解析每周课程：BYDAY 多值时展开成多条", () => {
    const result = parse_ics_timetable(ICS);
    expect(result.entries.length).toBe(3);

    const math = result.entries.find((entry) => entry.name === "高等数学")!;
    expect(math.weekday).toBe(1); // 周一
    expect(math.startMinute).toBe(8 * 60);
    expect(math.endMinute).toBe(9 * 60 + 40);
    expect(math.location).toBe("教一101");
    expect(math.teacher).toBe("张三");

    const englishWeekdays = result.entries
      .filter((entry) => entry.name === "大学英语")
      .map((entry) => entry.weekday)
      .sort();
    expect(englishWeekdays).toEqual([2, 4]); // 周二、周四
  });

  it("折行续行与转义字符被正确处理", () => {
    const folded = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:线性代数\\, 第二章",
      "DTSTART:20260302T100000",
      "DTEND:20260302T114000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const result = parse_ics_timetable(folded);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.name).toBe("线性代数, 第二章");
    expect(result.entries[0]!.weekday).toBe(3);
  });

  it("非 ICS 内容给出警告而不是抛错", () => {
    const result = parse_ics_timetable("这就是一段普通文本");
    expect(result.entries.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("core.parseTimetableIcs 走同一条解析链路", () => {
    const core = createSynapseCore({ clock: fixedClock });
    const response = core.parseTimetableIcs(ICS);
    expect(response.success).toBe(true);
    expect((response.data as { entries: unknown[] }).entries.length).toBe(3);
  });
});

describe("docx 文本提取路由", () => {
  it("docx 交给壳注入的提取器解析", async () => {
    const calls: string[] = [];
    const attachments = await extract_attachments(
      [{ name: "讲义.docx", data: new Uint8Array([1, 2, 3]) }],
      {
        extract: async (fileName: string) => {
          calls.push(fileName);
          return "这是 Word 文档里的正文";
        },
      },
    );
    expect(calls).toEqual(["讲义.docx"]);
    expect(attachments[0]!.extraction_status).toBe("done");
    expect(attachments[0]!.extracted_text).toContain("Word 文档");
  });

  it("未注入提取器时 docx 明确报错，而不是静默返回空", async () => {
    const attachments = await extract_attachments(
      [{ name: "讲义.docx", data: new Uint8Array([1]) }],
      null,
    );
    expect(attachments[0]!.extraction_status).toBe("error");
    expect(attachments[0]!.extraction_error).toContain("DOCX");
  });

  it("不支持的格式给出包含 docx 的能力说明", async () => {
    const attachments = await extract_attachments(
      [{ name: "表格.xlsx", data: new Uint8Array([1]) }],
      null,
    );
    expect(attachments[0]!.extraction_status).toBe("unsupported");
    expect(attachments[0]!.extraction_error).toContain("docx");
  });
});
