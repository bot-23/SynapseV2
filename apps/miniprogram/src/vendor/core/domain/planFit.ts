/**
 * 计划时长拟合（纯函数）。
 * 从 workflow 的 _fit_tasks_to_minutes 提取到 domain，供多科目合并与微调共用同一实现。
 */

import type { StudyTask } from "../protocol/study";
import { pyRound } from "./pyCompat";

/** Python round()：银行家舍入（half-to-even）。 */
export function fit_tasks_to_minutes(tasks: StudyTask[], targetMinutes: number): StudyTask[] {
  if (!tasks.length) {
    return [];
  }
  const total = tasks.reduce((sum, task) => sum + task.duration_minutes, 0);
  if (total <= targetMinutes) {
    return tasks;
  }

  const scale = targetMinutes / Math.max(1, total);
  const fitted: StudyTask[] = tasks.map((task) => ({
    ...task,
    duration_minutes: Math.max(10, pyRound((task.duration_minutes * scale) / 5) * 5),
  }));

  while (fitted.reduce((sum, task) => sum + task.duration_minutes, 0) > targetMinutes) {
    const reducible: Array<[number, number]> = [];
    fitted.forEach((task, index) => {
      if (task.duration_minutes > 10) {
        reducible.push([index, task.duration_minutes]);
      }
    });
    if (reducible.length) {
      // Python max()：并列时取第一个
      let maxIndex = reducible[0]![0];
      let maxValue = reducible[0]![1];
      for (const [index, value] of reducible) {
        if (value > maxValue) {
          maxValue = value;
          maxIndex = index;
        }
      }
      fitted[maxIndex]!.duration_minutes = Math.max(10, fitted[maxIndex]!.duration_minutes - 5);
      continue;
    }
    if (fitted.length <= 1) {
      break;
    }
    fitted.pop();
  }

  return fitted;
}
