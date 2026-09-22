/**
 * 日期算术（纯函数，只处理 YYYY-MM-DD）。
 *
 * core 不用 DOM/Node API，但 Date 是语言内置对象，web/小程序/Tauri/Node 四种宿主都有。
 * 三层计划（长期阶段 / 短期周计划 / 今日待办）都靠它把「第几天」和真实日期对上。
 */

/** 两个日期相差的天数（to - from）。任一无法解析时返回 null。 */
export function days_between(from: string, to: string): number | null {
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) {
    return null;
  }
  return Math.floor((toTime - fromTime) / 86400000);
}

/** 日期加天数，返回 YYYY-MM-DD；无法解析时原样返回。 */
export function add_days(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time)) {
    return date;
  }
  return new Date(time + days * 86400000).toISOString().slice(0, 10);
}

/** 从 ISO 时间戳里取日期部分。 */
export function to_date(isoTimestamp: string): string {
  return (isoTimestamp || "").slice(0, 10);
}
