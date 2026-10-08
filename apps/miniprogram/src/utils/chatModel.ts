/**
 * 会话消息视图模型：把 core 落库的 MessageRecord 还原成可渲染的卡片结构。
 * 界面完全以存储为准，避免「界面显示」与「模型看到的历史」不一致。
 */

import type { BlockPlan, ClarificationPrompt, StudyDayPlan, StudyPlanRequest } from '../vendor/core'

export interface ChatMessageView {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 本轮带入的附件文件名（core 落库为 attachments_json），用于气泡上回显 */
  attachments: string[]
  /** 这条回复「为什么这么安排」（落库的 reason），G4.3 依据面板直接展示 */
  reason: string
  weeklyPlan: StudyDayPlan[]
  retrievedContext: string[]
  blockPlan: BlockPlan | null
  clarification: ClarificationPrompt | null
  normalized: StudyPlanRequest | null
  createdAt: string
}

function parseJson<T extends object>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as unknown
    // 只接受「纯对象」：本地存储被改写成数组/标量时不返回半成品
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null
  } catch (error) {
    console.error('[ChatModel] JSON 解析失败', error)
    return null
  }
}

/** 附件名列表：落库的是字符串数组，形状不对就当作没有附件。 */
function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) {
    return []
  }
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.map((item) => String(item)) : []
  } catch {
    return []
  }
}

/** 本地回显用的一条消息（此时还没落库，所以只有最小字段）。 */
export function localMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  attachments: string[] = []
): ChatMessageView {
  return {
    id,
    role,
    content,
    attachments,
    reason: '',
    weeklyPlan: [],
    retrievedContext: [],
    blockPlan: null,
    clarification: null,
    normalized: null,
    createdAt: new Date().toISOString()
  }
}

export function toChatMessages(records: Array<Record<string, unknown>>): ChatMessageView[] {
  return records.map((record) => {
    const planData = parseJson<{
      weekly_plan?: StudyDayPlan[]
      retrieved_context?: string[]
    }>(record['plan_data_json'])
    const context = parseJson<{
      blockPlan?: BlockPlan | null
      clarification?: ClarificationPrompt | null
      normalized?: StudyPlanRequest | null
      mode?: string
    }>(record['request_context_json'])

    return {
      id: String(record['id'] ?? ''),
      role: record['role'] === 'user' ? 'user' : 'assistant',
      content: String(record['content'] ?? ''),
      attachments: parseJsonArray(record['attachments_json']),
      reason: String(record['reason'] ?? ''),
      weeklyPlan: Array.isArray(planData?.weekly_plan) ? planData.weekly_plan : [],
      retrievedContext: Array.isArray(planData?.retrieved_context) ? planData.retrieved_context : [],
      blockPlan: context?.blockPlan ?? null,
      clarification: context?.clarification ?? null,
      normalized: context?.normalized ?? null,
      createdAt: String(record['created_at'] ?? '')
    }
  })
}
