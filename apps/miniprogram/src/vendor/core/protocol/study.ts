/**
 * 学习计划相关契约类型。
 * 翻译自 Synapse/backend/app/schemas/copilot.py（字段名与别名逐字保留，
 * JSON 形状与 Python pydantic model_dump 一致，以 baseline/golden 为冻结基线）。
 */

export type TaskType = "learn" | "practice" | "review" | "mock_exam";

export interface StudyPlanRequest {
  user_id: string;
  current_level: string;
  learning_goal: string;
  available_days_per_week: number; // 1..7
  available_minutes_per_day: number; // 15..720
  deadline: string | null;
  weak_points: string[];
  preferences: string[];
  need_user_confirmation: boolean;
}

export interface StudyTask {
  title: string;
  task_type: TaskType;
  duration_minutes: number;
  reason: string;
  /**
   * 所属科目（v2 新增，可选）。
   * 旧行为不产生该字段（baseline 黄金样本无此项，保持对齐）；
   * 只有当用户的学习目标覆盖多个科目时，才会为任务填充科目用于分组展示。
   */
  subject?: string;
}

export interface StudyDayPlan {
  day_index: number;
  focus: string;
  tasks: StudyTask[];
  carry_over: string[];
}

export type WorkflowStageStatus = "done" | "needs_user_confirmation" | "fallback";

export interface WorkflowStageResult {
  stage: string;
  status: WorkflowStageStatus;
  summary: string;
}

export interface StudyPlanPayload {
  learner_profile: Record<string, unknown>;
  retrieved_context: string[];
  stages: WorkflowStageResult[];
  weekly_plan: StudyDayPlan[];
  final_message: string;
  next_actions: string[];
}

export interface BlockOption {
  title: string;
  detail: string;
  duration: number;
}

export interface BlockItem {
  id: string;
  label: string;
  selectedIndex: number;
  options: BlockOption[];
}

export interface BlockPlan {
  title: string;
  description: string;
  day: string;
  limitMinutes: number;
  blocks: BlockItem[];
}

/** 规则计划兜底输出（generate_rule_plan 的返回形状）。 */
export interface RulePlanResult {
  weekly_plan: StudyDayPlan[];
  final_message: string;
  next_actions: string[];
  status: "fallback";
  summary: string;
}

// ---------------------------------------------------------------------------
// 课程表（v2 新增）
// ---------------------------------------------------------------------------

/** 课程表条目：一门课的一节课（周次 + 星期 + 起止时间）。 */
export interface TimetableEntry {
  id: string;
  /** 课程名，如「高等数学」 */
  name: string;
  /** 归类科目，用于和计划任务的 subject 对齐；默认等于 name */
  subject: string;
  /** 星期：1=周一 … 7=周日 */
  weekday: number;
  /** 从 00:00 起算的分钟数 */
  startMinute: number;
  endMinute: number;
  /** 周次描述，如「1-16」「1-8,10-16」，空表示每周 */
  weeks: string;
  location: string;
  teacher: string;
}

export interface TimetableParseResult {
  entries: TimetableEntry[];
  /** 未识别但被跳过的行，供用户手动校正 */
  unparsedLines: string[];
  warnings: string[];
}

/** 课程表对某一天的占用情况。 */
export interface DayBusySummary {
  day_index: number;
  busy_minutes: number;
  busy_ranges: string[];
  free_minutes: number;
  entries: TimetableEntry[];
}

/** 保存计划时记录的版本信息。 */
export interface SavedPlanMeta {
  version: number;
  updated_at: string;
  change_summary: string;
}

/**
 * 已确认科目（v2）。
 *
 * 记在用户身上、跨对话保留，是排程的**权威来源**：中途说「我还要学计网」是**并入**，
 * 而不是让模型从整段对话记录里重新猜目标（之前出现过把「当然算数」当成科目的情况）。
 */
export interface ConfirmedSubject {
  name: string;
  /** 来源说明，便于界面解释这个科目是怎么来的 */
  source: string;
  created_at: string;
}

/**
 * 计划历史版本（v2）。
 * 每一版都留档：一版执行完之后想调整时，可以回看/回到某一版，而不是被迫整版重生成。
 */
export interface PlanVersionRecord {
  version: number;
  updated_at: string;
  change_summary: string;
  message: string;
  weekly_plan: Record<string, unknown>[];
}

/**
 * 长期计划的一个阶段（v2 三层计划的最上层）。
 * 长期计划**不直接排每日任务**，只产出阶段目标；每日任务由短期计划落地。
 */
export interface Milestone {
  id: string;
  /** 阶段名，如「打基础」 */
  title: string;
  /** 这一阶段要达成什么（会作为该阶段短期计划的学习目标） */
  goal: string;
  subject: string;
  start_date: string;
  due_date: string;
  /** 验收标准：怎么算这一阶段完成 */
  acceptance: string;
  status: "pending" | "active" | "done";
}

export interface LongTermPlan {
  goal: string;
  deadline: string | null;
  subjects: string[];
  milestones: Milestone[];
  updated_at: string;
  version: number;
}

/**
 * 今日计划里的一条（v2 三层计划的最下层）。
 *
 * `key` 与短期计划的打卡标识保持一致（天+科目+标题），所以今日页勾选会同步到短期计划；
 * 手动添加的项用 `manual::{id}` 作为 key。
 */
export interface TodayItem {
  key: string;
  title: string;
  subject: string;
  task_type: TaskType;
  duration_minutes: number;
  done: boolean;
  /** 从哪一天顺延过来的；非空表示这是「昨日顺延」项 */
  carried_from: string;
  manual: boolean;
}

export interface TodayPlan {
  date: string;
  items: TodayItem[];
  /** 今天是短期计划的第几个学习日；超出范围（计划已走完）时为 0 */
  day_index: number;
  /**
   * 生成这份今日列表时所依据的短期计划版本号。
   * 计划被重新生成后版本号会变，据此重建列表 —— 否则同一天内会一直返回旧缓存。
   */
  plan_version: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// 作业式计划（v2 新增）
//
// 与「目标式计划」并列的第二种入口：老师布置的作业有明确截止日与数量，
// 系统负责把它摊到截止前的每一天，并盯着打卡与逾期。
// ---------------------------------------------------------------------------

export type AssignmentStatus = "pending" | "done" | "overdue";

/** 一条作业项（老师布置的一件事）。 */
export interface AssignmentItem {
  id: string;
  subject: string;
  title: string;
  /** 数量，0 表示用户没说数量 */
  quantity: number;
  /** 数量单位：「题」「页」「单词」「张」…，空表示按整件事估时 */
  unit: string;
  /** 截止日期 YYYY-MM-DD */
  due_date: string;
  /** 预估总时长（分钟） */
  estimated_minutes: number;
  status: AssignmentStatus;
  done_at: string;
  created_at: string;
  /** 用户原话，便于回看这条作业是怎么来的 */
  source_text: string;
  /** 完成后生成的复习卡 ID（复用资料→图谱→复习的同一条链路） */
  review_card_ids: string[];
  plan_id: string;
  plan_version: number | null;
  /** 逾期重排前的原始截止日；空表示没被重排过 */
  original_due_date: string;
  rescheduled_at: string;
}

/** 作业摊到某一天的一条安排。 */
export interface AssignmentSlotTask {
  assignment_id: string;
  title: string;
  subject: string;
  quantity: number;
  unit: string;
  minutes: number;
  due_date: string;
}

/** 作业在截止前某一天的安排。 */
export interface AssignmentDaySlot {
  date: string;
  /** 从今天算起第几天，今天为 1 */
  day_index: number;
  /** 距截止的倒计时文案：「D-2」「今天截止」「已逾期 1 天」 */
  countdown: string;
  tasks: AssignmentSlotTask[];
  total_minutes: number;
}

/** 作业看板快照（壳侧只读渲染，核心逻辑全在 core）。 */
export interface AssignmentSnapshot {
  items: AssignmentItem[];
  schedule: AssignmentDaySlot[];
  total: number;
  pending_count: number;
  done_count: number;
  overdue_count: number;
  generated_at: string;
}

/**
 * 作业包：把还没做完的作业压成一段可扫码 / 可粘贴的短码。
 *
 * 为什么要有它：老师布置作业这件事天然是一对多（一个人知道、全班要记），
 * 但每条作业的解析（截止日、数量、科目）都要花一次模型或规则成本。一个人排好、
 * 全班扫一下，重复劳动就没了 —— 这是「资料可分享」之外更刚需的一层。
 */
export interface AssignmentPackExport {
  /** 短码本体：首行是签名，其余每行一条作业 */
  code: string;
  /** 打包进去的作业条数 */
  count: number;
  /** 因为已完成而没有被打包的条数 */
  skipped_done: number;
}

/** 作业包导入结果。 */
export interface AssignmentPackImportResult {
  snapshot: AssignmentSnapshot;
  /** 这段码的签名是否匹配（不匹配说明扫的不是作业包） */
  recognized: boolean;
  imported: number;
  /** 因为「标题 + 截止日」已存在而跳过的条数 */
  skipped: number;
  /** 格式不对被忽略的行数 */
  invalid: number;
}

/**
 * 复习项（v2 间隔重复）。
 *
 * 完成一个学习类任务时自动进入复习队列，之后按 SM-2 算出的到期日排进当天。
 * 纯本地状态 → 完全离线可用（这也是它比 RAG 更适合当前场景的原因）。
 */
export interface ReviewItem {
  id: string;
  /** 稳定身份：科目 + 知识点；重复出现时按它合并，而不是新建一条 */
  key: string;
  subject: string;
  topic: string;
  /** SM-2 状态 */
  ease: number;
  interval_days: number;
  repetitions: number;
  due_date: string;
  last_reviewed_at: string;
  total_reviews: number;
  lapses: number;
  created_at: string;
}
