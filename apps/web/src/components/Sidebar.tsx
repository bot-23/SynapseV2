import { useState } from 'react'
import type { ConversationCard } from '../utils/prefs'
import {
  newConversationId,
  removeConversationCard,
  touchConversationCard,
} from '../utils/prefs'
import { formatRelativeTime } from '../utils/format'
import { getCore } from '../services/synapse'

interface SidebarProps {
  view: 'chat' | 'plan' | 'mine' | 'documents' | 'timetable' | 'graph'
  profileName: string
  conversations: ConversationCard[]
  activeConversationId: string
  onNavigate: (view: SidebarProps['view']) => void
  onSelectConversation: (id: string) => void
  onNewConversation: () => void
  onChanged: () => void
}

const NAV_ITEMS: Array<{ key: Exclude<SidebarProps['view'], 'graph'>; label: string }> = [
  { key: 'chat', label: '对话' },
  { key: 'plan', label: '计划' },
  { key: 'documents', label: '资料库' },
  { key: 'timetable', label: '课程表' },
  { key: 'mine', label: '我的' },
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

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark">S</span>
          <strong>Synapse</strong>
        </div>
      </div>

      <button type="button" className="new-chat-button" onClick={startNew}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        新对话
      </button>

      <nav className="nav-items">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`nav-item${view === item.key ? ' active' : ''}`}
            onClick={() => onNavigate(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="history-section">
        <p>最近会话</p>
        {conversations.length === 0 ? (
          <div className="empty-history">还没有会话，点「新对话」开始</div>
        ) : (
          <nav>
            {conversations.map((item) => (
              <div
                key={item.id}
                className={`history-item${item.id === activeConversationId ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="history-select"
                  onClick={() => openConversation(item.id, item.title)}
                >
                  <span>{item.title}</span>
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
