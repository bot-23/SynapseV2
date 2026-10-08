/**
 * 作业包编解码（纯函数，零依赖）。
 *
 * 格式是一段纯文本，逐行：
 *
 *     SYNAPSE-ASG/1
 *     2026-03-05|数学|第三章习题|20|题|30
 *     2026-03-06|英语|背Unit3单词|0||15
 *
 * 为什么不用 JSON + Base64：core 连 `btoa` / `TextEncoder` 都不许碰（那属于宿主环境），
 * 自己补一套 UTF-8 与 Base64 只为了塞进二维码并不划算；纯文本每行 30~50 字，
 * 二维码版本更低、扫得更快，而且扫出来人能直接看懂对错。
 */

import type { AssignmentItem } from "../protocol/study.js";

/** 首行签名，用来判断「扫到的这段码到底是不是作业包」。带版本号，好做前向兼容。 */
export const ASSIGNMENT_PACK_HEADER = "SYNAPSE-ASG/1";

/** 单包最多带多少条：再多人眼也核对不过来，二维码也会大到扫不动。 */
export const ASSIGNMENT_PACK_MAX_ITEMS = 60;

/** 字段长度上限，防止有人把一整段话当标题塞进来把码撑爆。 */
const FIELD_MAX_CHARS = 60;

/** 数量 / 预估时长的上限：解码来自二维码，数值必须收口，不能只取下界。 */
const QUANTITY_MAX = 100_000;
const MINUTES_MAX = 24 * 60 * 30;

/** 整段短码的最大字符数：先按长度截断，避免对超长输入先建完整行数组。 */
const CODE_MAX_CHARS = 20_000;

/** 一行拆出来的原始字段。 */
export interface AssignmentPackDraft {
  due_date: string;
  subject: string;
  title: string;
  quantity: number;
  unit: string;
  estimated_minutes: number;
}

/**
 * 字段里不能出现分隔符和换行，否则整行无法还原。
 * 顺手把连续空白压成一个空格 —— 换行在二维码里也容易被扫成空格。
 */
function sanitize_field(value: string): string {
  return String(value ?? "")
    .replace(/[|\r\n\u0000]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FIELD_MAX_CHARS);
}

/** 数值收口到 [min, max]；NaN / 无穷大一律取 min。 */
function clampNumber(value: number, min: number, max: number): number {
  const truncated = Math.trunc(value);
  if (!Number.isFinite(truncated)) {
    return min;
  }
  return Math.min(max, Math.max(min, truncated));
}

/** 打包：把作业条目编成短码。调用方负责先筛掉已完成的。 */
export function encode_assignment_pack(items: readonly AssignmentItem[]): string {
  const lines = [ASSIGNMENT_PACK_HEADER];
  for (const item of items.slice(0, ASSIGNMENT_PACK_MAX_ITEMS)) {
    lines.push(
      [
        sanitize_field(item.due_date),
        sanitize_field(item.subject),
        sanitize_field(item.title),
        String(Math.max(0, Math.trunc(item.quantity))),
        sanitize_field(item.unit),
        String(Math.max(0, Math.trunc(item.estimated_minutes))),
      ].join("|"),
    );
  }
  return lines.join("\n");
}

/**
 * 解包。宽容读取：多余空行、行尾空白、BOM、Windows 换行都照收，
 * 单行格式不对只丢那一行并计数，不整包作废（免得同学少填一格就全军覆没）。
 */
export function decode_assignment_pack(code: string): {
  recognized: boolean;
  drafts: AssignmentPackDraft[];
  invalid: number;
} {
  const lines = String(code ?? "")
    .replace(/^\uFEFF/, "")
    .slice(0, CODE_MAX_CHARS)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines.shift() ?? "";
  if (header !== ASSIGNMENT_PACK_HEADER) {
    return { recognized: false, drafts: [], invalid: 0 };
  }

  const drafts: AssignmentPackDraft[] = [];
  let invalid = 0;
  for (const line of lines.slice(0, ASSIGNMENT_PACK_MAX_ITEMS)) {
    const parts = line.split("|");
    if (parts.length !== 6) {
      invalid += 1;
      continue;
    }
    const dueDate = parts[0] ?? "";
    const title = (parts[2] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !title) {
      invalid += 1;
      continue;
    }
    drafts.push({
      due_date: dueDate,
      subject: sanitize_field(parts[1] ?? ""),
      // 解码同样过一遍消毒：短码是外来数据，字段长度必须与打包侧一致地收口
      title: sanitize_field(title),
      quantity: clampNumber(Number(parts[3]), 0, QUANTITY_MAX),
      unit: sanitize_field(parts[4] ?? ""),
      estimated_minutes: clampNumber(Number(parts[5]), 0, MINUTES_MAX),
    });
  }
  return { recognized: true, drafts, invalid };
}
