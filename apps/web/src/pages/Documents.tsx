import { useEffect, useState } from 'react'
import { getCore, DEFAULT_USER_ID } from '../services/synapse'

interface DocumentView {
  doc_id: string
  file_name: string
  excerpt: string
  chunk_count: number
}

const MAX_FILE_SIZE = 2 * 1024 * 1024

export default function DocumentsView() {
  const [documents, setDocuments] = useState<DocumentView[]>([])
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [buildingDocId, setBuildingDocId] = useState('')
  const [notice, setNotice] = useState('')

  const flash = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2600)
  }

  const load = () => {
    const result = getCore().listDocuments(DEFAULT_USER_ID)
    setDocuments(
      ((result.data as Record<string, unknown> | null)?.['documents'] ?? []) as DocumentView[],
    )
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const importDoc = () => {
    const content = text.trim()
    if (!content || busy) {
      return
    }
    setBusy(true)
    try {
      const result = getCore().importDocument(DEFAULT_USER_ID, name.trim(), content)
      console.log('[Synapse] 导入资料', result.success, result.message)
      flash(result.message)
      if (result.success) {
        setName('')
        setText('')
        load()
      }
    } finally {
      setBusy(false)
    }
  }

  const pickFile = async (file?: File | null) => {
    if (busy || !file) {
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      flash('文件请控制在 2MB 以内')
      return
    }
    setBusy(true)
    try {
      const content = await file.text()
      const attachments = await getCore().extractFiles([
        {
          name: file.name,
          contentType: file.type || 'text/plain',
          data: new TextEncoder().encode(content),
        },
      ])
      const attachment = attachments[0]
      if (!attachment || attachment.extraction_status !== 'done' || !attachment.extracted_text) {
        flash(attachment?.extraction_error || '这个文件没有提取到文本')
        return
      }
      const result = getCore().importDocument(
        DEFAULT_USER_ID,
        file.name || name.trim(),
        attachment.extracted_text,
      )
      console.log('[Synapse] 导入资料', result.success, result.message)
      flash(result.message)
      if (result.success) {
        setName('')
        setText('')
        load()
      }
    } catch (error) {
      console.log('[Synapse] 选择文件结束', error)
      flash('读取文件失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const removeDoc = (doc: DocumentView) => {
    if (!window.confirm(`删除「${doc.file_name}」？删掉之后检索不会再命中它。`)) {
      return
    }
    const result = getCore().removeDocument(DEFAULT_USER_ID, doc.doc_id)
    console.log('[Synapse] 删除资料', doc.doc_id, result.success)
    flash(result.message)
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
      flash(result.message)
    } finally {
      setBuildingDocId('')
    }
  }

  return (
    <div className="docs-page">
      <div className="notice snackbar">{notice}</div>

      <div className="mine-card">
        <div className="card-title">粘贴导入</div>
        <div className="card-desc">
          把笔记、提纲或教材片段粘进来。切片与检索都在本机完成 —— 不联网、不上传，也不需要额外服务。
        </div>

        <label className="file-upload">
          <input
            type="file"
            accept=".txt,text/plain"
            className="file-input"
            onChange={(event) => {
              pickFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <span className="file-upload-inner">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            从本机选择 .txt 文件
          </span>
        </label>

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
        {documents.length === 0 && (
          <div className="card-desc">
            还没有资料。导入后生成计划时，会用 BM25 检索这些内容作为参考。
          </div>
        )}
        {documents.map((doc) => (
          <div key={doc.doc_id} className="doc-row">
            <div className="doc-info">
              <div className="doc-name">{doc.file_name}</div>
              <div className="doc-meta">{doc.chunk_count} 个片段</div>
              {!!doc.excerpt && <div className="doc-excerpt">{doc.excerpt}</div>}
            </div>
            <div className="doc-actions">
              <button
                type="button"
                className="doc-build"
                disabled={Boolean(buildingDocId)}
                onClick={() => buildGraph(doc)}
              >
                {buildingDocId === doc.doc_id ? '构建中…' : '构建图谱'}
              </button>
              <button type="button" className="doc-remove" onClick={() => removeDoc(doc)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
