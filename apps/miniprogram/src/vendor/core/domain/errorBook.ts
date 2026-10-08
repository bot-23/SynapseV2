/**
 * 错题本：把「做错的题」沉淀成可复习的结构化条目。
 *
 * 这是此前断掉的一环 —— 系统会排程、会出题，但没有「做错 → 记下 → 复习」的闭环。
 * 每条错题都会关联一个复习知识点（review_key），入本时同步进间隔重复队列。
 */

import { review_key } from "./review";

export interface ErrorItem {
  id: string;
  subject: string;
  topic: string;
  question: string;
  answer: string;
  user_answer: string;
  /** 来源：quiz（测验判分）/ manual（手动录入） */
  source: string;
  created_at: string;
  /** 关联的复习卡键（科目::知识点）。 */
  review_key: string;
}

/** 错题本上限，防止 KV 无限膨胀。 */
export const ERROR_BOOK_MAX_ITEMS = 500;
/** 单个文本字段的字符上限。 */
export const ERROR_FIELD_MAX_CHARS = 1_000;

function clean(value: unknown, max = ERROR_FIELD_MAX_CHARS): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 规范化一条错题：字段清洗 + 限长 + 补默认值，保证入库形状稳定。 */
export function normalize_error_item(args: {
  id: string;
  subject: string;
  topic: string;
  question: string;
  answer: string;
  userAnswer?: string;
  source?: string;
  createdAt: string;
}): ErrorItem {
  const subject = clean(args.subject, 100) || "未分类";
  const topic = clean(args.topic, 200) || "未命名知识点";
  return {
    id: args.id,
    subject,
    topic,
    question: clean(args.question),
    answer: clean(args.answer),
    user_answer: clean(args.userAnswer ?? ""),
    source: clean(args.source ?? "manual", 40) || "manual",
    created_at: args.createdAt,
    review_key: review_key(subject, topic),
  };
}

/** 判重：同一科目 + 同一题面视为同一道错题。 */
export function error_item_dedupe_key(item: ErrorItem): string {
  return `${item.subject}::${item.question}`.toLowerCase();
}
