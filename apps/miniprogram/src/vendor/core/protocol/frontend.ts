/**
 * 前端负载与响应契约类型。
 * 翻译自 Synapse/backend/app/schemas/copilot.py 与 common.py（字段名/默认值逐字保留）。
 */

import type { BlockPlan, LongTermPlan, StudyPlanPayload } from "./study";

export interface FrontendAttachment {
  id: string | null;
  name: string;
  size: number | null;
  type: string | null;
  extracted_text: string;
  text_excerpt: string;
  extraction_status: string;
  extraction_error: string;
}

export interface FrontendUserProfile {
  name: string;
  grade: string;
}

export interface FrontendMemory {
  id: string;
  type: string;
  title: string;
  content: string;
}

export type PlanningMode = "free" | "blocks";

export interface StudyPilotRunRequest {
  input: string;
  message: string;
  files: FrontendAttachment[];
  userProfile: FrontendUserProfile | null;
  user_profile: FrontendUserProfile | null;
  planningMode: PlanningMode;
  mode: PlanningMode;
  memories: FrontendMemory[];
  /**
   * 会话 ID（v2 新增，可选）。
   * 传入后 core 会按该会话读取多轮历史，并把本轮问答写入会话消息；
   * 不传则保持旧行为（不读写会话历史），旧黄金样本不受影响。
   */
  conversationId?: string;
  conversation_id?: string;
}

export interface ClarificationQuestion {
  id: string;
  label: string;
  description: string;
  placeholder: string;
  suggestedAnswers: string[];
}

export interface ClarificationPrompt {
  sessionId: string;
  title: string;
  description: string;
  questions: ClarificationQuestion[];
}

export interface ClarificationAnswer {
  questionId: string;
  answer: string;
}

export interface StudyPilotClarificationRequest {
  sessionId: string;
  answers: ClarificationAnswer[];
  /** 会话 ID（v2 新增，可选）：传入后本轮问答同样写入会话消息 */
  conversationId?: string;
  conversation_id?: string;
}

export type RunResponseStatus = "ready" | "maintenance" | "needs_clarification";

export interface StudyPilotRunResponse {
  status: RunResponseStatus;
  mode: string;
  request: Record<string, unknown>;
  message: string;
  followUp: string;
  reason: string;
  next_steps: string[];
  clarification: ClarificationPrompt | null;
  blockPlan: BlockPlan | null;
  plan: StudyPlanPayload | null;
  /**
   * 长期计划（v2 三层计划）。
   * 仅当目标跨度超过一周时产出；纯一周内的目标保持为 undefined，旧行为不变。
   */
  longPlan?: LongTermPlan | null;
  memory_used: FrontendMemory[];
  memory_candidates: Record<string, unknown>[];
  model_provider: string;
  model_used: string;
  is_fallback: boolean;
  error_message: string;
}

export interface PlanProgressUpdateRequest {
  user_id: string;
  conversation_id: string;
  plan_id: string;
  plan_version: number | null;
  task_key: string;
  done: boolean;
  task_title: string;
  task_type: string;
  actual_minutes: number;
  plan_message: string;
  /** 任务所属科目（v2 可选）。用于完成学习类任务后自动进入复习队列。 */
  subject?: string;
}

/** 通用响应包装（对应 FastAPI ApiResponse）。timestamp 由壳层在传输时填充。 */
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T | null;
}

export function apiOk<T>(data: T, message = "ok"): ApiResponse<T> {
  return { success: true, message, data };
}

export function apiFail<T = never>(message: string): ApiResponse<T> {
  return { success: false, message, data: null };
}
