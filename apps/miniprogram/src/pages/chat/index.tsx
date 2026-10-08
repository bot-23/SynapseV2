import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import classnames from 'classnames'
import {
  autoSavePlan,
  buildRunPayload,
  changeSummaryOf,
  currentRuntimeMode,
  getCore,
  streamRun
} from '../../services/synapse'
import { getLastConversationId, setLastConversationId } from '../../utils/prefs'
import { localMessage, toChatMessages, type ChatMessageView } from '../../utils/chatModel'
import { taroIdGen } from '../../adapters/system'
import PlanCard from '../../components/PlanCard'
import BlockPlanCard from '../../components/BlockPlanCard'
import ClarificationCard from '../../components/ClarificationCard'
import type {
  BlockPlan,
  ClarificationAnswer,
  FrontendAttachment,
  StudyPilotRunResponse,
  StudyPlanRequest
} from '../../vendor/core'
import styles from './index.module.scss'

const SUGGESTIONS = [
  '帮我准备高等数学和大学物理期末考试，每天能学 90 分钟',
  '我想提升英语四级词汇和阅读，前提是每天只有 45 分钟',
  '两周内完成操作系统课程实验报告'
]

/** 聊天附件：文本类 2MB、PDF 30MB，与资料库保持一致；一次最多带 3 份（core 只取前 3 份摘要）。 */
const MAX_ATTACH_SIZE = 2 * 1024 * 1024
const MAX_ATTACH_PDF_SIZE = 30 * 1024 * 1024
const MAX_ATTACH_COUNT = 3

export default function ChatPage() {
  const router = useRouter()
  const [conversationId, setConversationId] = useState('')
  const [messages, setMessages] = useState<ChatMessageView[]>([])
  const [input, setInput] = useState('')
  const [planningMode, setPlanningMode] = useState<'free' | 'blocks'>('free')
  const [sending, setSending] = useState(false)
  const [runtime, setRuntime] = useState(currentRuntimeMode())
  /** 流式等待时显示的进度标签（来自 core 的 stage 事件） */
  const [stageLabel, setStageLabel] = useState('')
  /** 打字机正在逐字吐出的回复草稿；空串表示不在打字 */
  const [draft, setDraft] = useState('')
  /** 本轮待发送的附件（已由 core 抽好文本） */
  const [attachments, setAttachments] = useState<FrontendAttachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const typingTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTyping = useCallback(() => {
    if (typingTimer.current !== null) {
      clearInterval(typingTimer.current)
      typingTimer.current = null
    }
  }, [])

  // 页面卸载时必须停掉定时器，否则会在已卸载页面上 setState
  useEffect(() => stopTyping, [stopTyping])

  /**
   * 打字机：把已经拿到的整段回复逐字显示出来。
   * 步长按总长度折算，让长短回复的观感时长都落在 1.5–2 秒左右。
   */
  const typeOut = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        stopTyping()
        if (!text) {
          setDraft('')
          resolve()
          return
        }
        const step = Math.max(1, Math.ceil(text.length / 110))
        let shown = 0
        setDraft('')
        typingTimer.current = setInterval(() => {
          shown = Math.min(text.length, shown + step)
          setDraft(text.slice(0, shown))
          if (shown >= text.length) {
            stopTyping()
            resolve()
          }
        }, 16)
      }),
    [stopTyping]
  )

  const loadMessages = useCallback((convId: string) => {
    const result = getCore().getMessages(convId)
    const list = toChatMessages((result.data ?? []) as Array<Record<string, unknown>>)
    setMessages(list)
    console.log('[Synapse] 载入会话消息', convId, list.length)
  }, [])

  useEffect(() => {
    const routeId = String(router.params?.id ?? '')
    const initial = routeId || getLastConversationId() || taroIdGen.next()
    setConversationId(initial)
    setLastConversationId(initial)
    loadMessages(initial)
  }, [loadMessages, router.params?.id])

  useDidShow(() => {
    setRuntime(currentRuntimeMode())
    // 从会话列表切换回来后，跟随最近会话
    const latest = getLastConversationId()
    if (latest && latest !== conversationId) {
      setConversationId(latest)
      loadMessages(latest)
    }
  })

  const scrollToBottom = useCallback(() => {
    // 页面级滚动，避免嵌套 scroll-view 在快速滑动时卡死
    Taro.pageScrollTo({ scrollTop: 100000, duration: 200 }).catch(() => undefined)
  }, [])

  // 打字机每吐满 60 字才滚一次：Taro 的 pageScrollTo 是异步的，
  // 跟着每一帧滚会把滚动队列打满，反而卡顿
  const draftChunk = Math.floor(draft.length / 60)

  useEffect(() => {
    if (messages.length) {
      setTimeout(scrollToBottom, 60)
    }
  }, [messages.length, draftChunk, scrollToBottom])

  const afterResponse = useCallback(
    (response: Parameters<typeof autoSavePlan>[0]) => {
      const saved = autoSavePlan(response, changeSummaryOf(response))
      if (saved.saved) {
        Taro.showToast({ title: saved.message, icon: 'none' })
      }
      loadMessages(conversationId)
      setTimeout(scrollToBottom, 80)
    },
    [conversationId, loadMessages, scrollToBottom]
  )

  /**
   * 选附件：复用资料库那条 FileExtractor 链路（core.extractFiles）先把文本抽出来。
   * txt/md 由 core 解码，任何页面都能用；PDF 需要 pdf.js，它被放在 packageDocuments 分包里，
   * 没进过资料库时插座会给出「请从资料库进入后再导入 PDF」的明确提示。
   */
  const pickAttachments = async () => {
    if (attaching || sending) {
      return
    }
    try {
      const picked = await (Taro as any).chooseMessageFile({
        count: MAX_ATTACH_COUNT,
        type: 'file',
        extension: ['txt', 'md', 'markdown', 'pdf']
      })
      const files = (picked.tempFiles ?? []) as Array<{ path: string; name: string; size?: number }>
      if (!files.length) {
        return
      }
      setAttaching(true)
      const accepted: FrontendAttachment[] = []
      const failed: string[] = []
      const fs = Taro.getFileSystemManager()
      for (const file of files) {
        if (attachments.length + accepted.length >= MAX_ATTACH_COUNT) {
          failed.push(`${file.name}（一次最多带 ${MAX_ATTACH_COUNT} 份）`)
          continue
        }
        const pdf = /\.pdf$/i.test(file.name)
        const limit = pdf ? MAX_ATTACH_PDF_SIZE : MAX_ATTACH_SIZE
        if (typeof file.size === 'number' && file.size > limit) {
          failed.push(`${file.name}（超过 ${Math.round(limit / 1024 / 1024)}MB）`)
          continue
        }
        try {
          const buffer = fs.readFileSync(file.path) as unknown as ArrayBuffer
          // 读入后再兜一次大小，避免 tempFiles 不带 size 时无上限读文件
          if (buffer.byteLength > limit) {
            failed.push(`${file.name}（超过 ${Math.round(limit / 1024 / 1024)}MB）`)
            continue
          }
          const extracted = await getCore().extractFiles([
            {
              name: file.name,
              contentType: pdf ? 'application/pdf' : 'text/plain',
              data: new Uint8Array(buffer)
            }
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
      if (accepted.length) {
        setAttachments((prev) => [...prev, ...accepted])
      }
      if (failed.length) {
        Taro.showToast({ title: failed.join('；'), icon: 'none', duration: 3000 })
      }
    } catch {
      // 用户取消选择：静默返回
    } finally {
      setAttaching(false)
    }
  }

  const send = async (rawText?: string) => {
    const text = (rawText ?? input).trim()
    if ((!text && !attachments.length) || sending || !conversationId) {
      return
    }
    const sentAttachments = attachments
    setSending(true)
    setInput('')
    setAttachments([])
    setStageLabel('')
    setDraft('')
    // 先把自己这句话回显出来：请求返回前也能看到说了什么
    const localId = `local-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      localMessage(
        localId,
        'user',
        text,
        sentAttachments.map((item) => item.name)
      )
    ])
    // 只记录长度，不把用户输入原文写进控制台（隐私）
    console.log('[Synapse] runStream', planningMode, conversationId, text.length, sentAttachments.length)
    try {
      // core 的流式入口：先给 stage 进度，最后一条 done 带完整结果
      let response: StudyPilotRunResponse | undefined
      for await (const event of streamRun(
        buildRunPayload(text, conversationId, planningMode, sentAttachments)
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
      setDraft('')
      setStageLabel('')
      afterResponse(response)
    } catch (error) {
      console.error('[Synapse] runStream 失败', error)
      stopTyping()
      setDraft('')
      setStageLabel('')
      setMessages((prev) => prev.filter((message) => message.id !== localId))
      setInput(text)
      setAttachments(sentAttachments)
      Taro.showToast({ title: '请求失败，已保留你的输入', icon: 'none' })
    } finally {
      setSending(false)
    }
  }

  const submitClarification = async (sessionId: string, answers: ClarificationAnswer[]) => {
    if (sending) {
      return
    }
    setSending(true)
    setStageLabel('')
    setDraft('')
    try {
      const response = await getCore().confirm({ sessionId, answers, conversationId })
      console.log('[Synapse] confirm 完成', response.mode)
      afterResponse(response)
    } catch (error) {
      console.error('[Synapse] confirm 失败', error)
      Taro.showToast({ title: '提交失败，请重试', icon: 'none' })
    } finally {
      setSending(false)
    }
  }

  const expand = async (message: ChatMessageView, blockPlan: BlockPlan) => {
    if (sending || !message.normalized) {
      Taro.showToast({ title: '这次积木计划的上下文已失效，请重新发起', icon: 'none' })
      return
    }
    setSending(true)
    setStageLabel('')
    setDraft('')
    try {
      const response = await getCore().expandBlocks(
        message.normalized as StudyPlanRequest,
        blockPlan,
        conversationId
      )
      console.log('[Synapse] expand 完成', response.mode)
      afterResponse(response)
    } catch (error) {
      console.error('[Synapse] expand 失败', error)
      Taro.showToast({ title: '展开失败，请重试', icon: 'none' })
    } finally {
      setSending(false)
    }
  }

  const startNewConversation = () => {
    const next = taroIdGen.next()
    setConversationId(next)
    setLastConversationId(next)
    setMessages([])
    console.log('[Synapse] 新建会话', next)
  }

  return (
    <View className={styles.page}>
      <View className={styles.header}>
        <View className={styles.headerTop}>
          <View className={styles.headerTitleWrap}>
            <Text className={styles.headerTitle}>Synapse</Text>
            <Text className={styles.headerSub}>学习陪伴 · 边聊边定计划</Text>
          </View>
          <View className={styles.headerActions}>
            <View className={styles.iconButton} onClick={startNewConversation}>
              <Text className={styles.iconButtonText}>新对话</Text>
            </View>
            <View
              className={styles.iconButton}
              onClick={() => Taro.navigateTo({ url: '/pages/conversations/index' })}
            >
              <Text className={styles.iconButtonText}>历史</Text>
            </View>
          </View>
        </View>
        <View
          className={classnames(styles.modeBadge, runtime.isFallback && styles.modeBadgeFallback)}
        >
          <Text className={styles.modeBadgeText}>
            {runtime.isFallback ? '本地规则模式（未配置 Key）' : `已连接 ${runtime.model}`}
          </Text>
        </View>
      </View>

      <View className={styles.body}>
        {messages.length === 0 && (
          <View className={styles.welcome}>
            <Text className={styles.welcomeTitle}>今天想推进什么？</Text>
            <Text className={styles.welcomeDesc}>
              告诉我科目、截止时间和每天可用时长。我会先补齐关键信息，再给出可按科目执行的周计划。
            </Text>
            {SUGGESTIONS.map((text) => (
              <View key={text} className={styles.suggestion} onClick={() => send(text)}>
                <Text className={styles.suggestionText}>{text}</Text>
                <Text className={styles.suggestionArrow}>›</Text>
              </View>
            ))}
          </View>
        )}

        {messages.map((message) => (
          <View
            key={message.id}
            className={classnames(
              styles.row,
              message.role === 'user' ? styles.rowUser : styles.rowAssistant
            )}
          >
            <View
              className={classnames(
                styles.bubble,
                message.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant
              )}
            >
              {message.role === 'assistant' && (
                <Text className={styles.aiMessageBadge}>AI 生成</Text>
              )}
              {message.attachments.length > 0 && (
                <View className={styles.bubbleAttachments}>
                  {message.attachments.map((name, index) => (
                    <Text key={`${message.id}-att-${index}`} className={styles.attachmentChip}>
                      {name}
                    </Text>
                  ))}
                </View>
              )}
              {!!message.content && (
                <Text
                  className={message.role === 'user' ? styles.bubbleTextUser : styles.bubbleText}
                >
                  {message.content}
                </Text>
              )}
            </View>

            {message.role === 'assistant' && message.clarification && (
              <ClarificationCard
                clarification={message.clarification}
                submitting={sending}
                onSubmit={(answers) => submitClarification(message.clarification!.sessionId, answers)}
              />
            )}

            {message.role === 'assistant' && message.blockPlan && (
              <BlockPlanCard
                blockPlan={message.blockPlan}
                expanding={sending}
                onExpand={(plan) => expand(message, plan)}
              />
            )}

            {message.role === 'assistant' && message.weeklyPlan.length > 0 && (
              <PlanCard
                weeklyPlan={message.weeklyPlan}
                retrievedContext={message.retrievedContext}
                request={message.normalized}
                reason={message.reason}
              />
            )}
          </View>
        ))}

        {sending && (
          <View className={classnames(styles.row, styles.rowAssistant)}>
            <View className={classnames(styles.bubble, styles.bubbleAssistant)}>
              {draft ? (
                <Text className={styles.bubbleText}>
                  {draft}
                  <Text className={styles.typingCaret}>▍</Text>
                </Text>
              ) : (
                <View className={styles.stageRow}>
                  <View className={styles.stageDots}>
                    <View className={styles.stageDot} />
                    <View className={styles.stageDot} />
                    <View className={styles.stageDot} />
                  </View>
                  <Text className={styles.stageText}>{stageLabel || '正在准备…'}</Text>
                </View>
              )}
            </View>
          </View>
        )}

        <View className={styles.bottomSpacer} />
      </View>

      <View
        className={classnames(
          styles.inputBar,
          process.env.TARO_ENV === 'h5' && styles.inputBarH5
        )}
      >
        {attachments.length > 0 && (
          <View className={styles.attachChips}>
            {attachments.map((item, index) => (
              <View
                key={item.id ?? `${item.name}-${index}`}
                className={styles.attachChip}
                onClick={() => setAttachments((prev) => prev.filter((one) => one !== item))}
              >
                <Text className={styles.attachChipText}>{item.name}</Text>
                <Text className={styles.attachChipRemove}>×</Text>
              </View>
            ))}
          </View>
        )}
        <View className={styles.inputRow}>
          <View className={styles.modeToggle}>
            <View
              className={classnames(
                styles.modeChip,
                planningMode === 'free' && styles.modeChipActive
              )}
              onClick={() => setPlanningMode('free')}
            >
              <Text
                className={classnames(
                  styles.modeChipText,
                  planningMode === 'free' && styles.modeChipTextActive
                )}
              >
                自由
              </Text>
            </View>
            <View
              className={classnames(
                styles.modeChip,
                planningMode === 'blocks' && styles.modeChipActive
              )}
              onClick={() => setPlanningMode('blocks')}
            >
              <Text
                className={classnames(
                  styles.modeChipText,
                  planningMode === 'blocks' && styles.modeChipTextActive
                )}
              >
                积木
              </Text>
            </View>
          </View>
          <View
            className={classnames(styles.attachButton, attaching && styles.attachButtonBusy)}
            onClick={pickAttachments}
          >
            <Text className={styles.attachButtonText}>{attaching ? '解析中…' : '＋资料'}</Text>
          </View>
          <Input
            className={styles.input}
            placeholder="说说你的学习目标…"
            value={input}
            confirmType="send"
            adjustPosition
            onInput={(event) => setInput(String(event.detail.value))}
            onConfirm={() => send()}
          />
          <Button
            className={styles.sendButton}
            disabled={sending || (!input.trim() && !attachments.length)}
            onClick={() => send()}
          >
            发送
          </Button>
        </View>
      </View>
    </View>
  )
}
