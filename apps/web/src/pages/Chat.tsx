import { useCallback, useEffect, useRef, useState } from 'react'
import {
  autoSavePlan,
  buildRunPayload,
  changeSummaryOf,
  currentRuntimeMode,
  getCore,
} from '../services/synapse'
import {
  getLastConversationId,
  newConversationId,
  setLastConversationId,
  touchConversationCard,
} from '../utils/prefs'
import { localMessage, toChatMessages, type ChatMessageView } from '../utils/chatModel'
import PlanCard from '../components/PlanCard'
import BlockPlanCard from '../components/BlockPlanCard'
import ClarificationCard from '../components/ClarificationCard'
import type { BlockPlan, ClarificationAnswer, StudyPlanRequest } from '@synapse/core'

const SUGGESTIONS = [
  '帮我准备高等数学和大学物理期末考试，每天能学 90 分钟',
  '我想提升英语四级词汇和阅读，前提是每天只有 45 分钟',
  '两周内完成操作系统课程实验报告',
]

interface ChatViewProps {
  conversationId: string
  onChangeConversation: (id: string) => void
}

export default function ChatView({ conversationId, onChangeConversation }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessageView[]>([])
  const [input, setInput] = useState('')
  const [planningMode, setPlanningMode] = useState<'free' | 'blocks'>('free')
  const [sending, setSending] = useState(false)
  const [runtime, setRuntime] = useState(currentRuntimeMode())
  const [assignmentHint, setAssignmentHint] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadMessages = useCallback((convId: string) => {
    if (!convId) {
      setMessages([])
      return
    }
    const result = getCore().getMessages(convId)
    const list = toChatMessages((result.data ?? []) as Array<Record<string, unknown>>)
    setMessages(list)
    console.log('[Synapse] 载入会话消息', convId, list.length)
  }, [])

  // 跟随 conversationId：新建会话（空 id）则从最近会话回填
  useEffect(() => {
    setRuntime(currentRuntimeMode())
    if (!conversationId) {
      const last = getLastConversationId()
      if (last) {
        onChangeConversation(last)
      } else {
        setMessages([])
      }
      return
    }
    setLastConversationId(conversationId)
    loadMessages(conversationId)
  }, [conversationId, loadMessages, onChangeConversation])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, sending])

  const afterResponse = useCallback(
    (response: Parameters<typeof autoSavePlan>[0], activeId?: string) => {
      const saved = autoSavePlan(response, changeSummaryOf(response))
      if (saved.saved) {
        console.log('[Synapse] 计划已自动保存', saved.message)
      }
      // 作业式计划：不覆盖短期计划，只在对话里给出跳转提示，明细看「作业」页
      const assignment = response.assignment
      setAssignmentHint(
        assignment && assignment.total > 0
          ? `作业已排进日程：共 ${assignment.total} 条，待办 ${assignment.pending_count} 条、逾期 ${assignment.overdue_count} 条。到「作业」页可以看排期和打卡。`
          : '',
      )
      const target = activeId ?? conversationId
      if (target) {
        loadMessages(target)
      }
    },
    [conversationId, loadMessages],
  )

  const send = async (rawText?: string) => {
    const text = (rawText ?? input).trim()
    if (!text || sending) {
      return
    }
    // 首次发送自动建会话，避免首屏建议按钮/输入因无会话而失效
    const activeId = conversationId || newConversationId()
    if (!conversationId) {
      onChangeConversation(activeId)
    }
    // 记录会话卡片标题（首句作为标题）
    touchConversationCard(activeId, messages.length === 0 ? text : undefined)
    setSending(true)
    setInput('')
    const localId = `local-${Date.now()}`
    setMessages((prev) => [...prev, localMessage(localId, 'user', text)])
    console.log('[Synapse] run', planningMode, activeId, text)
    try {
      const response = await getCore().run(buildRunPayload(text, activeId, planningMode))
      console.log('[Synapse] run 完成', response.status, response.mode)
      afterResponse(response, activeId)
    } catch (error) {
      console.error('[Synapse] run 失败', error)
      setMessages((prev) => prev.filter((message) => message.id !== localId))
      setInput(text)
      alert('请求失败，已保留你的输入')
    } finally {
      setSending(false)
    }
  }

  const submitClarification = async (sessionId: string, answers: ClarificationAnswer[]) => {
    if (sending) {
      return
    }
    setSending(true)
    try {
      const response = await getCore().confirm({ sessionId, answers, conversationId })
      console.log('[Synapse] confirm 完成', response.mode)
      afterResponse(response)
    } catch (error) {
      console.error('[Synapse] confirm 失败', error)
      alert('提交失败，请重试')
    } finally {
      setSending(false)
    }
  }

  const expand = async (message: ChatMessageView, blockPlan: BlockPlan) => {
    if (sending || !message.normalized) {
      alert('这次积木计划的上下文已失效，请重新发起')
      return
    }
    setSending(true)
    try {
      const response = await getCore().expandBlocks(
        message.normalized as StudyPlanRequest,
        blockPlan,
        conversationId,
      )
      console.log('[Synapse] expand 完成', response.mode)
      afterResponse(response)
    } catch (error) {
      console.error('[Synapse] expand 失败', error)
      alert('展开失败，请重试')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="chat-area">
      <header className="chat-header">
        <h1>学习陪伴</h1>
        <div className={`status-chip${runtime.isFallback ? '' : ' active'}`}>
          <i />
          {runtime.isFallback ? '本地规则模式' : `已连接 ${runtime.model}`}
        </div>
      </header>

      <div className="messages" ref={scrollRef}>
        <div className="message-stream">
          {messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-title">今天想推进什么？</div>
              <div className="welcome-desc">
                告诉我科目、截止时间和每天可用时长。我会先补齐关键信息，再给出可按科目执行的周计划。
              </div>
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="suggestion"
                  onClick={() => send(text)}
                >
                  <span className="suggestion-text">{text}</span>
                  <span className="suggestion-arrow">›</span>
                </button>
              ))}
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`message-row ${message.role === 'user' ? 'user' : 'assistant'}`}
            >
              {message.role === 'assistant' && (
                <div className="message-content">
                  {message.content && (
                    <div className="message-bubble">
                      <span className="ai-badge">AI 生成</span>
                      {message.content}
                    </div>
                  )}

                  {message.clarification && (
                    <ClarificationCard
                      clarification={message.clarification}
                      submitting={sending}
                      onSubmit={(answers) =>
                        submitClarification(message.clarification!.sessionId, answers)
                      }
                    />
                  )}

                  {message.blockPlan && (
                    <BlockPlanCard
                      blockPlan={message.blockPlan}
                      expanding={sending}
                      onExpand={(plan) => expand(message, plan)}
                    />
                  )}

                  {message.weeklyPlan.length > 0 && (
                    <PlanCard
                      weeklyPlan={message.weeklyPlan}
                      retrievedContext={message.retrievedContext}
                      request={message.normalized}
                      reason={message.reason}
                    />
                  )}
                </div>
              )}

              {message.role === 'user' && (
                <div className="message-content">
                  <div className="message-bubble user">{message.content}</div>
                </div>
              )}
            </div>
          ))}

          {sending && (
            <div className="message-row assistant">
              <div className="message-content">
                <div className="message-bubble">正在回复…</div>
              </div>
            </div>
          )}

          {!sending && assignmentHint && (
            <div className="message-row assistant">
              <div className="message-content">
                <div className="assignment-hint">{assignmentHint}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <div className="planning-mode-switch">
            <button
              type="button"
              className={planningMode === 'free' ? 'active' : ''}
              onClick={() => setPlanningMode('free')}
            >
              自由
            </button>
            <button
              type="button"
              className={planningMode === 'blocks' ? 'active' : ''}
              onClick={() => setPlanningMode('blocks')}
            >
              积木
            </button>
          </div>
          <textarea
            placeholder="说说你的学习目标…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            type="button"
            className="send-button"
            disabled={sending || !input.trim()}
            onClick={() => send()}
          >
            发送
          </button>
        </div>
        <div className="composer-footer">
          <span />
          <span className="composer-hint">
            {runtime.isFallback
              ? '本地规则模式：未配置 Key，按确定性算法生成计划'
              : '已连接 DeepSeek'}
          </span>
        </div>
      </div>
    </div>
  )
}