import { useCallback, useEffect, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import classnames from 'classnames'
import {
  autoSavePlan,
  buildRunPayload,
  changeSummaryOf,
  currentRuntimeMode,
  getCore
} from '../../services/synapse'
import { getLastConversationId, setLastConversationId } from '../../utils/prefs'
import { localMessage, toChatMessages, type ChatMessageView } from '../../utils/chatModel'
import { taroIdGen } from '../../adapters/system'
import PlanCard from '../../components/PlanCard'
import BlockPlanCard from '../../components/BlockPlanCard'
import ClarificationCard from '../../components/ClarificationCard'
import type { BlockPlan, ClarificationAnswer, StudyPlanRequest } from '../../vendor/core'
import styles from './index.module.scss'

const SUGGESTIONS = [
  '帮我准备高等数学和大学物理期末考试，每天能学 90 分钟',
  '我想提升英语四级词汇和阅读，前提是每天只有 45 分钟',
  '两周内完成操作系统课程实验报告'
]

export default function ChatPage() {
  const router = useRouter()
  const [conversationId, setConversationId] = useState('')
  const [messages, setMessages] = useState<ChatMessageView[]>([])
  const [input, setInput] = useState('')
  const [planningMode, setPlanningMode] = useState<'free' | 'blocks'>('free')
  const [sending, setSending] = useState(false)
  const [runtime, setRuntime] = useState(currentRuntimeMode())

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

  useEffect(() => {
    if (messages.length) {
      setTimeout(scrollToBottom, 60)
    }
  }, [messages.length, scrollToBottom])

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

  const send = async (rawText?: string) => {
    const text = (rawText ?? input).trim()
    if (!text || sending || !conversationId) {
      return
    }
    setSending(true)
    setInput('')
    // 先把自己这句话回显出来：请求返回前也能看到说了什么
    const localId = `local-${Date.now()}`
    setMessages((prev) => [...prev, localMessage(localId, 'user', text)])
    console.log('[Synapse] run', planningMode, conversationId, text)
    try {
      const response = await getCore().run(buildRunPayload(text, conversationId, planningMode))
      console.log('[Synapse] run 完成', response.status, response.mode)
      afterResponse(response)
    } catch (error) {
      console.error('[Synapse] run 失败', error)
      setMessages((prev) => prev.filter((message) => message.id !== localId))
      setInput(text)
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
              <Text
                className={message.role === 'user' ? styles.bubbleTextUser : styles.bubbleText}
              >
                {message.content}
              </Text>
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
              <PlanCard weeklyPlan={message.weeklyPlan} />
            )}
          </View>
        ))}

        {sending && (
          <View className={classnames(styles.row, styles.rowAssistant)}>
            <View className={classnames(styles.bubble, styles.bubbleAssistant)}>
              <Text className={styles.bubbleText}>正在回复…</Text>
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
        <View className={styles.modeToggle}>
          <View
            className={classnames(styles.modeChip, planningMode === 'free' && styles.modeChipActive)}
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
          disabled={sending || !input.trim()}
          onClick={() => send()}
        >
          发送
        </Button>
      </View>
    </View>
  )
}
