/**
 * 系统日历写入适配器（微信小程序）。
 *
 * 课表里每节课都有星期与确切起止时间，正好对应系统日历的「每周重复事件」。
 * 这里把 core 的 TimetableEntry 转成 `wx.addPhoneRepeatCalendar` 需要的参数：
 * - startTime / endTime 用 unix 秒（微信要求）
 * - 锚点取「今天起下一次该星期」的那一天，保证首次出现不会落在过去
 * - repeatEndTime 由周次（如 1-16）推算，没写周次时默认重复 20 周
 */
import Taro from '@tarojs/taro'
import type { TimetableEntry } from '../vendor/core'

/** 没写周次时的默认重复周数（约一个学期）。 */
const DEFAULT_REPEAT_WEEKS = 20

/** 提前多少秒提醒（15 分钟）。 */
const ALARM_OFFSET_SECONDS = 15 * 60

export interface CalendarSyncResult {
  added: number
  failed: number
  firstError: string
}

/**
 * 下一次「该星期」的日期（含今天）。
 * 今天就是该星期、但课已经上完（按 endMinute 判断）时顺延到下周。
 */
function nextWeekdayDate(weekday: number, endMinute: number, now = new Date()): Date {
  const today = now.getDay() // 0=周日 … 6=周六
  const target = weekday % 7 // 本仓 weekday 1=周一 … 7=周日
  let delta = (target - today + 7) % 7
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  if (delta === 0 && nowMinute >= endMinute) {
    delta = 7
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta)
}

/** 把「某天的第 N 分钟」换算成 unix 秒。 */
function atMinute(date: Date, minute: number): number {
  const point = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
  point.setMinutes(minute)
  return Math.floor(point.getTime() / 1000)
}

/**
 * 从周次文本推算重复多少周。
 * 支持「1-16」「1~16」「3」「单周」「双周」；识别不出时回退默认值。
 */
function repeatWeeks(weeks: string): number {
  const value = String(weeks ?? '').trim()
  if (!value) {
    return DEFAULT_REPEAT_WEEKS
  }
  if (value === '单周' || value === '双周') {
    return DEFAULT_REPEAT_WEEKS
  }
  const range = /(\d{1,2})\s*[-~～—－至到]\s*(\d{1,2})/.exec(value)
  if (range) {
    return Math.max(1, Math.max(Number(range[1]), Number(range[2])))
  }
  const single = /(\d{1,2})/.exec(value)
  return single ? Math.max(1, Number(single[1])) : DEFAULT_REPEAT_WEEKS
}

function buildDescription(entry: TimetableEntry): string {
  const parts = ['来自 Synapse 课表']
  if (entry.teacher) {
    parts.push(entry.teacher)
  }
  if (entry.weeks) {
    parts.push(`${entry.weeks} 周`)
  }
  return parts.join(' · ')
}

/**
 * 把整张课表写进系统日历（每节课一条周重复事件）。
 * 逐个添加：微信会对每条事件弹一次确认框，用户取消的那条计入 failed。
 */
export async function syncTimetableToPhoneCalendar(
  entries: TimetableEntry[]
): Promise<CalendarSyncResult> {
  let added = 0
  let failed = 0
  let firstError = ''

  for (const entry of entries) {
    const anchor = nextWeekdayDate(entry.weekday, entry.endMinute)
    const startTime = atMinute(anchor, entry.startMinute)
    const endTime = atMinute(anchor, entry.endMinute)
    const weeks = repeatWeeks(entry.weeks)
    try {
      await Taro.addPhoneRepeatCalendar({
        title: entry.name,
        startTime,
        // Taro 的 endTime 类型标成了 string，微信实际要 unix 秒数，这里按运行时要求传数字
        endTime: endTime as unknown as string,
        location: entry.location || undefined,
        description: buildDescription(entry),
        alarm: true,
        alarmOffset: ALARM_OFFSET_SECONDS,
        repeatInterval: 'week',
        repeatEndTime: startTime + weeks * 7 * 86400
      })
      added += 1
    } catch (error) {
      failed += 1
      if (!firstError) {
        firstError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  return { added, failed, firstError }
}
