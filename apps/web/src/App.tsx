import { useCallback, useEffect, useState } from 'react'
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

export default function App() {
  const [ready, setReady] = useState(false)
  const [onboarded, setOnboarded] = useState(() => isOnboarded())
  const [view, setView] = useState<View>('chat')
  const [conversationId, setConversationId] = useState('')
  const [conversations, setConversations] = useState<ConversationCard[]>([])
  const [profileName, setProfileName] = useState('')

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
    <div className="app-shell">
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
      <main className="app-main">
        {view === 'chat' && (
          <ChatView conversationId={conversationId} onChangeConversation={setConversationId} />
        )}
        {view === 'plan' && <PlanView />}
        {view === 'mine' && <MineView onOpenGraph={() => setView('graph')} />}
        {view === 'graph' && <GraphView onBack={() => setView('mine')} />}
        {view === 'documents' && <DocumentsView />}
        {view === 'timetable' && <TimetableView />}
        {view === 'assignments' && <AssignmentsView />}
      </main>
    </div>
  )
}
