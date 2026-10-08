/**
 * RuntimeStore：仓储接口的 KV 实现（翻译自 Synapse/db/store.py + repositories/*）。
 * 语义与 SQL 版逐条对齐；键空间分桶见 kv.ts 头注。
 */

import type { Clock } from "../ports/index";
import { systemClock } from "../ports/index";
import type {
  AssignmentItem,
  ConfirmedSubject,
  LongTermPlan,
  PlanVersionRecord,
  ReviewItem,
  SavedPlanMeta,
  TimetableEntry,
  TodayPlan,
  WeeklyReport,
} from "../protocol/study";
import type { KvStore } from "./kv";
import type { KnowledgeEdge, KnowledgeNode } from "./kgTypes";
import { ERROR_BOOK_MAX_ITEMS, type ErrorItem } from "../domain/errorBook";

/** 计划历史版本最多保留多少版（防止 KV 无限膨胀）。 */
const MAX_PLAN_VERSIONS = 30;

/** 能力评测快照最多保留多少条（每次打卡都会追加，必须设上限）。 */
const MAX_ASSESSMENT_ROWS = 200;

/** 导入时单个数据集最多接受的条数（防止恶意/损坏文件把内存打爆）。 */
const MAX_IMPORT_ITEMS = 5_000;

/** 「记忆」里按标量字段存储的类型（其余为 weak_points 数组）。 */
const MEMORY_SCALAR_KINDS = new Set([
  "grade",
  "mood",
  "last_deadline",
  "focus_preference",
  "constraint_note",
  "preferred_daily_minutes",
  "preferred_days_per_week",
  "preferred_pacing",
]);

/** 每个记忆类型对应的展示标签。 */
const MEMORY_LABELS: Record<string, string> = {
  weak_points: "薄弱点",
  grade: "年级",
  mood: "当前情绪",
  last_deadline: "截止时间",
  focus_preference: "学习方式偏好",
  constraint_note: "时间约束",
  preferred_daily_minutes: "每日可学时长",
  preferred_days_per_week: "每周可学天数",
  preferred_pacing: "学习节奏",
};

/** 导入时按数组处理的数据集。 */
const IMPORT_ARRAY_DATASETS = [
  "plan_versions",
  "subjects",
  "review",
  "assignments",
  "timetable",
  "reports",
  "error_book",
];
// 注意：documents 与图谱都是分键存储，不按「整数组写一个键」处理，在导入里单独走 replace。

/** 导入时按对象处理的数据集。 */
const IMPORT_OBJECT_DATASETS = ["progress", "plans", "long_plan", "today"];

/**
 * 会造成原型污染的动态键名，一律拒绝。
 * KV 的键值可能被本地存储或入参篡改，`obj["__proto__"] = x` 会污染整个 Object.prototype。
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeKey(kind: string, value: string): void {
  if (UNSAFE_KEYS.has(value)) {
    throw new Error(`非法的${kind}`);
  }
}

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

/** 一条「记忆」：AI 通过 remember 工具写进画像、用户可见可删的内容。 */
export interface MemoryEntry {
  kind: string;
  label: string;
  value: string;
  updated_at: string;
}

/** 数据导入结果：各数据集实际写入的条数。 */
export interface ImportResult {
  counts: Record<string, number>;
  total: number;
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

/**
 * 早期版本内置过一套 9 节点 10 边的示例图谱（移植自原型 Synapse/db/retrieval.py）。
 *
 * 播种代码已经删了，但删代码不会删掉老用户存储里的数据——它们会继续冒充
 * 「用户自己的图谱」，清空重装前一直在。所以读取时直接滤掉；下次写入图谱
 * 时会顺手落盘清干净。按项目约定走读侧兜底，不写迁移脚本。
 */
const LEGACY_SEED_NODE_IDS = new Set([
  "course_math_hs",
  "topic_functions",
  "topic_quadratic",
  "topic_monotonicity",
  "topic_domain",
  "topic_exam_strategy",
  "task_sort_notes",
  "task_topic_drill",
  "task_review_loop",
]);

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

  /**
   * 读数组：本地存储可被同源脚本 / 扩展改写，形状不对时回退空数组，
   * 而不是把非数组 `as T[]` 强转后让 `.map()` 之类直接抛错。
   */
  private readArray<T>(key: string, fallback: T[] = []): T[] {
    const value = this.kv.get(key);
    return Array.isArray(value) ? (value as T[]) : fallback;
  }

  /** 读对象：同上，非「纯对象」时回退默认值。 */
  private readObject<T extends object>(key: string, fallback: T): T {
    const value = this.kv.get(key);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : fallback;
  }

  // ------------------------------------------------------------------
  // 画像 / API Key / 能力
  // ------------------------------------------------------------------

  private readProfileRow(userId: string): Record<string, unknown> {
    const all = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    return all[userId] ?? { user_id: userId };
  }

  private writeProfileRow(userId: string, row: Record<string, unknown>): void {
    assertSafeKey("用户标识", userId);
    const all = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
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
    const all = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    if (!Object.prototype.hasOwnProperty.call(all, userId)) {
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
    const all = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    if (!Object.prototype.hasOwnProperty.call(all, userId)) {
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
    const all = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    const abilities = jsonObj(
      Object.prototype.hasOwnProperty.call(all, userId)
        ? this.readProfileRow(userId)["abilities_json"]
        : "{}",
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

  // ------------------------------------------------------------------
  // 记忆（用户可见、可删）
  // ------------------------------------------------------------------

  /**
   * 列出画像里被「记住」的内容。
   *
   * 这些条目是 AI 通过 remember 工具悄悄写下的（弱项/情绪/偏好/约束/截止时间/年级等），
   * 此前只进 prompt、用户完全看不到。列出来才能让用户纠正「记错了」的情况。
   */
  get_memories(userId = "default"): MemoryEntry[] {
    const uid = userId || "default";
    const all = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    if (!Object.prototype.hasOwnProperty.call(all, uid)) {
      return [];
    }
    const row = this.readProfileRow(uid);
    const updatedAt = String(row["updated_at"] ?? "");
    const entries: MemoryEntry[] = [];
    const push = (kind: string, value: unknown): void => {
      const text =
        typeof value === "string"
          ? value.trim()
          : value === null || value === undefined
            ? ""
            : String(value);
      if (!text) {
        return;
      }
      entries.push({ kind, label: MEMORY_LABELS[kind] ?? kind, value: text, updated_at: updatedAt });
    };

    const memory = this.profileMemory(row["abilities_json"]);
    for (const item of Array.isArray(memory["weak_points"])
      ? (memory["weak_points"] as unknown[])
      : []) {
      push("weak_points", item);
    }
    for (const kind of MEMORY_SCALAR_KINDS) {
      push(kind, row[kind]);
    }
    return entries;
  }

  /**
   * 删除一条记忆。
   * `weak_points` 传 value 只删那一条，不传则清空全部；其余类型是标量字段，直接清除。
   */
  delete_memory(userId: string, kind: string, value = ""): MemoryEntry[] {
    const uid = userId || "default";
    assertSafeKey("用户标识", uid);
    const row = this.readProfileRow(uid);
    const target = (value || "").trim();

    if (kind === "weak_points") {
      const abilities = jsonObj(row["abilities_json"]);
      const memory = abilities["__profile__"];
      if (memory && typeof memory === "object" && !Array.isArray(memory)) {
        const dict = memory as Record<string, unknown>;
        const current = Array.isArray(dict["weak_points"])
          ? (dict["weak_points"] as unknown[]).map((item) => String(item))
          : [];
        const next = target ? current.filter((item) => item !== target) : [];
        if (next.length) {
          dict["weak_points"] = next;
        } else {
          delete dict["weak_points"];
        }
        dict["updated_at"] = this.now();
        abilities["__profile__"] = dict;
        row["abilities_json"] = JSON.stringify(abilities);
      }
    } else if (MEMORY_SCALAR_KINDS.has(kind)) {
      delete row[kind];
    } else {
      throw new Error("未知的记忆类型");
    }

    row["updated_at"] = this.now();
    this.writeProfileRow(uid, row);
    return this.get_memories(uid);
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
    const rows = this.readArray<AssessmentRecord>(key, []);
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
    // 打卡会不断追加，只保留最近若干条，避免 KV 无限膨胀
    this.kv.set(key, rows.slice(-MAX_ASSESSMENT_ROWS));
  }

  /** 读取能力评测快照（周报用它算各科目的能力值变化）。 */
  get_assessments(): AssessmentRecord[] {
    return this.readArray<AssessmentRecord>("assessments:default", []);
  }

  // ------------------------------------------------------------------
  // 待确认会话（一次性消费）
  // ------------------------------------------------------------------

  save_session(sessionId: string, payload: Record<string, unknown>): void {
    assertSafeKey("会话标识", sessionId);
    const sessions = this.readObject<Record<string, unknown>>("clarifications", {});
    sessions[sessionId] = {
      user_id: "default",
      normalized_payload: payload["normalized_payload"] ?? {},
      request_echo: payload["request_echo"] ?? {},
      memories: payload["memories"] ?? [],
      planning_mode: String(payload["planning_mode"] ?? "free"),
      // v2：作业澄清会话要能跨进程恢复（壳重启后重新拉起 pending 时仍拿得到原文）
      assignment_text: String(payload["assignment_text"] ?? ""),
      created_at: this.now(),
    };
    this.kv.set("clarifications", sessions);
  }

  pop_session(sessionId: string): Record<string, unknown> | null {
    assertSafeKey("会话标识", sessionId);
    const sessions = this.readObject<Record<string, Record<string, unknown>>>(
      "clarifications",
      {},
    );
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
    if (!Array.isArray(rows)) {
      return [];
    }
    // G2 新增了 hint_texts：旧数据读取侧补默认值，不需要迁移
    return rows.map((row) =>
      Array.isArray(row?.hint_texts) ? row : { ...row, hint_texts: [] },
    );
  }

  save_reviews(userId: string, items: ReviewItem[]): ReviewItem[] {
    this.kv.set(`review:${userId}`, items);
    return this.get_reviews(userId);
  }

  // ------------------------------------------------------------------
  // 错题本（v2：做题 → 判分 → 错题入本 → 进复习）
  // ------------------------------------------------------------------

  get_error_items(userId: string): ErrorItem[] {
    const rows = this.readArray<ErrorItem>(`error_book:${userId}`, []);
    return rows.filter((row) => row && typeof row === "object" && typeof row.id === "string");
  }

  save_error_items(userId: string, items: ErrorItem[]): ErrorItem[] {
    // 新错题在前（最近做错的更需要复习），并封顶
    const capped = items.slice(0, ERROR_BOOK_MAX_ITEMS);
    this.kv.set(`error_book:${userId}`, capped);
    return this.get_error_items(userId);
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
    const all = this.readObject<Record<string, ProgressRecord>>(`progress:${userId}`, {});
    const result: Record<string, ProgressRecord> = {};
    for (const [taskKey, record] of Object.entries(all)) {
      if (UNSAFE_KEYS.has(taskKey)) {
        continue;
      }
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
    assertSafeKey("任务标识", taskKey);
    const all = this.readObject<Record<string, ProgressRecord>>(key, {});
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
  //
  // 存储布局：索引键只存 doc_id 列表，正文（chunks）按条目分键。
  // 之前是「一个键装整个数组」，改一份资料就要把全部资料的正文重新序列化一遍；
  // 分键后改/删单份资料是常数级写入，资料多了也不会越写越慢。
  // ------------------------------------------------------------------

  private docIndexKey(userId: string): string {
    return `doc_index:${userId || "default"}`;
  }

  private docItemKey(userId: string, docId: string): string {
    return `doc:${userId || "default"}:${docId}`;
  }

  /** 旧布局（单键整数组）的键，只用于读侧迁移。 */
  private legacyDocsKey(userId: string): string {
    return `documents:${userId || "default"}`;
  }

  /** 把旧的「单键整数组」资料迁到分键布局；幂等，已迁移则直接返回。 */
  private _migrate_legacy_documents(userId: string): void {
    const uid = userId || "default";
    if (this.kv.get(this.docIndexKey(uid)) !== undefined) {
      return;
    }
    const legacy = this.readArray<Record<string, unknown>>(this.legacyDocsKey(uid), []);
    const ids: string[] = [];
    for (const row of legacy) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        continue;
      }
      const docId = String(row["doc_id"] ?? "").trim();
      if (!docId) {
        continue;
      }
      this.kv.set(this.docItemKey(uid, docId), { ...row });
      ids.push(docId);
    }
    this.kv.set(this.docIndexKey(uid), ids);
    if (this.kv.get(this.legacyDocsKey(uid)) !== undefined) {
      this.kv.delete(this.legacyDocsKey(uid));
    }
  }

  /** 按索引逐条读取原始资料行（保留 updated_at，供写路径使用）。 */
  private _read_raw_documents(userId: string): Array<Record<string, unknown>> {
    const uid = userId || "default";
    this._migrate_legacy_documents(uid);
    const rows: Array<Record<string, unknown>> = [];
    for (const id of this.readArray<string>(this.docIndexKey(uid), [])) {
      const row = this.kv.get(this.docItemKey(uid, String(id)));
      if (row && typeof row === "object" && !Array.isArray(row)) {
        rows.push(row as Record<string, unknown>);
      }
    }
    return rows;
  }

  private _write_doc_index(userId: string, ids: string[]): void {
    this.kv.set(this.docIndexKey(userId || "default"), ids);
  }

  private _normalize_documents(rows: Array<Record<string, unknown>>): Record<string, unknown>[] {
    return rows
      .map((row) => ({
        doc_id: row["doc_id"],
        user_id: row["user_id"],
        file_name: row["file_name"],
        excerpt: row["excerpt"],
        chunks: row["chunks"] ?? [],
        // F1 结构化元数据：旧数据没有这些字段，在读取侧补默认值即可，不需要迁移脚本。
        subject: String(row["subject"] ?? ""),
        tags: Array.isArray(row["tags"]) ? row["tags"] : [],
        source: String(row["source"] ?? "upload"),
        created_at: String(row["created_at"] ?? ""),
        char_count: Math.max(0, Math.trunc(Number(row["char_count"] ?? 0))),
        kg_node_ids: Array.isArray(row["kg_node_ids"]) ? row["kg_node_ids"] : [],
        review_card_ids: Array.isArray(row["review_card_ids"]) ? row["review_card_ids"] : [],
        updated_at: row["updated_at"] ?? "",
      }))
      .sort((a, b) => {
        const ua = String(a["updated_at"]);
        const ub = String(b["updated_at"]);
        return ua < ub ? 1 : ua > ub ? -1 : 0;
      })
      .map(({ updated_at: _updatedAt, ...row }) => row);
  }

  get_documents(userId: string): Record<string, unknown>[] {
    return this._normalize_documents(this._read_raw_documents(userId));
  }

  save_documents(
    userId: string,
    newDocuments: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const uid = userId || "default";
    if (!newDocuments.length) {
      return this.get_documents(uid);
    }
    const index = [...this.readArray<string>(this.docIndexKey(uid), [])].map((id) => String(id));
    const known = new Set(index);

    for (const doc of newDocuments) {
      const docId = String(doc["doc_id"] || doc["file_name"] || "").trim();
      if (!docId) {
        continue;
      }
      const stored = this.kv.get(this.docItemKey(uid, docId));
      // 写前复制，避免 KV set 因容量等原因失败时污染存储中原对象。
      const existing: Record<string, unknown> =
        stored && typeof stored === "object" && !Array.isArray(stored)
          ? { ...(stored as Record<string, unknown>) }
          : { doc_id: docId, user_id: uid };

      existing["file_name"] = String(doc["file_name"] || "未命名资料").slice(0, 512);
      existing["excerpt"] = String(doc["excerpt"] || "").slice(0, 4096);
      existing["chunks"] = doc["chunks"] ?? [];
      // F1 元数据：未传入时保留原值（新建时落到默认值），因此旧调用点行为不变。
      existing["subject"] = String(doc["subject"] ?? existing["subject"] ?? "").slice(0, 64);
      if (Array.isArray(doc["tags"])) {
        existing["tags"] = this._clean_tags(doc["tags"]);
      } else if (!Array.isArray(existing["tags"])) {
        existing["tags"] = [];
      }
      existing["source"] = String(doc["source"] ?? existing["source"] ?? "upload");
      existing["char_count"] = Math.max(
        0,
        Math.trunc(Number(doc["char_count"] ?? existing["char_count"] ?? 0)),
      );
      if (!Array.isArray(existing["kg_node_ids"])) {
        existing["kg_node_ids"] = [];
      }
      if (!Array.isArray(existing["review_card_ids"])) {
        existing["review_card_ids"] = [];
      }
      if (!existing["created_at"]) {
        existing["created_at"] = this.now();
      }
      existing["updated_at"] = this.now();
      this.kv.set(this.docItemKey(uid, docId), existing);

      if (!known.has(docId)) {
        known.add(docId);
        index.push(docId);
      }
    }

    this._write_doc_index(uid, index);
    return this.get_documents(uid);
  }

  /**
   * 局部更新资料元数据（改标题/科目/标签，或回填图谱节点与复习卡 ID）。
   *
   * 单独一个方法而不是复用 save_documents：后者是整份 upsert，
   * 不传 excerpt/chunks 会把正文清空，改单个字段很危险。
   */
  update_document(
    userId: string,
    docId: string,
    patch: {
      file_name?: string;
      subject?: string;
      tags?: string[];
      kg_node_ids?: string[];
      review_card_ids?: string[];
    },
  ): Record<string, unknown>[] {
    const uid = userId || "default";
    this._migrate_legacy_documents(uid);
    const stored = this.kv.get(this.docItemKey(uid, docId));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      return this.get_documents(uid);
    }
    const target = { ...(stored as Record<string, unknown>) };
    if (patch.file_name !== undefined) {
      target["file_name"] = String(patch.file_name || "未命名资料").slice(0, 512);
    }
    if (patch.subject !== undefined) {
      target["subject"] = String(patch.subject).slice(0, 64);
    }
    if (patch.tags !== undefined) {
      target["tags"] = this._clean_tags(patch.tags);
    }
    if (patch.kg_node_ids !== undefined) {
      target["kg_node_ids"] = [...new Set(patch.kg_node_ids.map((id) => String(id)).filter(Boolean))];
    }
    if (patch.review_card_ids !== undefined) {
      target["review_card_ids"] = [
        ...new Set(patch.review_card_ids.map((id) => String(id)).filter(Boolean)),
      ];
    }
    if (!target["created_at"]) {
      target["created_at"] = this.now();
    }
    target["updated_at"] = this.now();
    // 只写这一条：不再牵动其它资料的正文
    this.kv.set(this.docItemKey(uid, docId), target);
    return this.get_documents(uid);
  }

  private _clean_tags(tags: unknown[]): string[] {
    return tags
      .map((tag) => String(tag ?? "").trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  /** 删除一份资料（save_documents 是 upsert 语义，删除需要单独走这里）。 */
  delete_document(userId: string, docId: string): Record<string, unknown>[] {
    const uid = userId || "default";
    this._migrate_legacy_documents(uid);
    this.kv.delete(this.docItemKey(uid, docId));
    this._write_doc_index(
      uid,
      this.readArray<string>(this.docIndexKey(uid), []).filter((id) => String(id) !== docId),
    );
    return this.get_documents(uid);
  }

  /** 整体替换某用户的资料集（导入用）：先清旧条目，再按分键写入。 */
  private _replace_documents(userId: string, rows: unknown[]): number {
    const uid = userId || "default";
    this._delete_documents(uid);
    const ids: string[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const row = raw as Record<string, unknown>;
      const docId = String(row["doc_id"] ?? "").trim();
      if (!docId) {
        continue;
      }
      this.kv.set(this.docItemKey(uid, docId), { ...row });
      ids.push(docId);
    }
    this.kv.set(this.docIndexKey(uid), ids);
    return ids.length;
  }

  /** 清空某用户的资料（删档用）：条目 + 索引 + 旧布局键一并清掉。 */
  private _delete_documents(userId: string): void {
    const uid = userId || "default";
    for (const id of this.readArray<string>(this.docIndexKey(uid), [])) {
      this.kv.delete(this.docItemKey(uid, String(id)));
    }
    this.kv.delete(this.docIndexKey(uid));
    this.kv.delete(this.legacyDocsKey(uid));
  }

  // ------------------------------------------------------------------
  // 会话 / 消息
  // ------------------------------------------------------------------

  list_conversations(userId = "default"): ConversationRecord[] {
    const rows = this.readArray<ConversationRecord>(KEY_CONVERSATIONS, []);
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
    assertSafeKey("会话标识", conversationId);
    const rows = this.readArray<ConversationRecord>(KEY_CONVERSATIONS, []);
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
    assertSafeKey("会话标识", conversationId);
    this.kv.delete(`messages:${conversationId}`);
    const conversations = this.readArray<ConversationRecord>(KEY_CONVERSATIONS, []);
    this.kv.set(
      KEY_CONVERSATIONS,
      conversations.filter((row) => row.id !== conversationId),
    );
    // 进度记录按会话过滤删除
    const progressKey = "progress:default";
    const progress = this.readObject<Record<string, ProgressRecord>>(progressKey, {});
    const kept = Object.fromEntries(
      Object.entries(progress).filter(([, record]) => record.conversation_id !== conversationId),
    );
    this.kv.set(progressKey, kept);
    // 评估记录按会话过滤删除
    const assessmentKey = "assessments:default";
    const assessments = this.readArray<AssessmentRecord>(assessmentKey, []);
    this.kv.set(
      assessmentKey,
      assessments.filter((row) => row.conversation_id !== conversationId),
    );
  }

  get_messages(conversationId: string): MessageRecord[] {
    assertSafeKey("会话标识", conversationId);
    return this.readArray<MessageRecord>(`messages:${conversationId}`, []);
  }

  save_message(
    messageId: string,
    conversationId: string,
    role: string,
    content = "",
    kwargs: Partial<Omit<MessageRecord, "id" | "role" | "content" | "created_at">> = {},
  ): void {
    const key = `messages:${conversationId}`;
    assertSafeKey("会话标识", conversationId);
    const rows = this.readArray<MessageRecord>(key, []);
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
  //
  // 图谱没有内置内容：新装即空，全部由用户自己的资料与计划构建。
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 知识图谱
  //
  // 与资料同构：索引键只存 id，节点/边各自分键。追加一个节点是常数级写入，
  // 不再把整张图谱重新序列化一遍。
  // ------------------------------------------------------------------

  private kgNodeIndexKey(userId: string): string {
    return `kg:node_index:${userId || "default"}`;
  }

  private kgNodeItemKey(userId: string, nodeId: string): string {
    return `kg:node:${userId || "default"}:${nodeId}`;
  }

  private kgEdgeIndexKey(userId: string): string {
    return `kg:edge_index:${userId || "default"}`;
  }

  private kgEdgeItemKey(userId: string, edgeId: string): string {
    return `kg:edge:${userId || "default"}:${edgeId}`;
  }

  /** 边没有 id 字段：用 source/target/relation 三元组生成稳定键（与判重口径一致）。 */
  private edgeStorageId(edge: KnowledgeEdge): string {
    return [edge.source_id, edge.target_id, edge.relation]
      .map((part) => encodeURIComponent(String(part ?? "")))
      .join("|");
  }

  /**
   * 旧版本把图谱存在全机共享的 `kg:nodes` / `kg:edges` 上（没有用户后缀）。
   * 只在默认档案读取时兜底迁移一次，迁移后删除旧键；幂等。
   */
  private _migrate_legacy_kg(userId: string): void {
    const uid = userId || "default";
    const isDefault = uid === "default";

    if (this.kv.get(this.kgNodeIndexKey(uid)) === undefined) {
      const legacy = isDefault ? this.readArray<KnowledgeNode>(KEY_KG_NODES, []) : [];
      const nodes = legacy.filter(
        (node) => Boolean(node) && Boolean(node.id) && !LEGACY_SEED_NODE_IDS.has(node.id),
      );
      const ids: string[] = [];
      for (const node of nodes) {
        this.kv.set(this.kgNodeItemKey(uid, node.id), node);
        ids.push(node.id);
      }
      this.kv.set(this.kgNodeIndexKey(uid), ids);
      if (isDefault && this.kv.get(KEY_KG_NODES) !== undefined) {
        this.kv.delete(KEY_KG_NODES);
      }
    }

    if (this.kv.get(this.kgEdgeIndexKey(uid)) === undefined) {
      const legacy = isDefault ? this.readArray<KnowledgeEdge>(KEY_KG_EDGES, []) : [];
      const edges = legacy.filter(
        (edge) =>
          Boolean(edge) &&
          Boolean(edge.source_id) &&
          Boolean(edge.target_id) &&
          Boolean(edge.relation) &&
          !LEGACY_SEED_NODE_IDS.has(edge.source_id) &&
          !LEGACY_SEED_NODE_IDS.has(edge.target_id),
      );
      const ids: string[] = [];
      for (const edge of edges) {
        const id = this.edgeStorageId(edge);
        this.kv.set(this.kgEdgeItemKey(uid, id), edge);
        ids.push(id);
      }
      this.kv.set(this.kgEdgeIndexKey(uid), ids);
      if (isDefault && this.kv.get(KEY_KG_EDGES) !== undefined) {
        this.kv.delete(KEY_KG_EDGES);
      }
    }
  }

  kgNodes(userId = "default"): KnowledgeNode[] {
    const uid = userId || "default";
    this._migrate_legacy_kg(uid);
    const out: KnowledgeNode[] = [];
    for (const id of this.readArray<string>(this.kgNodeIndexKey(uid), [])) {
      const node = this.kv.get(this.kgNodeItemKey(uid, String(id)));
      if (node && typeof node === "object" && !Array.isArray(node)) {
        out.push(node as KnowledgeNode);
      }
    }
    return out.filter((node) => Boolean(node) && !LEGACY_SEED_NODE_IDS.has(node.id));
  }

  kgEdges(userId = "default"): KnowledgeEdge[] {
    const uid = userId || "default";
    this._migrate_legacy_kg(uid);
    const out: KnowledgeEdge[] = [];
    for (const id of this.readArray<string>(this.kgEdgeIndexKey(uid), [])) {
      const edge = this.kv.get(this.kgEdgeItemKey(uid, String(id)));
      if (edge && typeof edge === "object" && !Array.isArray(edge)) {
        out.push(edge as KnowledgeEdge);
      }
    }
    return out.filter(
      (edge) =>
        Boolean(edge) &&
        !LEGACY_SEED_NODE_IDS.has(edge.source_id) &&
        !LEGACY_SEED_NODE_IDS.has(edge.target_id),
    );
  }

  /** 按 id 去重追加图谱节点，返回实际新增数量。 */
  addKgNodes(userId: string, nodes: KnowledgeNode[]): number {
    const uid = userId || "default";
    assertSafeKey("用户标识", uid);
    this._migrate_legacy_kg(uid);
    const index = [...this.readArray<string>(this.kgNodeIndexKey(uid), [])].map((id) => String(id));
    const known = new Set(index);
    let added = 0;
    for (const node of nodes) {
      if (!node?.id || known.has(node.id)) {
        continue;
      }
      known.add(node.id);
      index.push(node.id);
      this.kv.set(this.kgNodeItemKey(uid, node.id), node);
      added += 1;
    }
    if (added) {
      this.kv.set(this.kgNodeIndexKey(uid), index);
    }
    return added;
  }

  /** 按 source/target/relation 三元组去重追加图谱边，返回实际新增数量。 */
  addKgEdges(userId: string, edges: KnowledgeEdge[]): number {
    const uid = userId || "default";
    assertSafeKey("用户标识", uid);
    this._migrate_legacy_kg(uid);
    const index = [...this.readArray<string>(this.kgEdgeIndexKey(uid), [])].map((id) => String(id));
    const known = new Set(index);
    let added = 0;
    for (const edge of edges) {
      if (!edge?.source_id || !edge?.target_id || !edge?.relation) {
        continue;
      }
      const id = this.edgeStorageId(edge);
      if (known.has(id)) {
        continue;
      }
      known.add(id);
      index.push(id);
      this.kv.set(this.kgEdgeItemKey(uid, id), edge);
      added += 1;
    }
    if (added) {
      this.kv.set(this.kgEdgeIndexKey(uid), index);
    }
    return added;
  }

  /** 整体替换某用户的节点集（导入用）：先清旧条目，再写新条目。 */
  private _replace_kg_nodes(uid: string, nodes: unknown[]): number {
    for (const id of this.readArray<string>(this.kgNodeIndexKey(uid), [])) {
      this.kv.delete(this.kgNodeItemKey(uid, String(id)));
    }
    const ids: string[] = [];
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const node = raw as KnowledgeNode;
      if (typeof node.id !== "string" || !node.id) {
        continue;
      }
      this.kv.set(this.kgNodeItemKey(uid, node.id), node);
      ids.push(node.id);
    }
    this.kv.set(this.kgNodeIndexKey(uid), ids);
    return ids.length;
  }

  /** 整体替换某用户的边集（导入用）。 */
  private _replace_kg_edges(uid: string, edges: unknown[]): number {
    for (const id of this.readArray<string>(this.kgEdgeIndexKey(uid), [])) {
      this.kv.delete(this.kgEdgeItemKey(uid, String(id)));
    }
    const ids: string[] = [];
    for (const raw of edges) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const edge = raw as KnowledgeEdge;
      if (typeof edge.source_id !== "string" || typeof edge.target_id !== "string") {
        continue;
      }
      const id = this.edgeStorageId(edge);
      this.kv.set(this.kgEdgeItemKey(uid, id), edge);
      ids.push(id);
    }
    this.kv.set(this.kgEdgeIndexKey(uid), ids);
    return ids.length;
  }

  /** 清空某用户的图谱（删档用；不触发迁移）。 */
  private _delete_kg(userId: string): void {
    const uid = userId || "default";
    for (const id of this.readArray<string>(this.kgNodeIndexKey(uid), [])) {
      this.kv.delete(this.kgNodeItemKey(uid, String(id)));
    }
    this.kv.delete(this.kgNodeIndexKey(uid));
    for (const id of this.readArray<string>(this.kgEdgeIndexKey(uid), [])) {
      this.kv.delete(this.kgEdgeItemKey(uid, String(id)));
    }
    this.kv.delete(this.kgEdgeIndexKey(uid));
  }

  // ------------------------------------------------------------------
  // 作业式计划
  // ------------------------------------------------------------------

  /** 读取作业清单。与资料一样在读取侧补默认值，旧数据（乃至手工写入的残缺行）不会报错。 */
  get_assignments(userId: string): AssignmentItem[] {
    const rows = this.readArray<Record<string, unknown>>(`assignments:${userId}`, []);
    return rows
      .map((row) => ({
        id: String(row["id"] ?? ""),
        subject: String(row["subject"] ?? ""),
        title: String(row["title"] ?? ""),
        quantity: Math.max(0, Math.trunc(Number(row["quantity"] ?? 0))),
        unit: String(row["unit"] ?? ""),
        due_date: String(row["due_date"] ?? ""),
        estimated_minutes: Math.max(0, Math.trunc(Number(row["estimated_minutes"] ?? 0))),
        status: (row["status"] === "done" || row["status"] === "overdue"
          ? row["status"]
          : "pending") as AssignmentItem["status"],
        done_at: String(row["done_at"] ?? ""),
        created_at: String(row["created_at"] ?? ""),
        source_text: String(row["source_text"] ?? ""),
        review_card_ids: Array.isArray(row["review_card_ids"])
          ? (row["review_card_ids"] as unknown[]).map((id) => String(id))
          : [],
        plan_id: String(row["plan_id"] ?? ""),
        plan_version:
          row["plan_version"] === null || row["plan_version"] === undefined
            ? null
            : Math.trunc(Number(row["plan_version"])),
        original_due_date: String(row["original_due_date"] ?? ""),
        rescheduled_at: String(row["rescheduled_at"] ?? ""),
      }))
      .filter((row) => row.id && row.title);
  }

  save_assignments(userId: string, items: AssignmentItem[]): AssignmentItem[] {
    this.kv.set(
      `assignments:${userId}`,
      items.map((item) => ({ ...item })),
    );
    return this.get_assignments(userId);
  }

  /** 局部更新一条作业（打卡 / 重排 / 抽卡回写）。 */
  update_assignment(
    userId: string,
    assignmentId: string,
    patch: Partial<AssignmentItem>,
  ): AssignmentItem[] {
    const items = this.get_assignments(userId);
    const next = items.map((item) =>
      item.id === assignmentId ? { ...item, ...patch, id: item.id } : item,
    );
    return this.save_assignments(userId, next);
  }

  // ------------------------------------------------------------------
  // 学情周报（G3）
  // ------------------------------------------------------------------

  /** 读取周报历史（按生成时间正序，最新一期在最后）。 */
  get_reports(userId: string): WeeklyReport[] {
    const rows = this.readJson<Array<Record<string, unknown>>>(`reports:${userId}`, []);
    if (!Array.isArray(rows)) {
      return [];
    }
    // G3 新键：旧数据或手工写入的残缺行在读取侧补默认值，不做迁移
    return rows
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        id: String(row["id"] ?? ""),
        user_id: String(row["user_id"] ?? userId),
        created_at: String(row["created_at"] ?? ""),
        stats: (row["stats"] ?? {}) as WeeklyReport["stats"],
        narrative: String(row["narrative"] ?? ""),
        degraded: Boolean(row["degraded"]),
      }))
      .filter((row) => row.id);
  }

  /** 覆盖写入周报列表。保留期数由调用方（ReportService）按域常量裁剪。 */
  save_reports(userId: string, reports: WeeklyReport[]): WeeklyReport[] {
    this.kv.set(
      `reports:${userId}`,
      reports.map((report) => ({ ...report })),
    );
    return this.get_reports(userId);
  }

  // ------------------------------------------------------------------
  // 数据导出
  // ------------------------------------------------------------------

  /**
   * 导出该用户的全部本地数据（数据主权归用户：随时能把自己的数据拿走）。
   * API Key 会被剔除 —— 导出文件不该成为凭据泄露的新渠道。
   */
  export_user_data(userId = "default"): Record<string, unknown> {
    const uid = userId || "default";
    const data: Record<string, unknown> = {};
    for (const key of [
      `progress:${uid}`,
      `plans:${uid}`,
      `plan_versions:${uid}`,
      `subjects:${uid}`,
      `long_plan:${uid}`,
      `today:${uid}`,
      `review:${uid}`,
      `assignments:${uid}`,
      `timetable:${uid}`,
      `reports:${uid}`,
      `error_book:${uid}`,
    ]) {
      data[key] = this.kv.get(key) ?? null;
    }
    // 资料是分键存储，用访问器取（保留原始行，含 updated_at）
    data[`documents:${uid}`] = this._read_raw_documents(uid);

    const conversations = this.list_conversations(uid);
    data[`conversations:${uid}`] = conversations;
    data["messages"] = Object.fromEntries(
      conversations.map((conversation) => [conversation.id, this.get_messages(conversation.id)]),
    );

    const profiles = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    const profileRow = { ...(profiles[uid] ?? {}) };
    delete profileRow["api_key"];
    data[`profile:${uid}`] = profileRow;

    data[KEY_KG_NODES] = this.kgNodes(uid);
    data[KEY_KG_EDGES] = this.kgEdges(uid);
    data["assessments"] = this.readArray<unknown>("assessments:default", []);
    data["exported_at"] = this.now();
    return data;
  }

  // ------------------------------------------------------------------
  // 数据导入（export_user_data 的逆操作）
  // ------------------------------------------------------------------

  /**
   * 导入此前导出的 JSON（结构见 export_user_data）。
   *
   * 语义是「恢复」：文件里出现的数据集覆盖到目标用户，没出现的不动。
   * 安全约束（本地数据同样不可信，导入文件更不可信）：
   * - 只认白名单数据集，绝不接受任意键名写进 KV；
   * - 一律剔除 api_key：凭据不随数据迁移，也避免导出文件成为新的泄露渠道；
   * - 数组/对象做形状校验与条数上限，坏数据整体跳过而不是污染存储。
   */
  import_user_data(userId: string, payload: Record<string, unknown>): ImportResult {
    const uid = userId || "default";
    assertSafeKey("用户标识", uid);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("导入内容不是合法的 JSON 对象");
    }

    const counts: Record<string, number> = {};

    // 1) 用户维度的数据集：来源键带导出时的 uid，按前缀匹配后落到目标用户。
    for (const name of [...IMPORT_ARRAY_DATASETS, ...IMPORT_OBJECT_DATASETS]) {
      const sourceKey = Object.keys(payload).find((key) => key.startsWith(`${name}:`));
      if (!sourceKey) {
        continue;
      }
      const value = payload[sourceKey];
      if (value === null || value === undefined || typeof value !== "object") {
        continue;
      }
      if (IMPORT_ARRAY_DATASETS.includes(name)) {
        if (!Array.isArray(value)) {
          continue;
        }
        const rows = value.slice(0, MAX_IMPORT_ITEMS);
        this.kv.set(`${name}:${uid}`, rows);
        counts[name] = rows.length;
      } else {
        if (Array.isArray(value)) {
          continue;
        }
        this.kv.set(`${name}:${uid}`, value);
        counts[name] = 1;
      }
    }

    // 1.5) 资料：分键存储，语义是整体替换（与旧版导出文件兼容）
    const docsKey = Object.keys(payload).find((key) => key.startsWith("documents:"));
    if (docsKey && Array.isArray(payload[docsKey])) {
      counts["documents"] = this._replace_documents(
        uid,
        (payload[docsKey] as unknown[]).slice(0, MAX_IMPORT_ITEMS),
      );
    }

    // 2) 会话：按 id 合并（不重复导入），并把归属改到目标用户。
    const conversationKey = Object.keys(payload).find((key) => key.startsWith("conversations:"));
    const importedConversations = conversationKey ? payload[conversationKey] : null;
    if (Array.isArray(importedConversations)) {
      const existing = this.readArray<ConversationRecord>(KEY_CONVERSATIONS, []);
      const byId = new Map(existing.map((row) => [row.id, row]));
      let added = 0;
      for (const raw of importedConversations.slice(0, MAX_IMPORT_ITEMS)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          continue;
        }
        const row = raw as Record<string, unknown>;
        const id = String(row["id"] ?? "").trim();
        if (!id || UNSAFE_KEYS.has(id)) {
          continue;
        }
        if (byId.has(id)) {
          continue;
        }
        byId.set(id, { ...(row as unknown as ConversationRecord), id, user_id: uid });
        added += 1;
      }
      this.kv.set(KEY_CONVERSATIONS, [...byId.values()]);
      counts["conversations"] = added;
    }

    // 3) 消息：按会话 id 覆盖。
    const importedMessages = payload["messages"];
    if (importedMessages && typeof importedMessages === "object" && !Array.isArray(importedMessages)) {
      let total = 0;
      for (const [conversationId, rows] of Object.entries(
        importedMessages as Record<string, unknown>,
      )) {
        if (UNSAFE_KEYS.has(conversationId) || !Array.isArray(rows)) {
          continue;
        }
        const capped = rows.slice(0, MAX_IMPORT_ITEMS);
        this.kv.set(`messages:${conversationId}`, capped);
        total += capped.length;
      }
      counts["messages"] = total;
    }

    // 4) 画像：字段级合并，保留本机已有的 api_key。
    const profileKey = Object.keys(payload).find((key) => key.startsWith("profile:"));
    const importedProfile = profileKey ? payload[profileKey] : null;
    if (importedProfile && typeof importedProfile === "object" && !Array.isArray(importedProfile)) {
      const row = this.readProfileRow(uid);
      for (const [field, value] of Object.entries(importedProfile as Record<string, unknown>)) {
        if (field === "api_key") {
          continue;
        }
        row[field] = value;
      }
      row["updated_at"] = this.now();
      this.writeProfileRow(uid, row);
      counts["profile"] = 1;
    }

    // 5) 知识图谱：整体覆盖（图谱完全由用户数据构建，导入文件里的图谱属于目标用户）。
    if (Array.isArray(payload[KEY_KG_NODES])) {
      counts["kg_nodes"] = this._replace_kg_nodes(
        uid,
        (payload[KEY_KG_NODES] as unknown[]).slice(0, MAX_IMPORT_ITEMS),
      );
    }
    if (Array.isArray(payload[KEY_KG_EDGES])) {
      counts["kg_edges"] = this._replace_kg_edges(
        uid,
        (payload[KEY_KG_EDGES] as unknown[]).slice(0, MAX_IMPORT_ITEMS),
      );
    }

    // 6) 能力评测快照：并入并保留最近若干条。
    if (Array.isArray(payload["assessments"])) {
      const merged = [
        ...this.readArray<unknown>("assessments:default", []),
        ...(payload["assessments"] as unknown[]),
      ].slice(-MAX_ASSESSMENT_ROWS);
      this.kv.set("assessments:default", merged);
      counts["assessments"] = merged.length;
    }

    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return { counts, total };
  }

  // ------------------------------------------------------------------
  // 清空
  // ------------------------------------------------------------------

  delete_all_user_data(userId = "default"): void {
    assertSafeKey("用户标识", userId);
    const conversations = this.readArray<ConversationRecord>(KEY_CONVERSATIONS, []);
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
    this._delete_documents(userId);
    this.kv.delete(`assignments:${userId}`);
    this.kv.delete(`reports:${userId}`);
    this.kv.delete(`error_book:${userId}`);
    // 图谱按用户分桶，只清当前用户的；旧版本的无后缀键也一并清掉，避免残留冒充当前用户的图谱。
    this._delete_kg(userId);
    if ((userId || "default") === "default") {
      this.kv.delete(KEY_KG_NODES);
      this.kv.delete(KEY_KG_EDGES);
    }
    this.kv.delete(`timetable:${userId}`);
    this.kv.delete("clarifications");
    this.kv.delete("assessments:default");
    const profiles = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    delete profiles[userId];
    this.kv.set(KEY_PROFILE, profiles);
  }

  // ------------------------------------------------------------------
  // 本地多用户档案（纯本地：换的是数据桶，不是真正的账号登录）
  // ------------------------------------------------------------------

  /**
   * 列出本机已有的档案。
   *
   * 注意：知识图谱（kg:nodes / kg:edges）目前仍是全机共享的，
   * 不随档案隔离 —— 这属于已知边界，见 README。
   */
  list_users(): Array<{ user_id: string; display_name: string; updated_at: string }> {
    const profiles = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    return Object.keys(profiles)
      .filter((userId) => userId && !UNSAFE_KEYS.has(userId))
      .map((userId) => {
        const row = profiles[userId] ?? {};
        return {
          user_id: userId,
          display_name: String(row["display_name"] ?? ""),
          updated_at: String(row["updated_at"] ?? ""),
        };
      })
      .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  }

  /** 新建一个档案；同名已存在时抛错，避免误覆盖他人数据。 */
  create_user(userId: string, displayName = ""): Array<{
    user_id: string;
    display_name: string;
    updated_at: string;
  }> {
    const uid = (userId || "").trim();
    if (!uid) {
      throw new Error("请填写档案名");
    }
    assertSafeKey("用户标识", uid);
    const profiles = this.readObject<Record<string, Record<string, unknown>>>(KEY_PROFILE, {});
    if (Object.prototype.hasOwnProperty.call(profiles, uid)) {
      throw new Error("这个档案已经存在");
    }
    profiles[uid] = {
      user_id: uid,
      display_name: (displayName || uid).trim(),
      updated_at: this.now(),
    };
    this.kv.set(KEY_PROFILE, profiles);
    return this.list_users();
  }
}
