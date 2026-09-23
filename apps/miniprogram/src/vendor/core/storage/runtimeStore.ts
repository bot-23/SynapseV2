/**
 * RuntimeStore：仓储接口的 KV 实现（翻译自 Synapse/db/store.py + repositories/*）。
 * 语义与 SQL 版逐条对齐；键空间分桶见 kv.ts 头注。
 */

import type { Clock } from "../ports/index";
import { systemClock } from "../ports/index";
import type {
  ConfirmedSubject,
  LongTermPlan,
  PlanVersionRecord,
  ReviewItem,
  SavedPlanMeta,
  TimetableEntry,
  TodayPlan,
} from "../protocol/study";
import type { KvStore } from "./kv";
import { SEED_KG_EDGES, SEED_KG_NODES, type KnowledgeEdge, type KnowledgeNode } from "./kgSeed";

/** 计划历史版本最多保留多少版（防止 KV 无限膨胀）。 */
const MAX_PLAN_VERSIONS = 30;

export interface ConversationRecord {
  id: string;
  user_id?: string;
  subject: string;
  title: string;
  planning_mode: string;
  session_state_json: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  role: string;
  content: string;
  attachments_json: string | null;
  plan_data_json: string | null;
  request_context_json: string | null;
  response_mode: string | null;
  reason: string | null;
  next_steps_json: string | null;
  plan_confirmed: boolean;
  expanded_to_week: boolean;
  created_at: string;
}

export interface ProgressRecord {
  done: boolean;
  conversation_id: string;
  plan_id: string;
  task_title: string;
  task_type: string;
  actual_minutes: number;
  attempts: number;
  completion_count: number;
  skip_count: number;
  updated_at: string;
}

export interface SavedPlanRecord {
  message: string;
  weekly_plan: Record<string, unknown>[];
  block_plan: Record<string, unknown> | null;
  /** 版本号（v2 新增）：每次保存自增，供界面显示「第 N 版」 */
  version: number;
  updated_at: string;
  change_summary: string;
  /**
   * 计划第 1 天对应的日期（v2 新增，YYYY-MM-DD）。
   * 中途追加科目时用它判断「哪些天已经过去」——已过去的天不再补新科目。
   */
  start_date: string;
}

export interface AssessmentRecord {
  conversation_id: string;
  subject: string;
  plan_id: string | null;
  plan_version: number | null;
  abilities_snapshot_json: string;
  trigger: string;
  user_id: string;
  created_at: string;
}

const KEY_PROFILE = "profile";
const KEY_CONVERSATIONS = "conversations";
const KEY_KG_NODES = "kg:nodes";
const KEY_KG_EDGES = "kg:edges";

function dedupeText(items: unknown[], limit = 12): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const text = String(item ?? "").trim();
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function jsonObj(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class RuntimeStore {
  constructor(
    private readonly kv: KvStore,
    private readonly clock: Clock = systemClock,
  ) {}

  private now(): string {
    return this.clock.nowIso();
  }

  private readJson<T>(key: string, fallback: T): T {
    const value = this.kv.get(key);
    return value === undefined || value === null ? fallback : (value as T);
  }

  // ------------------------------------------------------------------
  // 画像 / API Key / 能力
  // ------------------------------------------------------------------

  private readProfileRow(userId: string): Record<string, unknown> {
    const all = this.readJson<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    return all[userId] ?? { user_id: userId };
  }

  private writeProfileRow(userId: string, row: Record<string, unknown>): void {
    const all = this.readJson<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    all[userId] = row;
    this.kv.set(KEY_PROFILE, all);
  }

  private profileMemory(abilitiesJson: unknown): Record<string, unknown> {
    const abilities = jsonObj(abilitiesJson);
    const memory = abilities["__profile__"];
    return memory && typeof memory === "object" && !Array.isArray(memory)
      ? (memory as Record<string, unknown>)
      : {};
  }

  get_profile(userId: string): Record<string, unknown> {
    const all = this.readJson<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    if (!(userId in all)) {
      return {};
    }
    const obj = this.readProfileRow(userId);
    const memory = this.profileMemory(obj["abilities_json"]);
    return {
      user_id: userId,
      display_name: obj["display_name"] ?? "",
      current_level: obj["grade"] ?? "未填写",
      grade: obj["grade"] ?? "未填写",
      last_goal: obj["last_goal"] ?? "",
      mood: obj["mood"] ?? null,
      abilities_json: obj["abilities_json"] ?? "{}",
      weak_points: dedupeText((memory["weak_points"] as unknown[]) ?? []),
      preferred_daily_minutes: obj["preferred_daily_minutes"] ?? null,
      preferred_days_per_week: obj["preferred_days_per_week"] ?? null,
      preferred_pacing: obj["preferred_pacing"] ?? null,
      constraint_note: obj["constraint_note"] ?? null,
      focus_preference: obj["focus_preference"] ?? null,
      last_deadline: obj["last_deadline"] ?? null,
      updated_at: obj["updated_at"] ?? "",
    };
  }

  save_profile(userId: string, profile: Record<string, unknown>): Record<string, unknown> {
    const obj = this.readProfileRow(userId);

    let rawWeakPoints = (profile["weak_points"] as unknown) ?? [];
    let rawWeakSubjects = (profile["weak_subjects"] as unknown) ?? [];
    if (typeof rawWeakPoints === "string") {
      rawWeakPoints = [rawWeakPoints];
    }
    if (typeof rawWeakSubjects === "string") {
      rawWeakSubjects = [rawWeakSubjects];
    }
    const weakPoints = dedupeText([
      ...(rawWeakPoints as unknown[]),
      ...(rawWeakSubjects as unknown[]),
    ]);

    for (const fieldName of [
      "display_name",
      "grade",
      "current_level",
      "last_goal",
      "mood",
      "abilities_json",
      "preferred_daily_minutes",
      "preferred_days_per_week",
      "preferred_pacing",
      "focus_preference",
      "constraint_note",
      "last_deadline",
    ]) {
      if (fieldName in profile) {
        if (fieldName === "current_level") {
          obj["grade"] = profile[fieldName];
        } else {
          obj[fieldName] = profile[fieldName];
        }
      }
    }

    if (weakPoints.length) {
      const abilities = jsonObj(obj["abilities_json"]);
      let memory = abilities["__profile__"];
      if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
        memory = {};
      }
      const memoryDict = memory as Record<string, unknown>;
      memoryDict["weak_points"] = dedupeText([
        ...((memoryDict["weak_points"] as unknown[]) ?? []),
        ...weakPoints,
      ]);
      memoryDict["updated_at"] = this.now();
      abilities["__profile__"] = memoryDict;
      obj["abilities_json"] = JSON.stringify(abilities);
    }

    obj["updated_at"] = this.now();
    this.writeProfileRow(userId, obj);
    return this.get_profile(userId);
  }

  get_api_key(userId = "default"): string | null {
    const all = this.readJson<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    if (!(userId in all)) {
      return null;
    }
    return (this.readProfileRow(userId)["api_key"] as string) ?? null;
  }

  save_api_key(userId: string, apiKey: string): void {
    const obj = this.readProfileRow(userId);
    obj["api_key"] = apiKey;
    obj["updated_at"] = this.now();
    this.writeProfileRow(userId, obj);
  }

  get_ability(userId: string, subject: string): Record<string, unknown> {
    const all = this.readJson<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    const abilities = jsonObj(
      userId in all ? this.readProfileRow(userId)["abilities_json"] : "{}",
    );
    const current = abilities[subject];
    if (current && typeof current === "object") {
      return current as Record<string, unknown>;
    }
    return { level: 1, weak_points: [], strengths: [], skill_score: 1.0 };
  }

  update_ability(userId: string, subject: string, delta: number): Record<string, unknown> {
    const obj = this.readProfileRow(userId);
    const abilities = jsonObj(obj["abilities_json"]);
    const current = (abilities[subject] as Record<string, unknown>) ?? {
      level: 1,
      weak_points: [],
      strengths: [],
      skill_score: 1.0,
    };

    current["skill_score"] = Math.max(0.5, ((current["skill_score"] as number) ?? 1.0) + delta);
    const score = current["skill_score"] as number;
    if (score <= 1.5) {
      current["level"] = 1;
    } else if (score <= 2.5) {
      current["level"] = 2;
    } else if (score <= 3.5) {
      current["level"] = 3;
    } else if (score <= 4.5) {
      current["level"] = 4;
    } else {
      current["level"] = 5;
    }
    current["updated_at"] = this.now();

    abilities[subject] = current;
    obj["abilities_json"] = JSON.stringify(abilities);
    obj["updated_at"] = this.now();
    this.writeProfileRow(userId, obj);
    return current;
  }

  record_assessment(
    conversationId: string,
    subject: string,
    abilitiesSnapshot: Record<string, unknown>,
    trigger = "manual",
    planId: string | null = null,
    planVersion: number | null = null,
  ): void {
    const key = "assessments:default";
    const rows = this.readJson<AssessmentRecord[]>(key, []);
    rows.push({
      conversation_id: conversationId,
      subject,
      plan_id: planId,
      plan_version: planVersion,
      abilities_snapshot_json: JSON.stringify(abilitiesSnapshot),
      trigger,
      user_id: "default",
      created_at: this.now(),
    });
    this.kv.set(key, rows);
  }

  // ------------------------------------------------------------------
  // 待确认会话（一次性消费）
  // ------------------------------------------------------------------

  save_session(sessionId: string, payload: Record<string, unknown>): void {
    const sessions = this.readJson<Record<string, unknown>>("clarifications", {});
    sessions[sessionId] = {
      user_id: "default",
      normalized_payload: payload["normalized_payload"] ?? {},
      request_echo: payload["request_echo"] ?? {},
      memories: payload["memories"] ?? [],
      planning_mode: String(payload["planning_mode"] ?? "free"),
      created_at: this.now(),
    };
    this.kv.set("clarifications", sessions);
  }

  pop_session(sessionId: string): Record<string, unknown> | null {
    const sessions = this.readJson<Record<string, Record<string, unknown>>>("clarifications", {});
    const obj = sessions[sessionId];
    if (!obj) {
      return null;
    }
    delete sessions[sessionId];
    this.kv.set("clarifications", sessions);
    return {
      normalized_payload: obj["normalized_payload"] ?? {},
      request_echo: obj["request_echo"] ?? {},
      memories: obj["memories"] ?? [],
      planning_mode: obj["planning_mode"] ?? "free",
    };
  }

  // ------------------------------------------------------------------
  // 计划
  // ------------------------------------------------------------------

  save_plan(
    userId: string,
    message = "",
    weeklyPlan: Record<string, unknown>[] | null = null,
    blockPlan: Record<string, unknown> | null = null,
    changeSummary = "",
    startDateOverride = "",
  ): SavedPlanMeta {
    const previous = this.readJson<{ version?: number; start_date?: string } | null>(
      `plans:${userId}`,
      null,
    );
    const version = Math.max(0, Math.trunc(previous?.version ?? 0)) + 1;
    const updatedAt = this.now();
    const plan: Record<string, unknown> = {
      message,
      weekly_plan: weeklyPlan ?? [],
      block_plan: blockPlan ?? null,
      version,
      change_summary: changeSummary,
      updated_at: updatedAt,
      start_date: startDateOverride || this._resolve_start_date(previous?.start_date),
    };
    this.kv.set(`plans:${userId}`, plan);

    // v2：每一版都留档，用户执行完一版后想调整时可以回看/回到某一版
    this._append_plan_version(userId, {
      version,
      updated_at: updatedAt,
      change_summary: changeSummary,
      message,
      weekly_plan: weeklyPlan ?? [],
    });
    return { version, updated_at: updatedAt, change_summary: changeSummary };
  }

  get_plan(userId: string): SavedPlanRecord | null {
    const obj = this.readJson<
      (SavedPlanRecord & Partial<SavedPlanMeta>) | null
    >(`plans:${userId}`, null);
    if (!obj || !obj.message) {
      return null;
    }
    return {
      message: obj.message,
      weekly_plan: obj.weekly_plan ?? [],
      block_plan: obj.block_plan ?? null,
      version: Math.max(0, Math.trunc(obj.version ?? 0)),
      updated_at: obj.updated_at ?? "",
      change_summary: obj.change_summary ?? "",
      start_date: obj.start_date ?? "",
    };
  }

  /**
   * 计划起点日期：首版设为今天；一期（7 天）结束后自动开启新一期。
   * 否则老计划会一直沿用旧起点，导致「所有天都是过去」，追加科目无处可插。
   */
  private _resolve_start_date(previous?: string): string {
    const today = this.now().slice(0, 10);
    if (!previous) {
      return today;
    }
    const previousTime = Date.parse(`${previous}T00:00:00Z`);
    const todayTime = Date.parse(`${today}T00:00:00Z`);
    if (!Number.isFinite(previousTime) || !Number.isFinite(todayTime)) {
      return today;
    }
    const elapsedDays = Math.floor((todayTime - previousTime) / 86400000);
    return elapsedDays >= 7 ? today : previous;
  }

  // ------------------------------------------------------------------
  // 计划历史版本（v2）
  // ------------------------------------------------------------------

  /** 按时间正序返回，最新一版在最后。 */
  get_plan_versions(userId: string): PlanVersionRecord[] {
    const rows = this.readJson<PlanVersionRecord[]>(`plan_versions:${userId}`, []);
    return Array.isArray(rows) ? rows : [];
  }

  private _append_plan_version(userId: string, record: PlanVersionRecord): void {
    const history = this.get_plan_versions(userId);
    history.push(record);
    // 只留最近若干版，避免 KV 无限膨胀
    this.kv.set(`plan_versions:${userId}`, history.slice(-MAX_PLAN_VERSIONS));
  }

  // ------------------------------------------------------------------
  // 已确认科目（v2）：记在用户身上、跨对话保留
  // ------------------------------------------------------------------

  get_subjects(userId: string): ConfirmedSubject[] {
    const rows = this.readJson<ConfirmedSubject[]>(`subjects:${userId}`, []);
    return Array.isArray(rows) ? rows : [];
  }

  save_subjects(userId: string, subjects: ConfirmedSubject[]): ConfirmedSubject[] {
    this.kv.set(`subjects:${userId}`, subjects);
    return this.get_subjects(userId);
  }

  /** 并入一个科目（已存在则忽略），返回是否新增。 */
  add_subject(userId: string, name: string, source: string): boolean {
    const trimmed = (name || "").trim();
    if (!trimmed) {
      return false;
    }
    const subjects = this.get_subjects(userId);
    if (subjects.some((item) => item.name === trimmed)) {
      return false;
    }
    subjects.push({ name: trimmed, source, created_at: this.now() });
    this.save_subjects(userId, subjects);
    return true;
  }

  remove_subject(userId: string, name: string): ConfirmedSubject[] {
    return this.save_subjects(
      userId,
      this.get_subjects(userId).filter((item) => item.name !== name),
    );
  }

  // ------------------------------------------------------------------
  // 长期计划 / 今日计划（v2 三层计划）
  // ------------------------------------------------------------------

  get_long_plan(userId: string): LongTermPlan | null {
    const obj = this.readJson<LongTermPlan | null>(`long_plan:${userId}`, null);
    if (!obj || !Array.isArray(obj.milestones) || !obj.milestones.length) {
      return null;
    }
    return {
      goal: obj.goal ?? "",
      deadline: obj.deadline ?? null,
      subjects: Array.isArray(obj.subjects) ? obj.subjects : [],
      milestones: obj.milestones,
      updated_at: obj.updated_at ?? "",
      version: Math.max(0, Math.trunc(obj.version ?? 0)),
    };
  }

  save_long_plan(
    userId: string,
    plan: Omit<LongTermPlan, "version" | "updated_at">,
  ): LongTermPlan {
    const previous = this.get_long_plan(userId);
    const record: LongTermPlan = {
      ...plan,
      version: (previous?.version ?? 0) + 1,
      updated_at: this.now(),
    };
    this.kv.set(`long_plan:${userId}`, record);
    return record;
  }

  get_today(userId: string): TodayPlan | null {
    const obj = this.readJson<TodayPlan | null>(`today:${userId}`, null);
    if (!obj || !obj.date) {
      return null;
    }
    return {
      date: obj.date,
      items: Array.isArray(obj.items) ? obj.items : [],
      day_index: Math.max(0, Math.trunc(obj.day_index ?? 0)),
      // 旧记录没有这个字段：给 0 会让它和当前计划版本对不上，从而自动重建
      plan_version: Math.max(0, Math.trunc(obj.plan_version ?? 0)),
      updated_at: obj.updated_at ?? "",
    };
  }

  save_today(userId: string, record: Omit<TodayPlan, "updated_at">): TodayPlan {
    const saved: TodayPlan = { ...record, updated_at: this.now() };
    this.kv.set(`today:${userId}`, saved);
    return saved;
  }

  // ------------------------------------------------------------------
  // 复习队列（v2 间隔重复）
  // ------------------------------------------------------------------

  get_reviews(userId: string): ReviewItem[] {
    const rows = this.readJson<ReviewItem[]>(`review:${userId}`, []);
    return Array.isArray(rows) ? rows : [];
  }

  save_reviews(userId: string, items: ReviewItem[]): ReviewItem[] {
    this.kv.set(`review:${userId}`, items);
    return this.get_reviews(userId);
  }

  // ------------------------------------------------------------------
  // 课程表（v2）
  // ------------------------------------------------------------------

  get_timetable(userId: string): TimetableEntry[] {
    const rows = this.readJson<TimetableEntry[]>(`timetable:${userId}`, []);
    return Array.isArray(rows) ? rows : [];
  }

  save_timetable(userId: string, entries: TimetableEntry[]): TimetableEntry[] {
    this.kv.set(`timetable:${userId}`, entries);
    return this.get_timetable(userId);
  }

  // ------------------------------------------------------------------
  // 进度
  // ------------------------------------------------------------------

  get_progress(userId: string, conversationId = "", planId = ""): Record<string, ProgressRecord> {
    const all = this.readJson<Record<string, ProgressRecord>>(`progress:${userId}`, {});
    const result: Record<string, ProgressRecord> = {};
    for (const [taskKey, record] of Object.entries(all)) {
      if (conversationId && record.conversation_id !== conversationId) {
        continue;
      }
      if (planId && record.plan_id !== planId) {
        continue;
      }
      result[taskKey] = record;
    }
    return result;
  }

  update_progress(
    userId: string,
    taskKey: string,
    done: boolean,
    taskTitle = "",
    taskType = "",
    conversationId = "",
    planId = "",
    actualMinutes = 0,
  ): Record<string, ProgressRecord> {
    const key = `progress:${userId}`;
    const all = this.readJson<Record<string, ProgressRecord>>(key, {});
    let row = all[taskKey];
    if (row && conversationId && row.conversation_id !== conversationId) {
      row = undefined;
    }
    if (row && planId && row.plan_id !== planId) {
      row = undefined;
    }

    if (!row) {
      all[taskKey] = {
        done,
        conversation_id: conversationId,
        plan_id: planId,
        task_title: taskTitle,
        task_type: taskType,
        actual_minutes: Math.max(0, Math.trunc(actualMinutes || 0)),
        attempts: 1,
        completion_count: done ? 1 : 0,
        skip_count: done ? 0 : 1,
        updated_at: this.now(),
      };
    } else {
      row.done = done;
      row.task_title = taskTitle || row.task_title;
      row.task_type = taskType || row.task_type;
      if (conversationId && !row.conversation_id) {
        row.conversation_id = conversationId;
      }
      if (planId && !row.plan_id) {
        row.plan_id = planId;
      }
      if (actualMinutes) {
        row.actual_minutes = Math.max(0, Math.trunc(actualMinutes));
      }
      row.attempts += 1;
      if (done) {
        row.completion_count += 1;
      } else {
        row.skip_count += 1;
      }
      row.updated_at = this.now();
    }

    this.kv.set(key, all);
    return this.get_progress(userId, conversationId, planId);
  }

  // ------------------------------------------------------------------
  // 资料
  // ------------------------------------------------------------------

  get_documents(userId: string): Record<string, unknown>[] {
    const rows = this.readJson<Array<Record<string, unknown>>>(`documents:${userId}`, []);
    return rows
      .map((row) => ({
        doc_id: row["doc_id"],
        user_id: row["user_id"],
        file_name: row["file_name"],
        excerpt: row["excerpt"],
        chunks: row["chunks"] ?? [],
        updated_at: row["updated_at"] ?? "",
      }))
      .sort((a, b) => {
        const ua = String(a["updated_at"]);
        const ub = String(b["updated_at"]);
        return ua < ub ? 1 : ua > ub ? -1 : 0;
      })
      .map(({ updated_at: _updatedAt, ...row }) => row);
  }

  save_documents(
    userId: string,
    newDocuments: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const key = `documents:${userId}`;
    if (!newDocuments.length) {
      return this.get_documents(userId);
    }
    // 写前复制，避免 KV set 因容量等原因失败时污染存储中原对象。
    const rows = this.readJson<Array<Record<string, unknown>>>(key, []).map((row) => ({
      ...row,
    }));
    for (const doc of newDocuments) {
      const docId = String(doc["doc_id"] || doc["file_name"] || "").trim();
      if (!docId) {
        continue;
      }
      let existing = rows.find((row) => row["doc_id"] === docId);
      if (!existing) {
        existing = { doc_id: docId, user_id: userId };
        rows.push(existing);
      }
      existing["file_name"] = String(doc["file_name"] || "未命名资料").slice(0, 512);
      existing["excerpt"] = String(doc["excerpt"] || "").slice(0, 4096);
      existing["chunks"] = doc["chunks"] ?? [];
      existing["updated_at"] = this.now();
    }
    this.kv.set(key, rows);
    return this.get_documents(userId);
  }

  /** 删除一份资料（save_documents 是 upsert 语义，删除需要单独走这里）。 */
  delete_document(userId: string, docId: string): Record<string, unknown>[] {
    const key = `documents:${userId}`;
    const rows = this.readJson<Array<Record<string, unknown>>>(key, []);
    this.kv.set(
      key,
      rows.filter((row) => String(row["doc_id"] ?? "") !== docId),
    );
    return this.get_documents(userId);
  }

  // ------------------------------------------------------------------
  // 会话 / 消息
  // ------------------------------------------------------------------

  list_conversations(userId = "default"): ConversationRecord[] {
    const rows = this.readJson<ConversationRecord[]>(KEY_CONVERSATIONS, []);
    return rows
      .filter((row) => (row.user_id ?? "default") === userId)
      .map((row) => ({
        id: row.id,
        subject: row.subject,
        title: row.title,
        planning_mode: row.planning_mode,
        session_state_json: row.session_state_json,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  }

  save_conversation(
    conversationId: string,
    userId = "default",
    title = "新对话",
    subject = "通用",
    planningMode = "free",
    sessionStateJson = "",
  ): void {
    const rows = this.readJson<ConversationRecord[]>(KEY_CONVERSATIONS, []);
    let obj = rows.find((row) => row.id === conversationId);
    if (!obj) {
      obj = {
        id: conversationId,
        user_id: userId,
        subject,
        title,
        planning_mode: planningMode,
        session_state_json: '{"phase":"idle"}',
        created_at: this.now(),
        updated_at: "",
      };
      rows.push(obj);
    }
    obj.title = title;
    obj.subject = subject;
    obj.planning_mode = planningMode;
    if (sessionStateJson) {
      obj.session_state_json = sessionStateJson;
    }
    obj.updated_at = this.now();
    this.kv.set(KEY_CONVERSATIONS, rows);
  }

  delete_conversation(conversationId: string): void {
    this.kv.delete(`messages:${conversationId}`);
    const conversations = this.readJson<ConversationRecord[]>(KEY_CONVERSATIONS, []);
    this.kv.set(
      KEY_CONVERSATIONS,
      conversations.filter((row) => row.id !== conversationId),
    );
    // 进度记录按会话过滤删除
    const progressKey = "progress:default";
    const progress = this.readJson<Record<string, ProgressRecord>>(progressKey, {});
    const kept = Object.fromEntries(
      Object.entries(progress).filter(([, record]) => record.conversation_id !== conversationId),
    );
    this.kv.set(progressKey, kept);
    // 评估记录按会话过滤删除
    const assessmentKey = "assessments:default";
    const assessments = this.readJson<AssessmentRecord[]>(assessmentKey, []);
    this.kv.set(
      assessmentKey,
      assessments.filter((row) => row.conversation_id !== conversationId),
    );
  }

  get_messages(conversationId: string): MessageRecord[] {
    return this.readJson<MessageRecord[]>(`messages:${conversationId}`, []);
  }

  save_message(
    messageId: string,
    conversationId: string,
    role: string,
    content = "",
    kwargs: Partial<Omit<MessageRecord, "id" | "role" | "content" | "created_at">> = {},
  ): void {
    const key = `messages:${conversationId}`;
    const rows = this.readJson<MessageRecord[]>(key, []);
    let obj = rows.find((row) => row.id === messageId);
    if (!obj) {
      obj = {
        id: messageId,
        role,
        content: "",
        attachments_json: null,
        plan_data_json: null,
        request_context_json: null,
        response_mode: null,
        reason: null,
        next_steps_json: null,
        plan_confirmed: false,
        expanded_to_week: false,
        created_at: this.now(),
      };
      rows.push(obj);
    }
    obj.content = content;
    obj.attachments_json = kwargs.attachments_json ?? null;
    obj.plan_data_json = kwargs.plan_data_json ?? null;
    obj.request_context_json = kwargs.request_context_json ?? null;
    obj.response_mode = kwargs.response_mode ?? null;
    obj.reason = kwargs.reason ?? null;
    obj.next_steps_json = kwargs.next_steps_json ?? null;
    obj.plan_confirmed = Boolean(kwargs.plan_confirmed);
    obj.expanded_to_week = Boolean(kwargs.expanded_to_week);
    this.kv.set(key, rows);
  }

  // ------------------------------------------------------------------
  // 知识图谱
  // ------------------------------------------------------------------

  ensureKgSeeded(): void {
    const nodes = this.kv.get(KEY_KG_NODES);
    if (Array.isArray(nodes) && nodes.length > 0) {
      return;
    }
    this.kv.set(KEY_KG_NODES, SEED_KG_NODES);
    this.kv.set(KEY_KG_EDGES, SEED_KG_EDGES);
  }

  kgNodes(): KnowledgeNode[] {
    this.ensureKgSeeded();
    return this.readJson<KnowledgeNode[]>(KEY_KG_NODES, []);
  }

  kgEdges(): KnowledgeEdge[] {
    this.ensureKgSeeded();
    return this.readJson<KnowledgeEdge[]>(KEY_KG_EDGES, []);
  }

  /** 按 id 去重追加图谱节点，返回实际新增数量。 */
  addKgNodes(nodes: KnowledgeNode[]): number {
    const current = this.kgNodes();
    const ids = new Set(current.map((node) => node.id));
    const additions = nodes.filter((node) => node.id && !ids.has(node.id));
    if (!additions.length) {
      return 0;
    }
    this.kv.set(KEY_KG_NODES, [...current, ...additions]);
    return additions.length;
  }

  /** 按 source/target/relation 三元组去重追加图谱边，返回实际新增数量。 */
  addKgEdges(edges: KnowledgeEdge[]): number {
    const current = this.kgEdges();
    const edgeKey = (edge: KnowledgeEdge) =>
      `${edge.source_id}\u0000${edge.target_id}\u0000${edge.relation}`;
    const keys = new Set(current.map(edgeKey));
    const additions: KnowledgeEdge[] = [];
    for (const edge of edges) {
      const key = edgeKey(edge);
      if (!edge.source_id || !edge.target_id || !edge.relation || keys.has(key)) {
        continue;
      }
      keys.add(key);
      additions.push(edge);
    }
    if (!additions.length) {
      return 0;
    }
    this.kv.set(KEY_KG_EDGES, [...current, ...additions]);
    return additions.length;
  }

  // ------------------------------------------------------------------
  // 清空
  // ------------------------------------------------------------------

  delete_all_user_data(userId = "default"): void {
    const conversations = this.readJson<ConversationRecord[]>(KEY_CONVERSATIONS, []);
    const mine = conversations.filter((row) => (row.user_id ?? "default") === userId);
    for (const conversation of mine) {
      this.kv.delete(`messages:${conversation.id}`);
    }
    this.kv.set(
      KEY_CONVERSATIONS,
      conversations.filter((row) => (row.user_id ?? "default") !== userId),
    );
    this.kv.delete(`progress:${userId}`);
    this.kv.delete(`plans:${userId}`);
    this.kv.delete(`plan_versions:${userId}`);
    this.kv.delete(`subjects:${userId}`);
    this.kv.delete(`long_plan:${userId}`);
    this.kv.delete(`today:${userId}`);
    this.kv.delete(`review:${userId}`);
    this.kv.delete(`documents:${userId}`);
    // 当前产品是单本地用户；清空用户数据时移除资料生成的图谱，只保留内置知识。
    this.kv.set(KEY_KG_NODES, SEED_KG_NODES);
    this.kv.set(KEY_KG_EDGES, SEED_KG_EDGES);
    this.kv.delete(`timetable:${userId}`);
    this.kv.delete("clarifications");
    this.kv.delete("assessments:default");
    const profiles = this.readJson<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    delete profiles[userId];
    this.kv.set(KEY_PROFILE, profiles);
  }
}
