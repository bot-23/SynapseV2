import { useEffect, useState } from 'react'
import { getCore, DEFAULT_USER_ID, currentRuntimeMode } from '../services/synapse'

interface MineViewProps {
  onOpenGraph: () => void
}

export default function MineView({ onOpenGraph }: MineViewProps) {
  const [profile, setProfile] = useState<Record<string, unknown>>({})
  const [name, setName] = useState('')
  const [grade, setGrade] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [checking, setChecking] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [deepseekConfigured, setDeepseekConfigured] = useState(false)
  const [kgSummary, setKgSummary] = useState<Record<string, unknown>>({})
  const [timetableCount, setTimetableCount] = useState(0)
  const [subjects, setSubjects] = useState<Array<{ name: string; source: string }>>([])
  const [documentCount, setDocumentCount] = useState(0)
  const [documentNodeCount, setDocumentNodeCount] = useState(0)
  const [notice, setNotice] = useState('')
  const [loadingDemo, setLoadingDemo] = useState(false)
  const runtime = currentRuntimeMode()

  const flash = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2600)
  }

  const load = () => {
    const profileRes = getCore().getProfile(DEFAULT_USER_ID)
    const data = (profileRes.data ?? {}) as Record<string, unknown>
    setProfile(data)
    setName(String(data['display_name'] ?? ''))
    const gradeValue = String(data['grade'] ?? '')
    setGrade(gradeValue === '未填写' ? '' : gradeValue)

    const statusRes = getCore().settingsStatus()
    setDeepseekConfigured(
      Boolean((statusRes.data as Record<string, unknown> | null)?.['deepseek_configured']),
    )

    const kgRes = getCore().getGraphSummary()
    setKgSummary((kgRes.data ?? {}) as Record<string, unknown>)
    const graphRes = getCore().getKnowledgeGraph()
    setDocumentNodeCount(
      Number((graphRes.data as Record<string, unknown> | null)?.['document_node_count'] ?? 0),
    )

    const timetableRes = getCore().getTimetable(DEFAULT_USER_ID)
    setTimetableCount(Number((timetableRes.data as Record<string, unknown> | null)?.['total'] ?? 0))

    const subjectRes = getCore().listSubjects(DEFAULT_USER_ID)
    setSubjects(
      ((subjectRes.data as Record<string, unknown> | null)?.['subjects'] ??
        []) as Array<{ name: string; source: string }>,
    )

    const docRes = getCore().listDocuments(DEFAULT_USER_ID)
    setDocumentCount(Number((docRes.data as Record<string, unknown> | null)?.['total'] ?? 0))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeSubject = (subjectName: string) => {
    const result = getCore().removeSubject(DEFAULT_USER_ID, subjectName)
    console.log('[Synapse] 移除科目', subjectName, result.success)
    flash(result.message)
    load()
  }

  const saveProfile = () => {
    const result = getCore().saveProfile(
      DEFAULT_USER_ID,
      name.trim() || null,
      grade.trim() || null,
    )
    console.log('[Synapse] 保存画像', result.success, result.message)
    flash(result.message)
    if (result.success) {
      load()
    }
  }

  const checkAndSaveKey = async () => {
    const key = apiKey.trim()
    if (!key) {
      setFeedback('请先填写 API Key')
      return
    }
    setChecking(true)
    setFeedback('')
    try {
      const validated = await getCore().validateApiKey(key)
      if (!validated.success) {
        console.error('[Synapse] Key 校验失败', validated.message)
        setFeedback(validated.message)
        return
      }
      const saved = getCore().saveApiKey(key)
      console.log('[Synapse] Key 已保存', saved.message)
      setFeedback(saved.message)
      setApiKey('')
      load()
    } catch (error) {
      console.error('[Synapse] Key 校验异常', error)
      setFeedback(`校验失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setChecking(false)
    }
  }

  const clearAll = () => {
    if (!window.confirm('将删除画像、计划、进度、课程表与 API Key，且不可恢复。确定继续吗？')) {
      return
    }
    const result = getCore().deleteAllUserData(DEFAULT_USER_ID)
    console.log('[Synapse] 清空数据', result.success)
    flash(result.message)
    setFeedback('')
    load()
  }

  const loadDemo = async () => {
    if (loadingDemo) {
      return
    }
    setLoadingDemo(true)
    try {
      const result = await getCore().loadDemoData(DEFAULT_USER_ID)
      console.log('[Synapse] 载入演示数据', result.success, result.message)
      flash(result.message)
      load()
    } finally {
      setLoadingDemo(false)
    }
  }

  const nameLocked = Boolean(profile['display_name'])

  return (
    <div className="mine-page">
      <div className="notice snackbar">{notice}</div>
      <div className="mine-header">
        <div className="mine-avatar">{nameLocked ? String(profile['display_name']).slice(0, 1) : '我'}</div>
        <div className="mine-header-info">
          <div className="mine-header-name">
            {nameLocked ? String(profile['display_name']) : '未设置姓名'}
          </div>
          <div className="mine-header-meta">
            {grade || '未填写年级'} ·{' '}
            {deepseekConfigured ? `已连接 ${runtime.model}` : '本地规则模式'}
          </div>
        </div>
      </div>

      <div className="mine-card">
        <div className="card-title">学习画像</div>
        <div className="card-desc">年级与姓名会用于调整计划的语气和难度描述。</div>
        <div className="field-label">姓名{nameLocked ? '（已设定，不可修改）' : ''}</div>
        {nameLocked ? (
          <div className="field-value">{String(profile['display_name'])}</div>
        ) : (
          <input
            className="mine-input"
            placeholder="给自己起个名字"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
        <div className="field-label">年级</div>
        <input
          className="mine-input"
          placeholder="例如：大二"
          value={grade}
          onChange={(event) => setGrade(event.target.value)}
        />
        <button type="button" className="primary-button" onClick={saveProfile}>
          保存画像
        </button>
      </div>

      <div className="mine-card">
        <div className="card-title">我的科目</div>
        <div className="card-desc">
          对话里提到的科目会记在这里，跨对话保留；生成计划时按这些科目一起排。识别错了可以删掉。
        </div>
        {subjects.length === 0 && (
          <div className="feedback">还没有科目，去「对话」页说说你要学什么。</div>
        )}
        {subjects.map((subject) => (
          <div key={subject.name} className="subject-row">
            <div className="subject-info">
              <span className="subject-name">{subject.name}</span>
              {!!subject.source && <span className="subject-source">{subject.source}</span>}
            </div>
            <button type="button" className="subject-remove" onClick={() => removeSubject(subject.name)}>
              删除
            </button>
          </div>
        ))}
      </div>

      <div className="mine-card">
        <div className="card-title">DeepSeek API Key</div>
        <div className="card-desc">
          Key 只保存在本设备，设备直连模型商，不经过任何中间服务器。保存前会先发一次真实请求校验。
        </div>
        <input
          type="password"
          className="mine-input"
          placeholder={deepseekConfigured ? '已配置，输入新 Key 可覆盖' : 'sk-...'}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value)
            setFeedback('')
          }}
        />
        {!!feedback && <div className="feedback">{feedback}</div>}
        <button
          type="button"
          className={`primary-button${checking ? ' disabled' : ''}`}
          disabled={checking}
          onClick={checkAndSaveKey}
        >
          {checking ? '正在校验…' : '校验并保存'}
        </button>
      </div>

      <div className="mine-card">
        <div className="row-between">
          <span className="card-title-inline">我的课程表</span>
          <span className="row-arrow">›</span>
        </div>
        <div className="card-desc">
          {timetableCount > 0
            ? `已录入 ${timetableCount} 节课，生成计划时会自动避开上课时段。`
            : '还没录入课程。导入或手动录入后，计划会自动避开上课时间。'}
        </div>
      </div>

      <div className="mine-card">
        <div className="row-between">
          <span className="card-title-inline">资料库</span>
          <span className="row-arrow">›</span>
        </div>
        <div className="card-desc">
          {documentCount > 0
            ? `已导入 ${documentCount} 份资料，生成计划时会用本地 BM25 检索它们作为参考。`
            : '粘贴笔记或教材片段，切片与检索都在本机完成，不联网、不上传。'}
        </div>
      </div>

      <button type="button" className="mine-card graph-entry" onClick={onOpenGraph}>
        <div className="row-between">
          <div className="card-title">知识图谱</div>
          <span className="row-arrow">›</span>
        </div>
        <div className="card-desc">
          共 {String(kgSummary['node_count'] ?? '-')} 个节点、{String(kgSummary['edge_count'] ?? '-')} 条边，其中 {documentNodeCount} 个来自资料。
        </div>
      </button>

      <div className="mine-card">
        <div className="card-title">数据管理</div>
        <div className="card-desc">画像、计划、进度、课程表与 API Key 都只保存在这台设备上。</div>
        {(import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === 'true') && (
          <button
            type="button"
            className="primary-button muted"
            disabled={loadingDemo}
            onClick={loadDemo}
          >
            {loadingDemo ? '正在载入…' : '载入演示数据'}
          </button>
        )}
        <button type="button" className="danger-button" onClick={clearAll}>
          清空全部数据
        </button>
      </div>
    </div>
  )
}
