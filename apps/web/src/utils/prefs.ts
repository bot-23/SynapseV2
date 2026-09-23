/**
 * 本地偏好（壳层私有，不进入 core）：引导完成标记、最近使用的会话。
 * 在浏览器用 localStorage（与 KvStore 键空间分开，避免污染 core 数据）。
 */

import { browserIdGen } from '../adapters/system'

const KEY_ONBOARDED = 'synapse.web:onboarded'
const KEY_LAST_CONVERSATION = 'synapse.web:lastConversationId'
const SESSION_PREFIX = 'synapse.web:session:'

export function isOnboarded(): boolean {
  return window.localStorage.getItem(KEY_ONBOARDED) === '1'
}

export function markOnboarded(): void {
  window.localStorage.setItem(KEY_ONBOARDED, '1')
}

export function getLastConversationId(): string {
  return window.localStorage.getItem(KEY_LAST_CONVERSATION) || ''
}

export function setLastConversationId(conversationId: string): void {
  window.localStorage.setItem(KEY_LAST_CONVERSATION, conversationId)
}

/**
 * 会话清单（壳层私有的会话「卡片」：标题、时间、排序）。
 * 实际消息由 core 存进 KvStore（messages:{id}）；这里只记录会话元信息用于侧边栏。
 */
export interface ConversationCard {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export function listConversationCards(): ConversationCard[] {
  const cards: ConversationCard[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key && key.startsWith(SESSION_PREFIX)) {
      try {
        const value = JSON.parse(window.localStorage.getItem(key) || '{}') as Partial<ConversationCard>
        cards.push({
          id: value.id ?? key.slice(SESSION_PREFIX.length),
          title: value.title ?? '新对话',
          createdAt: value.createdAt ?? '',
          updatedAt: value.updatedAt ?? '',
        })
      } catch {
        /* 跳过损坏条目 */
      }
    }
  }
  return cards.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function touchConversationCard(id: string, title?: string): void {
  const now = new Date().toISOString()
  const existing = readCard(id)
  const card: ConversationCard = {
    id,
    title: title || existing?.title || '新对话',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  window.localStorage.setItem(`${SESSION_PREFIX}${id}`, JSON.stringify(card))
}

export function removeConversationCard(id: string): void {
  window.localStorage.removeItem(`${SESSION_PREFIX}${id}`)
}

export function newConversationId(): string {
  return browserIdGen.next()
}

function readCard(id: string): ConversationCard | null {
  try {
    const raw = window.localStorage.getItem(`${SESSION_PREFIX}${id}`)
    return raw ? (JSON.parse(raw) as ConversationCard) : null
  } catch {
    return null
  }
}