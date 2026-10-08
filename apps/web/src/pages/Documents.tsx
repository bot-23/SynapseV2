import { useEffect, useMemo, useState } from 'react'
import { getCore, getActiveUserId } from '../services/synapse'
import { useFlash } from '../utils/useFlash'
import PageIntro from '../components/PageIntro'

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

/** searchAll 返回的资料命中片段。 */
interface DocumentSearchHit {
  doc_id: string
  file_name: string
  subject: string
  excerpt: string
  score: number
}

/** 一次搜索的落地结果，带上对应的关键词，避免输入过程中的旧结果串台。 */
interface DocumentSearchState {
  query: string
  hits: DocumentSearchHit[]
  notice: string
}

/** 列表行：完整资料上叠加可选的高亮片段与出处标注。 */
interface DocumentRow extends DocumentView {
  matchExcerpt?: string
  matchSource?: string
}

const MAX_FILE_SIZE = 2 * 1024 * 1024
/** PDF 是二进制文档，2MB 上限对它是误伤（一本讲义随便就几 MB）。 */
const MAX_PDF_SIZE = 30 * 1024 * 1024
/** docx 同样是二进制文档，沿用与 PDF 一致的宽松上限。 */
const MAX_DOCX_SIZE = 30 * 1024 * 1024

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

function isDocxFile(file: File): boolean {
  return (
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/i.test(file.name)
  )
}

export default function DocumentsView() {
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
  /** 全局搜索：关键词与最近一次落地结果。 */
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<DocumentSearchState | null>(null)
  const [searchTick, setSearchTick] = useState(0)
  const [notice, flash] = useFlash()

  const load = () => {
    const result = getCore().listDocuments(getActiveUserId())
    setDocuments(
      ((result.data as Record<string, unknown> | null)?.['documents'] ?? []) as DocumentView[],
    )
  }

  /** 改动资料后刷新列表；若正在搜索，顺带重跑一次搜索，让结果与数据保持一致。 */
  const reload = () => {
    load()
    if (query.trim()) {
      setSearchTick((tick) => tick + 1)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 输入后 200ms 再查，避免每敲一个字都跑一次检索
  useEffect(() => {
    const keyword = query.trim()
    if (!keyword) {
      setSearchState(null)
      return
    }
    const timer = window.setTimeout(() => {
      const result = getCore().searchAll(getActiveUserId(), keyword, 20)
      if (!result.success) {
        setSearchState({ query: keyword, hits: [], notice: result.message })
        return
      }
      const data = (result.data ?? {}) as Record<string, unknown>
      setSearchState({
        query: keyword,
        hits: (data['documents'] ?? []) as DocumentSearchHit[],
        notice: '',
      })
    }, 200)
    return () => window.clearTimeout(timer)
  }, [query, searchTick])

  const importDoc = () => {
    const content = text.trim()
    if (!content || busy) {
      return
    }
    setBusy(true)
    try {
      // F2.2：粘贴进来自动标记来源，便于区分「上传」与「粘贴」
      const result = getCore().importDocument(getActiveUserId(), name.trim(), content, {
        source: 'paste',
      })
      console.log('[Synapse] 导入资料', result.success, result.message)
      flash(result.message)
      if (result.success) {
        setName('')
        setText('')
        reload()
      }
    } finally {
      setBusy(false)
    }
  }

  /** F2.1：批量上传 —— 逐个复用单文件链路，单个失败不阻塞其他文件。 */
  const pickFiles = async (files: FileList | null) => {
    if (busy || !files || !files.length) {
      return
    }
    setBusy(true)
    const succeeded: string[] = []
    const failed: string[] = []
    try {
      for (const file of Array.from(files)) {
        const pdf = isPdfFile(file)
        // pdf / docx 都是二进制格式，必须按二进制读，且用更大的体积上限
        const binary = pdf || isDocxFile(file)
        const limit = pdf ? MAX_PDF_SIZE : binary ? MAX_DOCX_SIZE : MAX_FILE_SIZE
        if (file.size > limit) {
          failed.push(
            `${file.name}（超过 ${Math.round(limit / 1024 / 1024)}MB，请压缩或拆分后再传）`,
          )
          continue
        }
        try {
          // 文本按 UTF-8 读，二进制文档必须按二进制读 —— 用 text() 读会得到一堆乱码
          const data = binary
            ? new Uint8Array(await file.arrayBuffer())
            : new TextEncoder().encode(await file.text())
          const attachments = await getCore().extractFiles([
            {
              name: file.name,
              contentType: file.type || (pdf ? 'application/pdf' : 'text/plain'),
              data,
            },
          ])
          const attachment = attachments[0]
          if (!attachment || attachment.extraction_status !== 'done' || !attachment.extracted_text) {
            failed.push(`${file.name}（${attachment?.extraction_error || '没有提取到文本'}）`)
            continue
          }
          const result = getCore().importDocument(getActiveUserId(), file.name, attachment.extracted_text)
          console.log('[Synapse] 导入资料', file.name, result.success, result.message)
          if (result.success) {
            succeeded.push(file.name)
          } else {
            failed.push(`${file.name}（${result.message}）`)
          }
        } catch (error) {
          console.log('[Synapse] 读取文件失败', file.name, error)
          failed.push(`${file.name}（读取失败）`)
        }
      }
      const summary = [`成功 ${succeeded.length} 个`]
      if (failed.length) {
        summary.push(`失败 ${failed.length} 个：${failed.join('；')}`)
      }
      flash(summary.join('，'))
      setName('')
      setText('')
      reload()
    } finally {
      setBusy(false)
    }
  }

  const removeDoc = (doc: DocumentView) => {
    if (!window.confirm(`删除「${doc.file_name}」？删掉之后检索不会再命中它。`)) {
      return
    }
    const result = getCore().removeDocument(getActiveUserId(), doc.doc_id)
    console.log('[Synapse] 删除资料', doc.doc_id, result.success)
    flash(result.message)
    reload()
  }

  const buildGraph = async (doc: DocumentView) => {
    if (buildingDocId) {
      return
    }
    setBuildingDocId(doc.doc_id)
    try {
      const result = await getCore().buildKgFromDocument(doc.doc_id, getActiveUserId())
      console.log('[Synapse] 资料构建图谱', doc.doc_id, result.success, result.message)
      flash(result.message)
    } finally {
      setBuildingDocId('')
      reload()
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
        flash(built.message)
        return
      }
      const cards = getCore().generateReviewCardsFromDocument(getActiveUserId(), doc.doc_id)
      console.log('[Synapse] 一键学习化', built.success, cards.success)
      flash(`${built.message}；${cards.message}`)
    } finally {
      setLearningDocId('')
      reload()
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
      tags,
    })
    console.log('[Synapse] 更新资料', doc.doc_id, result.success)
    flash(result.message)
    setEditingId('')
    reload()
  }

  const keyword = query.trim()
  const searching = keyword.length > 0
  // 只有结果对应的关键词与当前输入一致时才展示，输入过程中不闪「无结果」
  const ready = searchState !== null && searchState.query === keyword
  const docById = useMemo(() => new Map(documents.map((doc) => [doc.doc_id, doc])), [documents])
  // 派生列表只在数据 / 搜索状态变化时重算，输入框每敲一个字不再整表重建
  const rows: DocumentRow[] = useMemo(() => {
    if (!searching) {
      return documents
    }
    if (!ready || !searchState) {
      return []
    }
    return searchState.hits.map((hit) => {
      const full = docById.get(hit.doc_id)
      // 命中的资料一定来自同一份列表；退化时给一份只含搜索字段的兜底视图
      const base: DocumentView = full ?? {
        doc_id: hit.doc_id,
        file_name: hit.file_name,
        excerpt: hit.excerpt,
        chunk_count: 0,
        subject: hit.subject,
        tags: [],
        source: '',
        char_count: 0,
        kg_node_count: 0,
        review_card_count: 0,
      }
      return {
        ...base,
        subject: hit.subject || base.subject,
        matchExcerpt: hit.excerpt,
        // score 为 0 表示命中来自文件名 / 科目 / 标签，其余为正文片段
        matchSource: hit.score > 0 ? '正文片段' : '文件名 / 科目',
      }
    })
  }, [documents, searching, ready, searchState, docById])
  const showEmptySearch = searching && ready && !searchState?.notice && rows.length === 0

  return (
    <div className="docs-page">
      <div className="notice snackbar">{notice}</div>
      <PageIntro eyebrow="YOUR KNOWLEDGE BASE / 03" title="学习资料" description="把笔记和讲义留在本机，整理成随时可用的学习线索。" />

      <div className="mine-card">
        <div className="card-title">粘贴导入</div>
        <div className="card-desc">
          把笔记、提纲或教材片段粘进来。切片与检索都在本机完成 —— 不联网、不上传，也不需要额外服务。
        </div>

        <label className="file-upload">
          <input
            type="file"
            multiple
            accept=".txt,.md,.markdown,.mdx,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="file-input"
            onChange={(event) => {
              pickFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <span className="file-upload-inner">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            从本机选择文件（.txt / .md / .pdf / .docx，可多选）
          </span>
        </label>
        <div className="card-hint">
          文本类上限 2MB，PDF 与 docx 上限 30MB。PDF 由本机 pdf.js 逐页抽取文字，docx 由本机 mammoth 解析（扫描件是图片，需要 OCR，暂不支持）。
        </div>

        <input
          className="mine-input"
          placeholder="资料名，如 高数错题笔记"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          className="mine-textarea"
          placeholder="在这里粘贴资料内容…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={8}
        />
        <button
          type="button"
          className={`primary-button${busy || !text.trim() ? ' disabled' : ''}`}
          disabled={busy || !text.trim()}
          onClick={importDoc}
        >
          {busy ? '正在导入…' : '导入资料'}
        </button>
      </div>

      <div className="mine-card">
        <div className="card-title">已导入（{documents.length}）</div>
        <input
          className="search-input"
          placeholder="搜索资料（文件名 / 科目 / 正文）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching && ready && searchState.notice && (
          <div className="search-status is-error">{searchState.notice}</div>
        )}
        {showEmptySearch && <div className="search-status">没有匹配结果</div>}
        {!searching && documents.length === 0 && (
          <div className="card-desc">
            还没有资料。导入后生成计划时，会用 BM25 检索这些内容作为参考。
          </div>
        )}
        {rows.map((doc) => (
          <div key={doc.doc_id} className="doc-row">
            <div className="doc-info">
              <div className="doc-title-row">
                <span className="doc-name">{doc.file_name}</span>
                {!!doc.subject && <span className="doc-subject">{doc.subject}</span>}
                {doc.source === 'paste' && <span className="doc-source">粘贴</span>}
              </div>
              <div className="doc-meta">
                {doc.chunk_count} 个片段
                {Number(doc.char_count) > 0 ? ` · ${doc.char_count} 字` : ''}
                {Number(doc.kg_node_count) > 0 ? ` · ${doc.kg_node_count} 个知识点` : ''}
                {Number(doc.review_card_count) > 0
                  ? ` · ${doc.review_card_count} 张复习卡`
                  : ''}
              </div>
              {!!(doc.tags ?? []).length && (
                <div className="doc-tags">
                  {(doc.tags ?? []).map((tag) => (
                    <span key={tag} className="doc-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {doc.matchExcerpt ? (
                <div className="doc-excerpt">
                  {!!doc.matchSource && <span className="doc-match-source">{doc.matchSource}</span>}
                  {doc.matchExcerpt}
                </div>
              ) : (
                !!doc.excerpt && <div className="doc-excerpt">{doc.excerpt}</div>
              )}
            </div>
            <div className="doc-actions">
              <button
                type="button"
                className="doc-build"
                disabled={Boolean(learningDocId)}
                onClick={() => oneClickLearn(doc)}
              >
                {learningDocId === doc.doc_id ? '学习中…' : '一键学习化'}
              </button>
              <button
                type="button"
                className="doc-build"
                disabled={Boolean(buildingDocId)}
                onClick={() => buildGraph(doc)}
              >
                {buildingDocId === doc.doc_id ? '构建中…' : '构建图谱'}
              </button>
              <button type="button" className="doc-edit" onClick={() => startEdit(doc)}>
                编辑
              </button>
              <button type="button" className="doc-remove" onClick={() => removeDoc(doc)}>
                删除
              </button>
            </div>
            {editingId === doc.doc_id && (
              <div className="doc-editor">
                <input
                  className="mine-input"
                  placeholder="资料名"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                />
                <input
                  className="mine-input"
                  placeholder="科目，如 高等数学"
                  value={draftSubject}
                  onChange={(event) => setDraftSubject(event.target.value)}
                />
                <input
                  className="mine-input"
                  placeholder="标签，用、分隔（可空）"
                  value={draftTags}
                  onChange={(event) => setDraftTags(event.target.value)}
                />
                <div className="doc-editor-actions">
                  <button type="button" className="primary-button" onClick={() => saveEdit(doc)}>
                    保存
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setEditingId('')}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
