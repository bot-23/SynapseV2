/**
 * Python 语义兼容小工具（仅供 domain 翻译层使用，保证与 Python 版逐字一致）。
 * - stripChars：对应 str.strip(chars)
 * - pyTruncInt：对应 int(float)（向零取整）
 * - floorDiv：对应 //（向下取整除法，本场景均为正数）
 * - pyInt：对应 int(value)，失败抛错（由调用方转 fallback）
 * - replaceFirst：对应 str.replace(old, new, 1)
 */

export function stripChars(text: string, chars: string): string {
  const set = new Set(chars.split(""));
  let start = 0;
  let end = text.length;
  while (start < end && set.has(text[start]!)) start += 1;
  while (end > start && set.has(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

export function pyTruncInt(value: number): number {
  return Math.trunc(value);
}

export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function pyInt(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("int(): non-finite");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    throw new Error(`int(): invalid literal ${value}`);
  }
  throw new Error("int(): unsupported type");
}

export function replaceFirst(text: string, search: string, replacement: string): string {
  const index = text.indexOf(search);
  if (index < 0) {
    return text;
  }
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}

/** Python round()：银行家舍入（half-to-even）。 */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) {
    return floor;
  }
  if (diff > 0.5) {
    return floor + 1;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}
