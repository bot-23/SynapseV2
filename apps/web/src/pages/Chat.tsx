import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  autoSavePlan,
  buildRunPayload,
  changeSummaryOf,
  currentRuntimeMode,
  getCore,
  streamRun,
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
import type {
  BlockPlan,
  ClarificationAnswer,
  FrontendAttachment,
  StudyPilotRunResponse,
  StudyPlanRequest,
} from '@synapse/core'

const SUGGESTIONS = [
  '帮我准备高等数学和大学物理期末考试，每天能学 90 分钟',
  '我想提升英语四级词汇和阅读，前提是每天只有 45 分钟',
  '两周内完成操作系统课程实验报告',
]

/** 聊天附件：文本类 2MB、PDF 30MB，与资料库保持一致；一次最多带 3 份（core 只取前 3 份摘要）。 */
const MAX_ATTACH_SIZE = 2 * 1024 * 1024
const MAX_ATTACH_PDF_SIZE = 30 * 1024 * 1024
const MAX_ATTACH_COUNT = 3

interface ChatViewProps {
  conversationId: string
  onChangeConversation: (id: string) => void
}

/**
 * 单条消息行。用 memo 包起来：输入框每敲一个字只让 ChatView 重渲染，
 * 历史消息（往往还嵌着计划卡片）不用跟着重建。
 */
const MessageRow = memo(function MessageRow({
  message,
  sending,
  onClarification,
  onExpand,
}: {
  message: ChatMessageView
  sending: boolean
  onClarification: (sessionId: string, answers: ClarificationAnswer[]) => void
  onExpand: (message: ChatMessageView, blockPlan: BlockPlan) => void
}) {
  const clarification = message.clarification
  return (
    <div className={`message-row ${message.role === 'user' ? 'user' : 'assistant'}`}>
      {message.role === 'assistant' && (
        <div className="message-content">
          {message.content && (
            <div className="message-bubble">
              <span className="ai-badge">AI 生成</span>
              {message.content}
            </div>
          )}

          {clarification && (
            <ClarificationCard
              clarification={clarification}
              submitting={sending}
              onSubmit={(answers) => onClarification(clarification.sessionId, answers)}
            />
          )}

          {message.blockPlan && (
            <BlockPlanCard
              blockPlan={message.blockPlan}
              expanding={sending}
              onExpand={(plan) => onExpand(message, plan)}
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
          {message.attachments.length > 0 && (
            <div className="message-attachments">
              {message.attachments.map((name, index) => (
                <span key={`${message.id}-att-${index}`} className="attachment-chip">
                  {name}
                </span>
              ))}
            </div>
          )}
          {!!message.content && <div className="message-bubble user">{message.content}</div>}
        </div>
      )}
    </div>
  )
})

/**
 * 打字机气泡：逐字吐出由它自己的 state 驱动，父组件不参与。
 * 这样每 16ms 一次的进度更新只重渲染这一个气泡，不会牵着整条消息列表一起重渲染。
 */
function TypingBubble({
  text,
  onGrow,
  onDone,
}: {
  text: string
  onGrow: () => void
  onDone: () => void
}) {
  const [shown, setShown] = useState('')
  const onGrowRef = useRef(onGrow)
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onGrowRef.current = onGrow
    onDoneRef.current = onDone
  })

  useEffect(() => {
    if (!text) {
      setShown('')
      onDoneRef.current()
      return
    }
    // 步长按总长度折算，让长短回复的观感时长都落在 1.5–2 秒左右
    const step = Math.max(1, Math.ceil(text.length / 110))
    let count = 0
    setShown('')
    const timer = window.setInterval(() => {
      count = Math.min(text.length, count + step)
      setShown(text.slice(0, count))
      onGrowRef.current()
      if (count >= text.length) {
        window.clearInterval(timer)
        onDoneRef.current()
      }
    }, 16)
    return () => window.clearInterval(timer)
  }, [text])

  return (
    <div className="message-row assistant">
      <div className="message-content">
        <div className="message-bubble">
          <span className="ai-badge">AI 生成</span>
          {shown}
          <span className="typing-caret" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}

export default function ChatView({ conversationId, onChangeConversation }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessageView[]>([])
  const [input, setInput] = useState('')
  const [planningMode, setPlanningMode] = useState<'free' | 'blocks'>('free')
  const [sending, setSending] = useState(false)
  // 惰性初始化：不写函数的话，currentRuntimeMode() 每次渲染都会同步读一次 core
  const [runtime, setRuntime] = useState(() => currentRuntimeMode())
  const [assignmentHint, setAssignmentHint] = useState('')
  /** 流式等待时显示的进度标签（来自 core 的 stage 事件） */
  const [stageLabel, setStageLabel] = useState('')
  /** 正在逐字吐出的回复；空串表示不在打字 */
  const [streamText, setStreamText] = useState('')
  /** 本轮待发送的附件（已由 core 抽好文本） */
  const [attachments, setAttachments] = useState<FrontendAttachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** 打字完成时要 resolve 的 Promise（send 会 await 它） */
  const finishTypingRef = useRef<(() => void) | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  /** 结束打字：清空气泡并放行在等它的 send 流程（重复调用安全） */
  const finishTyping = useCallback(() => {
    setStreamText('')
    const resolve = finishTypingRef.current
    finishTypingRef.current = null
    resolve?.()
  }, [])

  /**
   * 打字机：把已经拿到的整段回复交给 TypingBubble 逐字显示。
   * 返回的 Promise 在吐完后 resolve，调用方 await 它就能在打字结束再切消息。
   */
  const typeOut = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        if (!text) {
          setStreamText('')
          resolve()
          return
        }
        finishTypingRef.current = resolve
        setStreamText(text)
      }),
    [],
  )

  // 卸载时放行还在等打字结果的流程，否则 send 会永远挂在 await 上
  useEffect(() => finishTyping, [finishTyping])

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

  // 新消息 / 发送状态变化时贴底；打字过程中的滚动由 TypingBubble 通过 onGrow
  // 直接驱动，不再依赖逐字变化的草稿，避免这个 effect 每帧跑一次
  useEffect(() => {
    scrollToBottom()
  }, [messages.length, sending, scrollToBottom])

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

  /**
   * 选附件：复用资料库那条 FileExtractor 链路（core.extractFiles）先把文本抽出来，
   * 抽好的 FrontendAttachment 随本轮请求带进 core，core 会顺带落库成资料。
   * 一律按原始字节读：txt 可能是 GBK，core 的解码链能识别，用 text() 会先被强转 UTF-8。
   */
  const pickAttachments = async (files: FileList | null) => {
    if (!files || !files.length || attaching) {
      return
    }
    setAttaching(true)
    const accepted: FrontendAttachment[] = []
    const failed: string[] = []
    try {
      for (const file of Array.from(files)) {
        if (attachments.length + accepted.length >= MAX_ATTACH_COUNT) {
          failed.push(`${file.name}（一次最多带 ${MAX_ATTACH_COUNT} 份）`)
          continue
        }
        const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
        const limit = pdf ? MAX_ATTACH_PDF_SIZE : MAX_ATTACH_SIZE
        if (file.size > limit) {
          failed.push(`${file.name}（超过 ${Math.round(limit / 1024 / 1024)}MB）`)
          continue
        }
        try {
          const data = new Uint8Array(await file.arrayBuffer())
          const extracted = await getCore().extractFiles([
            {
              name: file.name,
              contentType: file.type || (pdf ? 'application/pdf' : 'text/plain'),
              data,
            },
          ])
          const attachment = extracted[0]
          if (!attachment || attachment.extraction_status !== 'done' || !attachment.extracted_text) {
            failed.push(`${file.name}（${attachment?.extraction_error || '没有提取到文本'}）`)
            continue
          }
          accepted.push(attachment)
        } catch {
          failed.push(`${file.name}（读取失败）`)
        }
      }
    } finally {
      setAttaching(false)
    }
    if (accepted.length) {
      setAttachments((prev) => [...prev, ...accepted])
    }
    if (failed.length) {
      alert(`这些附件没加上：${failed.join('；')}`)
    }
  }

  const send = async (rawText?: string) => {
    const text = (rawText ?? input).trim()
    if ((!text && !attachments.length) || sending) {
      return
    }
    const sentAttachments = attachments
    // 首次发送自动建会话，避免首屏建议按钮/输入因无会话而失效
    const activeId = conversationId || newConversationId()
    if (!conversationId) {
      onChangeConversation(activeId)
    }
    // 记录会话卡片标题（首句作为标题）
    touchConversationCard(activeId, messages.length === 0 ? text : undefined)
    setSending(true)
    setInput('')
    setAttachments([])
    setStageLabel('')
    setStreamText('')
    const localId = `local-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      localMessage(
        localId,
        'user',
        text,
        sentAttachments.map((item) => item.name),
      ),
    ])
    // 只记录长度，不把用户输入原文写进控制台（隐私）
    console.log('[Synapse] runStream', planningMode, activeId, text.length, sentAttachments.length)
    try {
      // core 的流式入口：先给 stage 进度，最后一条 done 带完整结果
      let response: StudyPilotRunResponse | undefined
      for await (const event of streamRun(
        buildRunPayload(text, activeId, planningMode, sentAttachments),
      )) {
        if (event.type === 'stage') {
          setStageLabel(event.label)
          continue
        }
        response = event.result
      }
      if (!response) {
        throw new Error('流式响应没有返回结果')
      }
      console.log('[Synapse] runStream 完成', response.status, response.mode)
      await typeOut(response.message || '')
      setStageLabel('')
      afterResponse(response, activeId)
    } catch (error) {
      console.error('[Synapse] runStream 失败', error)
      setStreamText('')
      setStageLabel('')
      setMessages((prev) => prev.filter((message) => message.id !== localId))
      setInput(text)
      alert('请求失败，已保留你的输入')
    } finally {
      setSending(false)
    }
  }

  const submitClarification = useCallback(
    async (sessionId: string, answers: ClarificationAnswer[]) => {
      if (sending) {
        return
      }
      setSending(true)
      setStageLabel('')
      setStreamText('')
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
    },
    [sending, conversationId, afterResponse],
  )

  const expand = useCallback(
    async (message: ChatMessageView, blockPlan: BlockPlan) => {
      if (sending || !message.normalized) {
        alert('这次积木计划的上下文已失效，请重新发起')
        return
      }
      setSending(true)
      setStageLabel('')
      setStreamText('')
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
    },
    [sending, conversationId, afterResponse],
  )

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
            <MessageRow
              key={message.id}
              message={message}
              sending={sending}
              onClarification={submitClarification}
              onExpand={expand}
            />
          ))}

          {sending &&
            (streamText ? (
              <TypingBubble text={streamText} onGrow={scrollToBottom} onDone={finishTyping} />
            ) : (
              <div className="message-row assistant">
                <div className="message-content">
                  <div className="message-bubble message-stage">
                    <span className="stage-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    {stageLabel || '正在准备…'}
                  </div>
                </div>
              </div>
            ))}

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
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((item) => (
              <span key={item.id ?? item.name} className="attachment-chip removable">
                {item.name}
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`移除 ${item.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((one) => one !== item))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
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
          <button
            type="button"
            className="attach-button"
            title="添加资料（txt / md / pdf，最多 3 份）"
            disabled={sending || attaching || attachments.length >= MAX_ATTACH_COUNT}
            onClick={() => fileInputRef.current?.click()}
          >
            {attaching ? '解析中…' : '＋资料'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="chat-attach-input"
            multiple
            accept=".txt,.md,.markdown,.pdf"
            style={{ display: 'none' }}
            onChange={(event) => {
              void pickAttachments(event.target.files)
              // 清空 value，否则同一个文件连选两次不触发 change
              event.target.value = ''
            }}
          />
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
            disabled={sending || (!input.trim() && !attachments.length)}
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