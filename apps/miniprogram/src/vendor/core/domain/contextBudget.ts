export type ContextSource =
  | "document"
  | "timetable"
  | "progress"
  | "profile"
  | "graph"
  | "other";

export const CONTEXT_BUDGET = 8;

export const CONTEXT_QUOTAS: ReadonlyArray<readonly [ContextSource, number]> = [
  ["document", 3],
  ["timetable", 2],
  ["progress", 1],
  ["profile", 1],
  ["graph", 1],
  ["other", 0],
];

export function classify_context_line(line: string): ContextSource {
  const text = String(line ?? "");
  if (text.startsWith("资料命中[")) {
    return "document";
  }
  if (text.startsWith("课程表：") || /^周[一二三四五六日天]：/.test(text)) {
    return "timetable";
  }
  if (text.startsWith("最近执行情况：") || text.startsWith("执行调整建议：")) {
    return "progress";
  }
  if (text.startsWith("长期偏好：") || text.startsWith("长期约束：")) {
    return "profile";
  }
  if (text.startsWith("图谱")) {
    return "graph";
  }
  return "other";
}

export function allocate_context_budget(
  lines: readonly string[],
  budget: number = CONTEXT_BUDGET,
): string[] {
  if (!lines.length || budget <= 0) {
    return [];
  }

  const buckets = new Map<ContextSource, string[]>();
  for (const line of lines) {
    const source = classify_context_line(line);
    const bucket = buckets.get(source);
    if (bucket) {
      bucket.push(line);
    } else {
      buckets.set(source, [line]);
    }
  }

  const sourceOrder: ContextSource[] = [
    ...CONTEXT_QUOTAS.map(([source]) => source),
    ...[...buckets.keys()].filter(
      (source) => !CONTEXT_QUOTAS.some(([declared]) => declared === source),
    ),
  ];
  const used = new Map<ContextSource, number>();
  let remaining = budget;

  for (const [source, quota] of CONTEXT_QUOTAS) {
    const bucket = buckets.get(source) ?? [];
    const take = Math.min(quota, bucket.length, remaining);
    used.set(source, take);
    remaining -= take;
  }

  for (const source of sourceOrder) {
    if (remaining <= 0) {
      break;
    }
    const bucket = buckets.get(source) ?? [];
    const already = used.get(source) ?? 0;
    const extra = Math.min(remaining, bucket.length - already);
    if (extra > 0) {
      used.set(source, already + extra);
      remaining -= extra;
    }
  }

  const result: string[] = [];
  for (const source of sourceOrder) {
    const bucket = buckets.get(source) ?? [];
    const take = Math.min(used.get(source) ?? 0, bucket.length);
    result.push(...bucket.slice(0, take));
  }
  return result;
}

export interface ParsedDocumentHit {
  file_name: string;
  excerpt: string;
}

export function parse_document_hit(line: string): ParsedDocumentHit | null {
  const match = /^资料命中\[(.+?)\]:\s?([\s\S]*)$/.exec(String(line ?? ""));
  if (!match) {
    return null;
  }
  return { file_name: match[1]!, excerpt: match[2] ?? "" };
}

export function collect_document_hits(context: readonly string[]): ParsedDocumentHit[] {
  return context
    .map(parse_document_hit)
    .filter((hit): hit is ParsedDocumentHit => hit !== null);
}

export function summarize_context_sources(
  context: readonly string[],
): Record<ContextSource, number> {
  const counts: Record<ContextSource, number> = {
    document: 0,
    timetable: 0,
    progress: 0,
    profile: 0,
    graph: 0,
    other: 0,
  };
  for (const line of context) {
    counts[classify_context_line(line)] += 1;
  }
  return counts;
}
