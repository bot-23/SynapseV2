import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { getCore, DEFAULT_USER_ID } from './services/synapse'
import { isOnboarded, markOnboarded, listConversationCards, getLastConversationId } from './utils/prefs'
import Sidebar from './components/Sidebar'
import ChatView from './pages/Chat'
import PlanView from './pages/Plan'
import MineView from './pages/Mine'
import DocumentsView from './pages/Documents'
import TimetableView from './pages/Timetable'
import Onboarding from './pages/Onboarding'
import GraphView from './pages/Graph'
import AssignmentsView from './pages/Assignments'
import type { ConversationCard } from './utils/prefs'

type View = 'chat' | 'plan' | 'mine' | 'documents' | 'timetable' | 'graph' | 'assignments'

const SIDEBAR_WIDTH_KEY = 'synapse.sidebarWidth'
const SIDEBAR_WIDTH_DEFAULT = 252
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 420
const SIDEBAR_WIDTH_STEP = 16

function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)))
}

function readSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_WIDTH_DEFAULT
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [onboarded, setOnboarded] = useState(() => isOnboarded())
  const [view, setView] = useState<View>('chat')
  const [conversationId, setConversationId] = useState('')
  const [conversations, setConversations] = useState<ConversationCard[]>([])
  const [profileName, setProfileName] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const resizing = useRef(false)

  // 初始化核心：任何渲染前都先启动 core（浏览器 localStorage 适配器）
  useEffect(() => {
    getCore()
    setReady(true)
  }, [])

  const refreshConversations = useCallback(() => {
    setConversations(listConversationCards())
    setConversationId((prev) => prev || getLastConversationId())
  }, [])

  useEffect(() => {
    if (onboarded) {
      refreshConversations()
    }
  }, [onboarded, refreshConversations])

  // 会话切换/首次自动建会话后，刷新侧边栏会话清单
  useEffect(() => {
    if (onboarded && conversationId) {
      refreshConversations()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, onboarded])

  useEffect(() => {
    if (!ready || !onboarded) {
      return
    }
    const profile = getCore().getProfile(DEFAULT_USER_ID).data as Record<string, unknown> | null
    setProfileName(String(profile?.['display_name'] ?? '').trim())
  }, [ready, onboarded, view])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  // 拖拽用指针捕获实现：按下时接管指针，移动/松手都落在手柄自己身上，
  // 不用给 window 挂全局监听。拖拽期间给 body 加类，锁住光标与文本选择。
  const startResizing = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    resizing.current = true
    document.body.classList.add('sidebar-resizing')
  }

  const handleResizing = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizing.current) {
      setSidebarWidth(clampSidebarWidth(event.clientX))
    }
  }

  const stopResizing = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing.current) {
      return
    }
    resizing.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('sidebar-resizing')
  }

  const handleOnboarded = () => {
    markOnboarded()
    setOnboarded(true)
    refreshConversations()
  }

  if (!ready) {
    return null
  }

  if (!onboarded) {
    return <Onboarding onComplete={handleOnboarded} />
  }

  return (
    <div className="app-shell" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <Sidebar
        view={view}
        profileName={profileName}
        conversations={conversations}
        activeConversationId={conversationId}
        onNavigate={(next) => setView(next)}
        onSelectConversation={(id) => {
          setConversationId(id)
          setView('chat')
        }}
        onNewConversation={() => {
          setConversationId('')
          setView('chat')
        }}
        onChanged={() => refreshConversations()}
      />
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度，双击复位"
        aria-valuenow={sidebarWidth}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        tabIndex={0}
        onPointerDown={startResizing}
        onPointerMove={handleResizing}
        onPointerUp={stopResizing}
        onPointerCancel={stopResizing}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            setSidebarWidth((width) => clampSidebarWidth(width - SIDEBAR_WIDTH_STEP))
          } else if (event.key === 'ArrowRight') {
            setSidebarWidth((width) => clampSidebarWidth(width + SIDEBAR_WIDTH_STEP))
          } else if (event.key === 'Home') {
            setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
          }
        }}
      />
      <main className="app-main">
        {view === 'chat' && (
          <ChatView conversationId={conversationId} onChangeConversation={setConversationId} />
        )}
        {view === 'plan' && <PlanView />}
        {view === 'mine' && <MineView onNavigate={(target) => setView(target)} />}
        {view === 'graph' && <GraphView onBack={() => setView('mine')} />}
        {view === 'documents' && <DocumentsView />}
        {view === 'timetable' && <TimetableView />}
        {view === 'assignments' && <AssignmentsView />}
      </main>
    </div>
  )
}
