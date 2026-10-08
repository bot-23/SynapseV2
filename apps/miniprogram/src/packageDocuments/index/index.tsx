import { useEffect, useRef, useState } from 'react'
import { View, Text, Input, Textarea, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import { getCore, getActiveUserId } from '../../services/synapse'
import { registerPdfExtractor } from '../../adapters/pdfExtractor'
import { miniprogramPdfExtractor } from '../pdf/extractor'
import styles from './index.module.scss'

// 进资料库页即注册 PDF 抽取器：真正的实现和 pdf.js 都住在分包里，主包只留一个插座
registerPdfExtractor(miniprogramPdfExtractor)

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

/** 全局搜索命中的资料项（searchAll 返回的 documents 元素）。 */
interface SearchDocHit {
  doc_id: string
  file_name: string
  subject: string
  excerpt: string
  score: number
}

/** 文本类文件上限 2MB；PDF 上限 30MB（与 Web 壳保持一致）。 */
const TEXT_MAX_BYTES = 2 * 1024 * 1024
const PDF_MAX_BYTES = 30 * 1024 * 1024

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
  // 全局搜索：searchQuery 为空时展示完整列表，非空时展示搜索结果
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchDocHit[]>([])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = () => {
    const result = getCore().listDocuments(getActiveUserId())
    setDocuments(
      ((result.data as Record<string, unknown> | null)?.['documents'] ?? []) as DocumentView[]
    )
  }

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
    console.log('[Synapse] 搜索资料', query, result.success)
    if (!result.success) {
      // 搜索失败必须显式提示，不能静默留白
      Taro.showToast({ title: result.message, icon: 'none' })
      return
    }
    const data = (result.data ?? {}) as Record<string, unknown>
    setSearchHits((data['documents'] ?? []) as SearchDocHit[])
  }

  /** 300ms 防抖：清空则回到完整列表，否则按输入发起全局搜索。 */
  const onSearchInput = (value: string) => {
    setSearchInput(value)
    if (searchTimer.current !== null) {
      clearTimeout(searchTimer.current)
    }
    searchTimer.current = setTimeout(() => {
      const query = value.trim()
      if (!query) {
        setSearchQuery('')
        setSearchHits([])
        load()
        return
      }
      setSearchQuery(query)
      runSearch(query)
    }, 300)
  }

  /** 列表发生增删改后同步刷新：搜索结果生效时一并重跑搜索。 */
  const refresh = () => {
    load()
    if (searchQuery) {
      runSearch(searchQuery)
    }
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
      const result = getCore().importDocument(getActiveUserId(), name.trim(), content, {
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
        extension: ['txt', 'md', 'markdown', 'pdf']
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
        const pdf = /\.pdf$/i.test(file.name)
        const limit = pdf ? PDF_MAX_BYTES : TEXT_MAX_BYTES
        // chooseMessageFile 的 tempFiles 不保证带 size；缺了就先 stat 一次，
        // 拿不到大小一律拒绝 —— 否则会把任意大的文件一次性读进内存把小程序卡死
        let size = typeof file.size === 'number' ? file.size : -1
        if (size < 0) {
          try {
            const stat = fs.statSync(file.path) as unknown as {
              stats?: { size?: number }
              size?: number
            }
            size = Number(stat.stats?.size ?? stat.size ?? -1)
          } catch {
            size = -1
          }
        }
        if (!Number.isFinite(size) || size < 0 || size > limit) {
          failed.push(
            `${file.name}（${size < 0 ? '无法确认大小' : `超过 ${pdf ? '30MB' : '2MB'}`}，请压缩或拆分后再传）`
          )
          continue
        }
        try {
          const buffer = fs.readFileSync(file.path) as unknown as ArrayBuffer
          if (buffer.byteLength > limit) {
            failed.push(`${file.name}（超过 ${pdf ? '30MB' : '2MB'}，请压缩或拆分后再传）`)
            continue
          }
          const attachments = await getCore().extractFiles([
            {
              name: file.name,
              contentType: pdf ? 'application/pdf' : 'text/plain',
              data: new Uint8Array(buffer)
            }
          ])
          const attachment = attachments[0]
          if (!attachment || attachment.extraction_status !== 'done' || !attachment.extracted_text) {
            failed.push(`${file.name}（${attachment?.extraction_error || '没有提取到文本'}）`)
            continue
          }
          const result = getCore().importDocument(getActiveUserId(), file.name, attachment.extracted_text)
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
    const result = getCore().removeDocument(getActiveUserId(), doc.doc_id)
    console.log('[Synapse] 删除资料', doc.doc_id, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    refresh()
  }

  const buildGraph = async (doc: DocumentView) => {
    if (buildingDocId) {
      return
    }
    setBuildingDocId(doc.doc_id)
    try {
      const result = await getCore().buildKgFromDocument(doc.doc_id, getActiveUserId())
      console.log('[Synapse] 资料构建图谱', doc.doc_id, result.success, result.message)
      Taro.showToast({ title: result.message, icon: 'none', duration: 3000 })
    } finally {
      setBuildingDocId('')
      refresh()
    }
  }

  /** F2.3：一键学习化 —— 串起「构建图谱 → 生成复习卡」，各自失败独立提示。 */
  const oneClickLearn = async (doc: DocumentView) => {
    if (learningDocId) {
      return
    }
    setLearningDocId(doc.doc_id)
    try {
      const built = await getCore().buildKgFromDocument(doc.doc_id, getActiveUserId())
      if (!built.success) {
        Taro.showToast({ title: built.message, icon: 'none' })
        return
      }
      const cards = getCore().generateReviewCardsFromDocument(getActiveUserId(), doc.doc_id)
      console.log('[Synapse] 一键学习化', built.success, cards.success)
      Taro.showToast({ title: `${built.message}；${cards.message}`, icon: 'none', duration: 3000 })
    } finally {
      setLearningDocId('')
      refresh()
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
    const result = getCore().updateDocument(getActiveUserId(), doc.doc_id, {
      file_name: draftName.trim(),
      subject: draftSubject.trim(),
      tags
    })
    console.log('[Synapse] 更新资料', doc.doc_id, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    setEditingId('')
    refresh()
  }

  // 搜索命中只带 file_name/subject/excerpt，用完整列表补齐删除/编辑/构图等操作所需字段
  const visibleDocuments: DocumentView[] = searchQuery
    ? searchHits.map((hit) => {
        const full = documents.find((doc) => doc.doc_id === hit.doc_id)
        return {
          doc_id: hit.doc_id,
          file_name: hit.file_name,
          subject: hit.subject,
          excerpt: hit.excerpt,
          chunk_count: full?.chunk_count ?? 0,
          tags: full?.tags ?? [],
          source: full?.source ?? '',
          char_count: full?.char_count ?? 0,
          kg_node_count: full?.kg_node_count ?? 0,
          review_card_count: full?.review_card_count ?? 0
        }
      })
    : documents

  return (
    <View className={styles.page}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>粘贴导入</Text>
        <Button
          className={classnames(styles.fileButton, busy && styles.buttonDisabled)}
          disabled={busy}
          onClick={pickFile}
        >
          从聊天记录选文件（.txt / .md / .pdf，可多选）
        </Button>
        <Text className={styles.cardDesc}>
          把笔记、提纲或教材片段粘进来。切片与检索都在本机完成 —— 不联网、不上传，也不需要额外服务。
          PDF 由本机逐页抽取文字（扫描件是图片，需要 OCR，暂不支持）。
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
        <Text className={styles.cardTitle}>
          {searchQuery ? `搜索结果（${visibleDocuments.length}）` : `已导入（${documents.length}）`}
        </Text>
        <Input
          className={styles.searchInput}
          placeholder="搜索资料：文件名 / 科目 / 正文"
          value={searchInput}
          onInput={(event) => onSearchInput(String(event.detail.value))}
        />
        {visibleDocuments.length === 0 && (
          <Text className={styles.cardDesc}>
            {searchQuery
              ? '没有匹配结果'
              : '还没有资料。导入后生成计划时，会用 BM25 检索这些内容作为参考。'}
          </Text>
        )}
        {visibleDocuments.map((doc) => (
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
