export const TASK_TYPE_LABELS: Record<string, string> = {
  learn: '学习',
  practice: '练习',
  review: '复盘',
  mock_exam: '小测'
}

export function taskTypeLabel(taskType: string): string {
  return TASK_TYPE_LABELS[taskType] ?? '学习'
}
