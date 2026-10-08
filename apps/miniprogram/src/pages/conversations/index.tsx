import { useEffect, useRef, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { getCore, getActiveUserId } from '../../services/synapse'
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

/** 全局搜索命中的会话项（searchAll 返回的 conversations 元素）。 */
interface SearchConversationHit {
  id: string
  title: string
  subject: string
  updated_at: string
  snippet: string
}

export default function ConversationsPage() {
  const [rows, setRows] = useState<ConversationRow[]>([])
  const [currentId, setCurrentId] = useState('')
  // 全局搜索：searchQuery 为空时展示全部会话，非空时按命中 id 过滤
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIds, setSearchIds] = useState<string[]>([])
  const [searchSnippets, setSearchSnippets] = useState<Record<string, string>>({})
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = () => {
    const result = getCore().listConversations(getActiveUserId())
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

  // 页面卸载时清掉防抖定时器，避免在已卸载页面上发起搜索
  useEffect(
    () => () => {
      if (searchTimer.current !== null) {
        clearTimeout(searchTimer.current)
        searchTimer.current = null
      }
    },
    []
  )

  const runSearch = (query: string) => {
    const result = getCore().searchAll(getActiveUserId(), query, 20)
    console.log('[Synapse] 搜索会话', query, result.success)
    if (!result.success) {
      // 搜索失败必须显式提示，不能静默留白
      Taro.showToast({ title: result.message, icon: 'none' })
      return
    }
    const data = (result.data ?? {}) as Record<string, unknown>
    const hits = (data['conversations'] ?? []) as SearchConversationHit[]
    const snippets: Record<string, string> = {}
    for (const hit of hits) {
      const snippet = String(hit.snippet ?? '')
      if (snippet) {
        snippets[hit.id] = snippet
      }
    }
    setSearchIds(hits.map((hit) => hit.id))
    setSearchSnippets(snippets)
  }

  /** 300ms 防抖：清空则回到全部会话，否则按输入过滤。 */
  const onSearchInput = (value: string) => {
    setSearchInput(value)
    if (searchTimer.current !== null) {
      clearTimeout(searchTimer.current)
    }
    searchTimer.current = setTimeout(() => {
      const query = value.trim()
      if (!query) {
        setSearchQuery('')
        setSearchIds([])
        setSearchSnippets({})
        load()
        return
      }
      setSearchQuery(query)
      runSearch(query)
    }, 300)
  }

  /** 会话删除后同步刷新：搜索结果生效时一并重跑搜索。 */
  const refresh = () => {
    load()
    if (searchQuery) {
      runSearch(searchQuery)
    }
  }

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
      confirmColor: '#dc2626'
    })
    if (!confirmResult.confirm) {
      return
    }
    getCore().deleteConversation(row.id)
    console.log('[Synapse] 已删除会话', row.id)
    if (row.id === currentId) {
      setLastConversationId('')
    }
    refresh()
  }

  // 用命中的会话 id 过滤现有列表，保持原有的打开/删除等交互不变
  const visibleRows = searchQuery
    ? rows.filter((row) => searchIds.includes(row.id))
    : rows

  return (
    <View className={styles.page}>
      <Button className={styles.newButton} onClick={createConversation}>
        开始新对话
      </Button>

      <Input
        className={styles.searchInput}
        placeholder="搜索对话：标题 / 科目 / 消息内容"
        value={searchInput}
        onInput={(event) => onSearchInput(String(event.detail.value))}
      />

      {!searchQuery && rows.length === 0 && (
        <View className={styles.empty}>
          <Text className={styles.emptyTitle}>还没有历史对话</Text>
          <Text className={styles.emptyDesc}>回到「对话」页说说你的学习目标，这里会自动留下记录。</Text>
        </View>
      )}

      {searchQuery && visibleRows.length === 0 && (
        <View className={styles.empty}>
          <Text className={styles.emptyTitle}>没有匹配结果</Text>
          <Text className={styles.emptyDesc}>换个关键词试试，会同时检索标题、科目与消息正文。</Text>
        </View>
      )}

      {visibleRows.map((row) => (
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
          {!!searchSnippets[row.id] && (
            <Text className={styles.itemSnippet}>{searchSnippets[row.id]}</Text>
          )}
          {!!row.lastMessage && (
            <Text className={styles.itemPreview}>{row.lastMessage}</Text>
          )}
          <View className={styles.itemFooter}>
            <Text className={styles.itemMeta}>{row.messageCount} 条消息</Text>
            <Text className={styles.itemMeta}>{formatRelativeTime(row.updated_at)}</Text>
          </View>
        </View>
      ))}

      {visibleRows.length > 0 && <Text className={styles.hint}>长按对话可删除</Text>}
    </View>
  )
}
