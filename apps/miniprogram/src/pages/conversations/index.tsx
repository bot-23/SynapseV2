import { useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { getCore, DEFAULT_USER_ID } from '../../services/synapse'
import { getLastConversationId, setLastConversationId } from '../../utils/prefs'
import { formatRelativeTime } from '../../utils/format'
import { taroIdGen } from '../../adapters/system'
import styles from './index.module.scss'

interface ConversationRow {
  id: string
  title: string
  updated_at: string
  messageCount: number
  lastMessage: string
}

export default function ConversationsPage() {
  const [rows, setRows] = useState<ConversationRow[]>([])
  const [currentId, setCurrentId] = useState('')

  const load = () => {
    const result = getCore().listConversations(DEFAULT_USER_ID)
    const raw = (result.data ?? []) as Array<Record<string, unknown>>
    const list: ConversationRow[] = raw.map((item) => {
      const id = String(item['id'] ?? '')
      const messages = (getCore().getMessages(id).data ?? []) as Array<Record<string, unknown>>
      const last = messages.length ? String(messages[messages.length - 1]!['content'] ?? '') : ''
      return {
        id,
        title: String(item['title'] ?? '未命名对话'),
        updated_at: String(item['updated_at'] ?? ''),
        messageCount: messages.length,
        lastMessage: last
      }
    })
    setRows(list)
    setCurrentId(getLastConversationId())
    console.log('[Synapse] 会话列表', list.length)
  }

  useDidShow(() => {
    load()
  })

  const openConversation = (id: string) => {
    setLastConversationId(id)
    console.log('[Synapse] 切换到会话', id)
    Taro.navigateBack()
  }

  const createConversation = () => {
    const next = taroIdGen.next()
    setLastConversationId(next)
    Taro.navigateBack()
  }

  const removeConversation = async (row: ConversationRow) => {
    const confirmResult = await Taro.showModal({
      title: '删除对话',
      content: `确定删除「${row.title}」及其全部消息吗？`,
      confirmText: '删除',
      confirmColor: '#f53f3f'
    })
    if (!confirmResult.confirm) {
      return
    }
    getCore().deleteConversation(row.id)
    console.log('[Synapse] 已删除会话', row.id)
    if (row.id === currentId) {
      setLastConversationId('')
    }
    load()
  }

  return (
    <View className={styles.page}>
      <Button className={styles.newButton} onClick={createConversation}>
        开始新对话
      </Button>

      {rows.length === 0 && (
        <View className={styles.empty}>
          <Text className={styles.emptyTitle}>还没有历史对话</Text>
          <Text className={styles.emptyDesc}>回到「对话」页说说你的学习目标，这里会自动留下记录。</Text>
        </View>
      )}

      {rows.map((row) => (
        <View
          key={row.id}
          className={styles.item}
          onClick={() => openConversation(row.id)}
          onLongPress={() => removeConversation(row)}
        >
          <View className={styles.itemHeader}>
            <Text className={styles.itemTitle}>{row.title}</Text>
            {row.id === currentId && (
              <View className={styles.currentBadge}>
                <Text className={styles.currentBadgeText}>当前</Text>
              </View>
            )}
          </View>
          {!!row.lastMessage && (
            <Text className={styles.itemPreview}>{row.lastMessage}</Text>
          )}
          <View className={styles.itemFooter}>
            <Text className={styles.itemMeta}>{row.messageCount} 条消息</Text>
            <Text className={styles.itemMeta}>{formatRelativeTime(row.updated_at)}</Text>
          </View>
        </View>
      ))}

      {rows.length > 0 && <Text className={styles.hint}>长按对话可删除</Text>}
    </View>
  )
}
