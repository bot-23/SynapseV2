import { useEffect, useState } from 'react'
import type { ConversationCard } from '../utils/prefs'
import {
  newConversationId,
  removeConversationCard,
  touchConversationCard,
} from '../utils/prefs'
import { formatRelativeTime } from '../utils/format'
import { getCore, getActiveUserId } from '../services/synapse'

interface SidebarProps {
  view: 'chat' | 'plan' | 'mine' | 'documents' | 'timetable' | 'graph' | 'assignments' | 'errors'
  profileName: string
  conversations: ConversationCard[]
  activeConversationId: string
  onNavigate: (view: SidebarProps['view']) => void
  onSelectConversation: (id: string) => void
  onNewConversation: () => void
  onChanged: () => void
}

const NAV_ITEMS: Array<{ key: Exclude<SidebarProps['view'], 'graph'>; label: string; icon: string }> = [
  { key: 'chat', label: '对话', icon: 'M20 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 20l.9-4A8.5 8.5 0 1 1 20 11.5Z' },
  { key: 'plan', label: '计划', icon: 'M8 3v3m8-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3 9 2 2 4-4' },
  { key: 'assignments', label: '作业', icon: 'M8 4h8l1 2h3v14H4V6h3l1-2Zm1 7h6m-6 4h6' },
  { key: 'documents', label: '资料库', icon: 'M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm9 0v5h4M8 12h8m-8 4h8' },
  { key: 'errors', label: '错题', icon: 'M12 9v4m0 4h.01M10.3 3.6 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z' },
  { key: 'timetable', label: '课程表', icon: 'M4 5h16v15H4V5Zm0 5h16M9 5v15m6-10v10' },
  { key: 'mine', label: '我的', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8a8 8 0 0 1 16 0H4Z' },
]

export default function Sidebar({
  view,
  profileName,
  conversations,
  activeConversationId,
  onNavigate,
  onSelectConversation,
  onNewConversation,
  onChanged,
}: SidebarProps) {
  const [confirmDelete, setConfirmDelete] = useState('')
  /** 会话搜索：关键词、命中的会话 id（null 表示未搜索）、正文命中的片段。 */
  const [query, setQuery] = useState('')
  const [matchedIds, setMatchedIds] = useState<string[] | null>(null)
  const [snippets, setSnippets] = useState<Record<string, string>>({})
  const [searchNotice, setSearchNotice] = useState('')

  // 输入后 200ms 再查，避免每敲一个字都跑一次检索
  useEffect(() => {
    const keyword = query.trim()
    if (!keyword) {
      setMatchedIds(null)
      setSnippets({})
      setSearchNotice('')
      return
    }
    const timer = window.setTimeout(() => {
      const result = getCore().searchAll(getActiveUserId(), keyword, 20)
      if (!result.success) {
        setMatchedIds([])
        setSnippets({})
        setSearchNotice(result.message)
        return
      }
      const data = (result.data ?? {}) as Record<string, unknown>
      const hits = (data['conversations'] ?? []) as Array<{ id: string; snippet: string }>
      const nextSnippets: Record<string, string> = {}
      for (const hit of hits) {
        if (hit.snippet) {
          nextSnippets[hit.id] = hit.snippet
        }
      }
      setMatchedIds(hits.map((hit) => hit.id))
      setSnippets(nextSnippets)
      setSearchNotice('')
    }, 200)
    return () => window.clearTimeout(timer)
  }, [query])

  const startNew = () => {
    const id = newConversationId()
    touchConversationCard(id)
    onNewConversation()
    onChanged()
  }

  const openConversation = (id: string, title: string) => {
    touchConversationCard(id, title)
    onSelectConversation(id)
    onChanged()
  }

  const deleteConversation = (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      return
    }
    getCore().deleteConversation(id)
    setConfirmDelete('')
    onChanged()
    if (activeConversationId === id) {
      onNewConversation()
    }
    // 清理会话卡片元数据（保留消息由 deleteConversation 清理）
    removeConversationCard(id)
  }

  const searching = query.trim().length > 0
  // 未搜索（matchedIds 为 null）时展示传入的完整列表，否则按命中的 id 过滤
  const matchedSet = matchedIds ? new Set(matchedIds) : null
  const visibleConversations = matchedSet
    ? conversations.filter((item) => matchedSet.has(item.id))
    : conversations

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark">
            <img src="/icon.png" alt="" width="32" height="32" />
          </span>
          <span className="brand-copy">
            <strong>Synapse</strong>
            <small>你的学习工作台</small>
          </span>
        </div>
      </div>

      <button type="button" className="new-chat-button" onClick={startNew}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        新对话
      </button>

      <p className="sidebar-label">工作空间</p>
      <nav className="nav-items" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`nav-item${view === item.key ? ' active' : ''}`}
            onClick={() => onNavigate(item.key)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={item.icon} />
            </svg>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="history-section">
        <p>最近会话</p>
        <input
          className="search-input history-search"
          placeholder="搜索会话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching && searchNotice ? (
          <div className="history-note">{searchNotice}</div>
        ) : visibleConversations.length === 0 ? (
          <div className="empty-history">
            {searching ? '没有匹配结果' : '还没有会话，点「新对话」开始'}
          </div>
        ) : (
          <nav>
            {visibleConversations.map((item) => (
              <div
                key={item.id}
                className={`history-item${item.id === activeConversationId ? ' active' : ''}${
                  snippets[item.id] ? ' has-snippet' : ''
                }`}
              >
                <button
                  type="button"
                  className="history-select"
                  onClick={() => openConversation(item.id, item.title)}
                >
                  <span>{item.title}</span>
                  {!!snippets[item.id] && (
                    <span className="history-snippet">{snippets[item.id]}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="history-delete"
                  onClick={() => deleteConversation(item.id)}
                  title={confirmDelete === item.id ? '再次点击确认删除' : '删除会话'}
                >
                  {confirmDelete === item.id ? '确认' : '✕'}
                </button>
              </div>
            ))}
          </nav>
        )}
      </div>

      <div className="account-panel">
        <span className="account-avatar">{profileName ? profileName.slice(0, 1) : 'S'}</span>
        <div className="account-copy">
          <strong>{profileName || '同学'}</strong>
          <span>{formatRelativeTime(new Date().toISOString()) === '' ? '已就绪' : 'Web 端'}</span>
        </div>
      </div>
    </aside>
  )
}
