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
  subject: string
  tags: string[]
  source: string
  char_count: number
  kg_node_count: number
  review_card_count: number
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentView[]>([])
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [buildingDocId, setBuildingDocId] = useState('')
  const [learningDocId, setLearningDocId] = useState('')
  const [editingId, setEditingId] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftSubject, setDraftSubject] = useState('')
  const [draftTags, setDraftTags] = useState('')

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
      // F2.2：粘贴进来自动标记来源，便于区分「上传」与「粘贴」
      const result = getCore().importDocument(DEFAULT_USER_ID, name.trim(), content, {
        source: 'paste'
      })
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

  /** F2.1：批量上传 —— 逐个复用单文件链路，单个失败不阻塞其他文件。 */
  const pickFile = async () => {
    if (busy) {
      return
    }
    try {
      const picked = await (Taro as any).chooseMessageFile({
        count: 9,
        type: 'file',
        extension: ['txt', 'md', 'markdown']
      })
      const files = (picked.tempFiles ?? []) as Array<{ path: string; name: string; size?: number }>
      if (!files.length) {
        return
      }
      setBusy(true)
      const followed: string[] = []
      const failed: string[] = []
      const fs = Taro.getFileSystemManager()
      for (const file of files) {
        if (typeof file.size === 'number' && file.size > 2 * 1024 * 1024) {
          failed.push(`${file.name}（超过 2MB，请压缩或拆分后再传）`)
          continue
        }
        try {
          const buffer = fs.readFileSync(file.path) as unknown as ArrayBuffer
          const attachments = await getCore().extractFiles([
            {
              name: file.name,
              contentType: 'text/plain',
              data: new Uint8Array(buffer)
            }
          ])
          const attachment = attachments[0]
          if (!attachment || attachment.extraction_status !== 'done' || !attachment.extracted_text) {
            failed.push(`${file.name}（${attachment?.extraction_error || '没有提取到文本'}）`)
            continue
          }
          const result = getCore().importDocument(DEFAULT_USER_ID, file.name, attachment.extracted_text)
          console.log('[Synapse] 导入资料', file.name, result.success, result.message)
          if (result.success) {
            followed.push(file.name)
          } else {
            failed.push(`${file.name}（${result.message}）`)
          }
        } catch (error) {
          console.log('[Synapse] 读取文件失败', file.name, error)
          failed.push(`${file.name}（读取失败）`)
        }
      }
      const summary = [`成功 ${followed.length} 个`]
      if (failed.length) {
        summary.push(`失败 ${failed.length} 个：${failed.join('；')}`)
      }
      setName('')
      setText('')
      load()
      Taro.showToast({ title: summary.join('，'), icon: 'none', duration: 3000 })
    } catch (error) {
      console.log('[Synapse] 选择文件结束', error)
    } finally {
      setBusy(false)
    }
  }

  const removeDoc = async (doc: DocumentView) => {
    const confirmed = await Taro.showModal({
      title: '删除资料',
      content: `删除「${doc.file_name}」？删掉之后检索不会再命中它。`,
      confirmText: '删除',
      confirmColor: '#dc2626'
    })
    if (!confirmed.confirm) {
      return
    }
    const result = getCore().removeDocument(DEFAULT_USER_ID, doc.doc_id)
    console.log('[Synapse] 删除资料', doc.doc_id, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const buildGraph = async (doc: DocumentView) => {
    if (buildingDocId) {
      return
    }
    setBuildingDocId(doc.doc_id)
    try {
      const result = await getCore().buildKgFromDocument(doc.doc_id, DEFAULT_USER_ID)
      console.log('[Synapse] 资料构建图谱', doc.doc_id, result.success, result.message)
      Taro.showToast({ title: result.message, icon: 'none', duration: 3000 })
    } finally {
      setBuildingDocId('')
      load()
    }
  }

  /** F2.3：一键学习化 —— 串起「构建图谱 → 生成复习卡」，各自失败独立提示。 */
  const oneClickLearn = async (doc: DocumentView) => {
    if (learningDocId) {
      return
    }
    setLearningDocId(doc.doc_id)
    try {
      const built = await getCore().buildKgFromDocument(doc.doc_id, DEFAULT_USER_ID)
      if (!built.success) {
        Taro.showToast({ title: built.message, icon: 'none' })
        return
      }
      const cards = getCore().generateReviewCardsFromDocument(DEFAULT_USER_ID, doc.doc_id)
      console.log('[Synapse] 一键学习化', built.success, cards.success)
      Taro.showToast({ title: `${built.message}；${cards.message}`, icon: 'none', duration: 3000 })
    } finally {
      setLearningDocId('')
      load()
    }
  }

  /** F1.3：改标题 / 科目 / 标签。 */
  const startEdit = (doc: DocumentView) => {
    setEditingId(doc.doc_id)
    setDraftName(doc.file_name)
    setDraftSubject(doc.subject)
    setDraftTags((doc.tags ?? []).join('、'))
  }

  const saveEdit = (doc: DocumentView) => {
    const tags = draftTags
      .split(/[、,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
    const result = getCore().updateDocument(DEFAULT_USER_ID, doc.doc_id, {
      file_name: draftName.trim(),
      subject: draftSubject.trim(),
      tags
    })
    console.log('[Synapse] 更新资料', doc.doc_id, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    setEditingId('')
    load()
  }

  return (
    <View className={styles.page}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>粘贴导入</Text>
        <Button
          className={classnames(styles.fileButton, busy && styles.buttonDisabled)}
          disabled={busy}
          onClick={pickFile}
        >
          从聊天记录选文件（.txt / .md，可多选）
        </Button>
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
              <View className={styles.docTitleRow}>
                <Text className={styles.docName}>{doc.file_name}</Text>
                {!!doc.subject && <Text className={styles.docSubject}>{doc.subject}</Text>}
                {doc.source === 'paste' && <Text className={styles.docSource}>粘贴</Text>}
              </View>
              <Text className={styles.docMeta}>
                {doc.chunk_count} 个片段
                {Number(doc.char_count) > 0 ? ` · ${doc.char_count} 字` : ''}
                {Number(doc.kg_node_count) > 0 ? ` · ${doc.kg_node_count} 个知识点` : ''}
                {Number(doc.review_card_count) > 0
                  ? ` · ${doc.review_card_count} 张复习卡`
                  : ''}
              </Text>
              {!!(doc.tags ?? []).length && (
                <View className={styles.docTags}>
                  {(doc.tags ?? []).map((tag) => (
                    <Text key={tag} className={styles.docTag}>
                      {tag}
                    </Text>
                  ))}
                </View>
              )}
              {!!doc.excerpt && <Text className={styles.docExcerpt}>{doc.excerpt}</Text>}
            </View>
            <View className={styles.docActions}>
              <View
                className={classnames(styles.docBuild, learningDocId && styles.buttonDisabled)}
                onClick={() => oneClickLearn(doc)}
              >
                <Text className={styles.docBuildText}>
                  {learningDocId === doc.doc_id ? '学习中…' : '一键学习化'}
                </Text>
              </View>
              <View
                className={classnames(styles.docBuild, buildingDocId && styles.buttonDisabled)}
                onClick={() => buildGraph(doc)}
              >
                <Text className={styles.docBuildText}>
                  {buildingDocId === doc.doc_id ? '构建中…' : '构建图谱'}
                </Text>
              </View>
              <View className={styles.docBuild} onClick={() => startEdit(doc)}>
                <Text className={styles.docBuildText}>编辑</Text>
              </View>
              <View className={styles.docRemove} onClick={() => removeDoc(doc)}>
                <Text className={styles.docRemoveText}>删除</Text>
              </View>
            </View>
            {editingId === doc.doc_id && (
              <View className={styles.docEditor}>
                <Input
                  className={styles.input}
                  placeholder="资料名"
                  value={draftName}
                  onInput={(event) => setDraftName(String(event.detail.value))}
                />
                <Input
                  className={styles.input}
                  placeholder="科目，如 高等数学"
                  value={draftSubject}
                  onInput={(event) => setDraftSubject(String(event.detail.value))}
                />
                <Input
                  className={styles.input}
                  placeholder="标签，用、分隔（可空）"
                  value={draftTags}
                  onInput={(event) => setDraftTags(String(event.detail.value))}
                />
                <View className={styles.docEditorActions}>
                  <View
                    className={classnames(styles.docBuild, styles.docEditorPrimary)}
                    onClick={() => saveEdit(doc)}
                  >
                    <Text className={styles.docEditorPrimaryText}>保存</Text>
                  </View>
                  <View className={styles.docBuild} onClick={() => setEditingId('')}>
                    <Text className={styles.docBuildText}>取消</Text>
                  </View>
                </View>
              </View>
            )}
          </View>
        ))}
      </View>

      <View className={styles.bottomSpacer} />
    </View>
  )
}
