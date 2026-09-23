/**
 * 作业式计划服务（v2）。
 *
 * 职责边界：
 * - 抽取：有模型 Key 走 `generateJson` 结构化抽取，没 Key 走规则解析（离线必须可用）。
 * - 排期：一律交给 `domain/assignment.ts` 的确定性算法，模型不参与「时间怎么摊」。
 * - 落库：`assignments:{userId}`，并回写打卡、逾期重排、复习卡 ID。
 */

import type {
  AssignmentItem,
  AssignmentSnapshot,
  ReviewItem,
  StudyPlanRequest,
  TimetableEntry,
} from "../protocol/study";
import {
  build_assignment_schedule,
  estimate_assignment_minutes,
  is_assignment_overdue,
  parse_assignment_due,
  parse_assignment_items,
  refresh_assignment_statuses,
  reschedule_overdue_items,
} from "../domain/assignment";
import { apply_timetable_to_payload } from "../domain/timetable";
import { create_review_item, review_key } from "../domain/review";
import { detect_subject_from_text } from "../domain/subjectInfer";
import { to_date } from "../domain/dateMath";
import type { Clock, IdGen } from "../ports/index";
import { systemClock, systemIdGen } from "../ports/index";
import type { LlmProvider } from "../providers/contracts";
import type { RuntimeStore } from "../storage/runtimeStore";
import { buildAssignmentPrompt } from "./prompts";

/** 没配模型 Key 时的每日默认预算（分钟）。 */
const DEFAULT_DAILY_MINUTES = 60;

export interface AssignmentIngestResult {
  items: AssignmentItem[];
  snapshot: AssignmentSnapshot;
  /** 抽取来源：llm / offline */
  extractor: string;
  /** 模型或规则没能解析成条目的部分，原样回显 */
  unparsed: string;
  /** 本次新增的条目数 */
  added: number;
  /** 认不出截止日的条数（已按今天兜底） */
  missing_due: number;
}

export class AssignmentService {
  constructor(
    private readonly store: RuntimeStore,
    private readonly llm: LlmProvider,
    private readonly clock: Clock = systemClock,
    private readonly idGen: IdGen = systemIdGen,
  ) {}

  today(): string {
    return to_date(this.clock.nowIso());
  }

  /**
   * 每日可用时长：画像里的偏好时长，再用课表占用校正。
   * 复用短期计划同一条避让逻辑（`apply_timetable_to_payload`），不另写一套。
   */
  daily_minutes(userId: string): number {
    const profile = this.store.get_profile(userId);
    const preferred = Math.trunc(Number(profile["preferred_daily_minutes"] ?? 0));
    const entries: TimetableEntry[] = this.store.get_timetable(userId);
    const request: StudyPlanRequest = {
      user_id: userId,
      current_level: String(profile["current_level"] ?? ""),
      learning_goal: "作业排期",
      available_days_per_week: 5,
      available_minutes_per_day: preferred > 0 ? preferred : DEFAULT_DAILY_MINUTES,
      deadline: null,
      weak_points: [],
      preferences: [],
      need_user_confirmation: false,
    };
    return Math.max(15, Math.trunc(apply_timetable_to_payload(request, entries).available_minutes_per_day));
  }

  /** 作业看板快照（壳侧只读渲染）。顺带把「今天视角」的状态写回存储。 */
  snapshot(userId: string): AssignmentSnapshot {
    const today = this.today();
    const stored = this.store.get_assignments(userId);
    const items = refresh_assignment_statuses(stored, today);
    const changed = items.some((item, index) => item.status !== stored[index]?.status);
    const persisted = changed ? this.store.save_assignments(userId, items) : items;
    const schedule = build_assignment_schedule({
      items: persisted,
      today,
      daily_minutes: this.daily_minutes(userId),
    });
    return {
      items: persisted,
      schedule,
      total: persisted.length,
      pending_count: persisted.filter((item) => item.status === "pending").length,
      done_count: persisted.filter((item) => item.status === "done").length,
      overdue_count: persisted.filter((item) => item.status === "overdue").length,
      generated_at: this.clock.nowIso(),
    };
  }

  /**
   * 把一段作业原话解析成条目并落库。
   * 模型优先、规则兜底：模型返回空或调用失败时不会让用户空手而归。
   */
  async ingest(args: {
    userId: string;
    text: string;
    context?: string[];
  }): Promise<AssignmentIngestResult> {
    const userId = args.userId || "default";
    const text = (args.text || "").trim();
    const today = this.today();
    const offline = parse_assignment_items(text, today);

    let drafts = offline.map((draft) => ({
      subject: draft.subject,
      title: draft.title,
      quantity: draft.quantity,
      unit: draft.unit,
      due_date: draft.due_date,
      estimated_minutes: draft.estimated_minutes,
      source_text: draft.source_text,
    }));
    let extractor = "offline";
    let unparsed = drafts.length ? "" : text;

    if (this.llm.describe()["provider"] === "deepseek" && text) {
      try {
        const raw = await this.llm.generateJson(
          buildAssignmentPrompt(today, text, args.context ?? []),
        );
        const extracted = this._coerce_llm_items(raw, today);
        if (extracted.items.length) {
          drafts = extracted.items;
          extractor = "llm";
          unparsed = extracted.unparsed;
        }
      } catch {
        // 模型调用失败：静默回落到规则解析结果，用户依然拿得到作业清单
      }
    }

    const existing = this.store.get_assignments(userId);
    const known = new Set(existing.map((item) => `${item.title}\u0000${item.due_date}`));
    const savedPlan = this.store.get_plan(userId);
    const created: AssignmentItem[] = [];
    let missingDue = 0;
    for (const draft of drafts) {
      const dueDate = draft.due_date || parse_assignment_due(draft.source_text || draft.title, today);
      if (!dueDate) {
        missingDue += 1;
      }
      const identity = `${draft.title}\u0000${dueDate || today}`;
      if (known.has(identity)) {
        continue;
      }
      known.add(identity);
      created.push({
        id: this.idGen.next(),
        subject: draft.subject,
        title: draft.title,
        quantity: Math.max(0, Math.trunc(draft.quantity)),
        unit: draft.unit,
        due_date: dueDate || today,
        estimated_minutes:
          draft.estimated_minutes > 0
            ? Math.trunc(draft.estimated_minutes)
            : estimate_assignment_minutes(draft.quantity, draft.unit),
        status: "pending",
        done_at: "",
        created_at: today,
        source_text: draft.source_text || text,
        review_card_ids: [],
        plan_id: "",
        plan_version: savedPlan ? (savedPlan.version ?? null) : null,
        original_due_date: "",
        rescheduled_at: "",
      });
    }

    if (created.length) {
      this.store.save_assignments(userId, [...existing, ...created]);
    }
    return {
      items: created,
      snapshot: this.snapshot(userId),
      extractor,
      unparsed,
      added: created.length,
      missing_due: missingDue,
    };
  }

  /** 打卡：done 时顺手把这条作业推进复习队列（复用资料→图谱→复习的同一条链路）。 */
  complete(
    userId: string,
    assignmentId: string,
    done: boolean,
  ): { snapshot: AssignmentSnapshot; item: AssignmentItem | null; review_added: number } {
    const uid = userId || "default";
    const today = this.today();
    const items = refresh_assignment_statuses(this.store.get_assignments(uid), today);
    const target = items.find((item) => item.id === assignmentId);
    if (!target) {
      return { snapshot: this.snapshot(uid), item: null, review_added: 0 };
    }
    let reviewAdded = 0;
    let reviewCardIds = target.review_card_ids;
    if (done) {
      const result = this._enqueue_review(uid, target.subject, target.title);
      reviewAdded = result.added;
      reviewCardIds = [...target.review_card_ids, ...result.ids];
    }
    const updated: AssignmentItem = {
      ...target,
      status: done ? "done" : is_assignment_overdue(target, today) ? "overdue" : "pending",
      done_at: done ? today : "",
      review_card_ids: reviewCardIds,
    };
    this.store.save_assignments(
      uid,
      items.map((item) => (item.id === assignmentId ? updated : item)),
    );
    return { snapshot: this.snapshot(uid), item: updated, review_added: reviewAdded };
  }

  /** 逾期重排：把剩余工作量挪到后续几天，返回被重排的条数。 */
  reschedule(userId: string): { snapshot: AssignmentSnapshot; moved: number } {
    const uid = userId || "default";
    const today = this.today();
    const items = refresh_assignment_statuses(this.store.get_assignments(uid), today);
    const next = reschedule_overdue_items(items, today, this.daily_minutes(uid));
    const moved = next.filter(
      (item, index) => item.due_date !== items[index]?.due_date,
    ).length;
    if (moved) {
      this.store.save_assignments(uid, next);
    }
    return { snapshot: this.snapshot(uid), moved };
  }

  /** 模型返回的条目做形状校验；日期非法时用规则解析器补，实在解析不出交给今天兜底。 */
  private _coerce_llm_items(
    raw: Record<string, unknown>,
    today: string,
  ): {
    items: Array<{
      subject: string;
      title: string;
      quantity: number;
      unit: string;
      due_date: string;
      estimated_minutes: number;
      source_text: string;
    }>;
    unparsed: string;
  } {
    const list = Array.isArray(raw["items"]) ? (raw["items"] as unknown[]) : [];
    const items: Array<{
      subject: string;
      title: string;
      quantity: number;
      unit: string;
      due_date: string;
      estimated_minutes: number;
      source_text: string;
    }> = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const row = entry as Record<string, unknown>;
      const title = String(row["title"] ?? "").trim();
      if (!title) {
        continue;
      }
      const quantity = Math.max(0, Math.trunc(Number(row["quantity"] ?? 0)));
      const unit = String(row["unit"] ?? "").trim();
      const sourceText = String(row["source_text"] ?? "").trim() || title;
      const rawDue = String(row["due_date"] ?? "").trim();
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDue)
        ? rawDue
        : parse_assignment_due(rawDue || sourceText, today) || "";
      const minutes = Math.trunc(Number(row["estimated_minutes"] ?? 0));
      items.push({
        subject: String(row["subject"] ?? "").trim() || detect_subject_from_text(`${title}${sourceText}`),
        title,
        quantity,
        unit,
        due_date: dueDate || today,
        estimated_minutes: minutes > 0 ? minutes : estimate_assignment_minutes(quantity, unit),
        source_text: sourceText,
      });
    }
    return { items, unparsed: String(raw["unparsed"] ?? "").trim() };
  }

  /** 把作业推进复习队列；同 subject::topic 已在队列里就不重复加。 */
  private _enqueue_review(userId: string, subject: string, topic: string): {
    added: number;
    ids: string[];
  } {
    const title = (topic || "").trim();
    if (!title) {
      return { added: 0, ids: [] };
    }
    const reviews = this.store.get_reviews(userId);
    const key = review_key(subject, title);
    if (reviews.some((item) => item.key === key)) {
      return { added: 0, ids: [] };
    }
    const item: ReviewItem = create_review_item({
      id: this.idGen.next(),
      subject,
      topic: title,
      today: this.today(),
    });
    this.store.save_reviews(userId, [...reviews, item]);
    return { added: 1, ids: [item.id] };
  }
}
