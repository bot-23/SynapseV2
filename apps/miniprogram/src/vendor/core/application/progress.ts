/**
 * 进度服务（翻译自 Synapse/backend/app/application/progress.py，语义逐字保留）。
 */

import type { RuntimeStore } from "../storage/runtimeStore";

export class ProgressService {
  constructor(private readonly store: RuntimeStore) {}

  get_task_progress(userId: string): Record<string, boolean> {
    const normalizedUserId = this._build_user_id(userId);
    const rawProgress = this.store.get_progress(normalizedUserId);
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(rawProgress)) {
      if (value && typeof value === "object") {
        result[key] = Boolean(value.done);
      }
    }
    return result;
  }

  update_task_progress(args: {
    userId: string;
    taskKey: string;
    done: boolean;
    taskTitle?: string;
    taskType?: string;
    conversationId?: string;
    planId?: string;
    planVersion?: number | null;
    actualMinutes?: number;
    planMessage?: string;
  }): Record<string, boolean> {
    const normalizedUserId = this._build_user_id(args.userId);
    const rawProgress = this.store.update_progress(
      normalizedUserId,
      args.taskKey,
      args.done,
      args.taskTitle ?? "",
      args.taskType ?? "",
      args.conversationId ?? "",
      args.planId ?? "",
      args.actualMinutes ?? 0,
    );

    try {
      const profile = this.store.get_profile(normalizedUserId);
      const goal = String(profile["last_goal"] ?? "") || (args.planMessage ?? "");
      const subject = this._infer_subject(goal, normalizedUserId);
      const tasksInPlan = Math.max(1, Object.keys(rawProgress).length);
      const delta = (args.done ? 0.8 : -0.3) / tasksInPlan;
      const newAbility = this.store.update_ability(normalizedUserId, subject, delta);
      this.store.record_assessment(
        args.conversationId ?? "",
        subject,
        newAbility,
        "post_progress",
        args.planId || null,
        args.planVersion ?? null,
      );
    } catch {
      // 能力更新失败不影响进度返回
    }

    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(rawProgress)) {
      if (value && typeof value === "object") {
        result[key] = Boolean(value.done);
      }
    }
    return result;
  }

  private _infer_subject(goal: string, userId: string): string {
    let subject = "通用";
    for (const prefix of ["我要复习", "复习", "学习", "准备"]) {
      if (goal.includes(prefix)) {
        subject =
          goal
            .slice(goal.indexOf(prefix) + prefix.length)
            .replace(/^[。，. ]+|[。，. ]+$/g, "")
            .slice(0, 20) || "通用";
        break;
      }
    }
    if (subject !== "通用") {
      return subject;
    }

    const saved = this.store.get_plan(userId);
    if (saved && saved.weekly_plan.length) {
      const focus = String((saved.weekly_plan[0] as Record<string, unknown>)["focus"] ?? "");
      return (
        focus.split("入门")[0]!.split("专项")[0]!.split("综合")[0]!.trim() || "通用"
      );
    }
    return "通用";
  }

  private _build_user_id(name: string | null): string {
    void name;
    return "default";
  }
}
