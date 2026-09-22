import { useState } from 'react'
import { View, Text, Input, Textarea, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import { getCore, DEFAULT_USER_ID } from '../../services/synapse'
import styles from './index.module.scss'

interface DocumentView {
  doc_id: string
  file_name: string
  excerpt: string
  chunk_count: number
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentView[]>([])
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => {
    const result = getCore().listDocuments(DEFAULT_USER_ID)
    setDocuments(
      ((result.data as Record<string, unknown> | null)?.['documents'] ?? []) as DocumentView[]
    )
  }

  useDidShow(() => {
    load()
  })

  const importDoc = () => {
    const content = text.trim()
    if (!content || busy) {
      return
    }
    setBusy(true)
    try {
      const result = getCore().importDocument(DEFAULT_USER_ID, name.trim(), content)
      console.log('[Synapse] 导入资料', result.success, result.message)
      Taro.showToast({ title: result.message, icon: 'none' })
      if (result.success) {
        setName('')
        setText('')
        load()
      }
    } finally {
      setBusy(false)
    }
  }

  const removeDoc = async (doc: DocumentView) => {
    const confirmed = await Taro.showModal({
      title: '删除资料',
      content: `删除「${doc.file_name}」？删掉之后检索不会再命中它。`,
      confirmText: '删除',
      confirmColor: '#f53f3f'
    })
    if (!confirmed.confirm) {
      return
    }
    const result = getCore().removeDocument(DEFAULT_USER_ID, doc.doc_id)
    console.log('[Synapse] 删除资料', doc.doc_id, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  return (
    <View className={styles.page}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>粘贴导入</Text>
        <Text className={styles.cardDesc}>
          把笔记、提纲或教材片段粘进来。切片与检索都在本机完成 —— 不联网、不上传，也不需要额外服务。
        </Text>
        <Input
          className={styles.input}
          placeholder="资料名，如 高数错题笔记"
          value={name}
          onInput={(event) => setName(String(event.detail.value))}
        />
        <Textarea
          className={styles.textarea}
          placeholder="在这里粘贴资料内容…"
          value={text}
          maxlength={-1}
          onInput={(event) => setText(String(event.detail.value))}
        />
        <Button
          className={classnames(styles.primaryButton, busy && styles.buttonDisabled)}
          disabled={busy || !text.trim()}
          onClick={importDoc}
        >
          {busy ? '正在导入…' : '导入资料'}
        </Button>
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>已导入（{documents.length}）</Text>
        {documents.length === 0 && (
          <Text className={styles.cardDesc}>
            还没有资料。导入后生成计划时，会用 BM25 检索这些内容作为参考。
          </Text>
        )}
        {documents.map((doc) => (
          <View key={doc.doc_id} className={styles.docRow}>
            <View className={styles.docInfo}>
              <Text className={styles.docName}>{doc.file_name}</Text>
              <Text className={styles.docMeta}>{doc.chunk_count} 个片段</Text>
              {!!doc.excerpt && <Text className={styles.docExcerpt}>{doc.excerpt}</Text>}
            </View>
            <View className={styles.docRemove} onClick={() => removeDoc(doc)}>
              <Text className={styles.docRemoveText}>删除</Text>
            </View>
          </View>
        ))}
      </View>

      <View className={styles.bottomSpacer} />
    </View>
  )
}
