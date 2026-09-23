/** 展示用格式化工具。 */

export const TASK_TYPE_LABELS: Record<string, string> = {
  learn: '学习',
  practice: '练习',
  review: '复盘',
  mock_exam: '小测',
}

export function taskTypeLabel(taskType: string): string {
  return TASK_TYPE_LABELS[taskType] ?? '学习'
}

export const WEEKDAY_OPTIONS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_OPTIONS[weekday - 1] ?? `周${weekday}`
}

/** 分钟数（从 0 点起算）→ "HH:mm" */
export function minuteToClock(minute: number): string {
  const hour = Math.floor(minute / 60)
  const rest = minute % 60
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/** "HH:mm" → 分钟数（从 0 点起算） */
export function clockToMinute(clock: string): number {
  const matched = /^(\d{1,2}):(\d{2})$/.exec((clock || '').trim())
  if (!matched) {
    return 0
  }
  return Number(matched[1]) * 60 + Number(matched[2])
}

/** 计划里的分钟时长 → 更自然的展示（如 1 小时 30 分） */
export function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} 分钟`
  }
  const hour = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hour} 小时 ${rest} 分` : `${hour} 小时`
}

/** ISO 时间 → 相对时间描述 */
export function formatRelativeTime(iso: string): string {
  if (!iso) {
    return ''
  }
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) {
    return ''
  }
  const diff = Date.now() - timestamp
  if (diff < 60 * 1000) {
    return '刚刚'
  }
  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 1000))} 分钟前`
  }
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`
  }
  const date = new Date(timestamp)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}