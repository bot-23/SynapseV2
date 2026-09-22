/**
 * 会话消息视图模型：把 core 落库的 MessageRecord 还原成可渲染的卡片结构。
 * 界面完全以存储为准，避免「界面显示」与「模型看到的历史」不一致。
 */

import type { BlockPlan, ClarificationPrompt, StudyDayPlan, StudyPlanRequest } from '../vendor/core'

export interface ChatMessageView {
  id: string
  role: 'user' | 'assistant'
  content: string
  weeklyPlan: StudyDayPlan[]
  retrievedContext: string[]
  blockPlan: BlockPlan | null
  clarification: ClarificationPrompt | null
  normalized: StudyPlanRequest | null
  createdAt: string
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as T
    return value ?? null
  } catch (error) {
    console.error('[ChatModel] JSON 解析失败', error)
    return null
  }
}

/** 本地回显用的一条消息（此时还没落库，所以只有最小字段）。 */
export function localMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string
): ChatMessageView {
  return {
    id,
    role,
    content,
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
      weeklyPlan: planData?.weekly_plan ?? [],
      retrievedContext: planData?.retrieved_context ?? [],
      blockPlan: context?.blockPlan ?? null,
      clarification: context?.clarification ?? null,
      normalized: context?.normalized ?? null,
      createdAt: String(record['created_at'] ?? '')
    }
  })
}
