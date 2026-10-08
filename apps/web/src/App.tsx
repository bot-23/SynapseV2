import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getCore, initCore, getActiveUserId } from './services/synapse'
import { isOnboarded, markOnboarded, listConversationCards, getLastConversationId } from './utils/prefs'
import Sidebar from './components/Sidebar'
import ChatView from './pages/Chat'
import Onboarding from './pages/Onboarding'
import type { ConversationCard } from './utils/prefs'

// 首屏只需要「对话」与「引导页」，其余页面按需加载（各自成独立 chunk）。
// 这样主包不必为了用户可能永远不打开的页面先付体积。
const PlanView = lazy(() => import('./pages/Plan'))
const MineView = lazy(() => import('./pages/Mine'))
const DocumentsView = lazy(() => import('./pages/Documents'))
const TimetableView = lazy(() => import('./pages/Timetable'))
const GraphView = lazy(() => import('./pages/Graph'))
const AssignmentsView = lazy(() => import('./pages/Assignments'))
const ErrorsView = lazy(() => import('./pages/Errors'))

type View = 'chat' | 'plan' | 'mine' | 'documents' | 'timetable' | 'graph' | 'assignments' | 'errors'

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
  /** 拖拽过程中的宽度：期间只改 DOM，松手才写回 state */
  const dragWidth = useRef(sidebarWidth)
  const shellRef = useRef<HTMLDivElement>(null)

  // 初始化核心：存储是异步后端（IndexedDB），必须等内存镜像装好再渲染，否则首屏读到空
  useEffect(() => {
    let cancelled = false
    void initCore()
      .then(() => {
        if (cancelled) return
        setReady(true)
        // F：到期复习提醒（Web Notification）。全程容错，任何异常都吞掉，绝不阻塞启动。
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const result = getCore().listReviews(getActiveUserId())
            const data = (result.data ?? {}) as Record<string, unknown>
            const dueCount = Number(data['due_count'] ?? 0)
            const today = String(data['today'] ?? '')
            if (dueCount > 0 && today) {
              const key = `synapse.notified.${today}`
              if (!localStorage.getItem(key)) {
                new Notification(`今天有 ${dueCount} 个知识点到期复习`)
                localStorage.setItem(key, '1')
              }
            }
          }
        } catch (error) {
          console.error('[Synapse] 到期提醒失败', error)
        }
      })
      .catch((error) => {
        // initCore 内部已有降级，这里只兜底：宁可进应用，也不要卡在启动页
        console.error('[Synapse] core 初始化失败', error)
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
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
    const profile = getCore().getProfile(getActiveUserId()).data as Record<string, unknown> | null
    setProfileName(String(profile?.['display_name'] ?? '').trim())
  }, [ready, onboarded, view])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  // 宽度统一从这里落到 DOM（而不是走 style prop）：拖拽期间直接改这个 CSS 变量，
  // React 不参与，就不会被重渲染覆盖回旧值。
  useLayoutEffect(() => {
    shellRef.current?.style.setProperty('--sidebar-width', `${sidebarWidth}px`)
  }, [sidebarWidth])

  // 拖拽用指针捕获实现：按下时接管指针，移动/松手都落在手柄自己身上，
  // 不用给 window 挂全局监听。拖拽期间给 body 加类，锁住光标与文本选择。
  const startResizing = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    resizing.current = true
    dragWidth.current = sidebarWidth
    document.body.classList.add('sidebar-resizing')
  }

  // 拖动过程中只更新 DOM 上的 CSS 变量，不进 React state：
  // 否则每个 pointermove 都会重渲染 App 及其当前子页，长会话/大列表时明显卡顿。
  const handleResizing = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizing.current) {
      const width = clampSidebarWidth(event.clientX)
      dragWidth.current = width
      shellRef.current?.style.setProperty('--sidebar-width', `${width}px`)
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
    // 松手时才把最终宽度同步回 state（也顺带触发持久化）
    setSidebarWidth(dragWidth.current)
  }

  const handleOnboarded = () => {
    markOnboarded()
    setOnboarded(true)
    refreshConversations()
  }

  if (!ready) {
    return (
      <div className="boot-splash">
        <span>正在准备工作台…</span>
      </div>
    )
  }

  if (!onboarded) {
    return <Onboarding onComplete={handleOnboarded} />
  }

  return (
    <div className="app-shell" ref={shellRef}>
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
        <Suspense fallback={<div className="page-loading">正在加载…</div>}>
          {view === 'chat' && (
            <ChatView conversationId={conversationId} onChangeConversation={setConversationId} />
          )}
          {view === 'plan' && <PlanView />}
          {view === 'mine' && <MineView onNavigate={(target) => setView(target)} />}
          {view === 'graph' && <GraphView onBack={() => setView('mine')} />}
          {view === 'documents' && <DocumentsView />}
          {view === 'timetable' && <TimetableView />}
          {view === 'assignments' && <AssignmentsView />}
          {view === 'errors' && <ErrorsView />}
        </Suspense>
      </main>
    </div>
  )
}
