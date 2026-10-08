import { useEffect, useMemo, useRef, useState } from 'react'
import { getCore, getActiveUserId, setActiveUserId, currentRuntimeMode } from '../services/synapse'
import { useFlash } from '../utils/useFlash'
import PageIntro from '../components/PageIntro'

type MineTarget = 'graph' | 'documents' | 'timetable'

interface MineViewProps {
  onNavigate: (target: MineTarget) => void
}

interface DashboardView {
  today: { date: string; total: number; done_count: number; rate: number }
  week: { days: Array<{ date: string; done_count: number }>; active_days: number; done_count: number }
  assignments: { total: number; pending: number; done: number; overdue: number }
  reviews: { total: number; due_count: number }
  documents: number
  subjects: Array<{ name: string; level: number; skill_score: number }>
  plan: { version: number; updated_at: string }
}

interface WeeklyReportView {
  id: string
  created_at: string
  narrative: string
  degraded: boolean
  stats: {
    window_start: string
    window_end: string
    done_count: number
    total_count: number
    completion_rate: number
    ability_delta: Record<string, number>
    overdue_count: number
    review_done: number
    streak_days: number
  }
}

interface LocalUser {
  user_id: string
  display_name: string
  updated_at: string
}

interface MemoryRow {
  kind: string
  label: string
  value: string
  updated_at: string
}

interface TrendPoint {
  date: string
  done_count: number
  minutes: number
}

interface TrendSubject {
  subject: string
  points: Array<{ date: string; score: number }>
  first_score: number
  last_score: number
  delta: number
}

interface TrendView {
  days: number
  from: string
  to: string
  daily: TrendPoint[]
  subjects: TrendSubject[]
  totals: { done_count: number; minutes: number; active_days: number; streak_days: number }
}

export default function MineView({ onNavigate }: MineViewProps) {
  const [profile, setProfile] = useState<Record<string, unknown>>({})
  const [name, setName] = useState('')
  const [grade, setGrade] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [checking, setChecking] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [keyFormOpen, setKeyFormOpen] = useState(false)
  const [deepseekConfigured, setDeepseekConfigured] = useState(false)
  const [kgSummary, setKgSummary] = useState<Record<string, unknown>>({})
  const [timetableCount, setTimetableCount] = useState(0)
  const [subjects, setSubjects] = useState<Array<{ name: string; source: string }>>([])
  const [documentCount, setDocumentCount] = useState(0)
  const [dashboard, setDashboard] = useState<DashboardView | null>(null)
  const [loadingDemo, setLoadingDemo] = useState(false)
  const [report, setReport] = useState<WeeklyReportView | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)
  const [users, setUsers] = useState<LocalUser[]>([])
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [confirmUserDelete, setConfirmUserDelete] = useState('')
  const [importing, setImporting] = useState(false)
  const [trendDays, setTrendDays] = useState(7)
  const [trend, setTrend] = useState<TrendView | null>(null)
  const [notifyPermission, setNotifyPermission] = useState<string>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const importInputRef = useRef<HTMLInputElement | null>(null)
  // 运行模式只跟「有没有配 Key」有关：缓存起来，别每次渲染都同步读一遍 core
  const runtime = useMemo(() => currentRuntimeMode(), [deepseekConfigured])
  // 档案列表每行都要判断是不是当前档案，这里算一次就够了
  const activeUserId = getActiveUserId()
  const [notice, flash] = useFlash()

  const load = () => {
    const profileRes = getCore().getProfile(getActiveUserId())
    const data = (profileRes.data ?? {}) as Record<string, unknown>
    setProfile(data)
    setName(String(data['display_name'] ?? ''))
    const gradeValue = String(data['grade'] ?? '')
    setGrade(gradeValue === '未填写' ? '' : gradeValue)

    const statusRes = getCore().settingsStatus()
    setDeepseekConfigured(
      Boolean((statusRes.data as Record<string, unknown> | null)?.['deepseek_configured']),
    )

    const kgRes = getCore().getGraphSummary(getActiveUserId())
    setKgSummary((kgRes.data ?? {}) as Record<string, unknown>)

    const timetableRes = getCore().getTimetable(getActiveUserId())
    setTimetableCount(Number((timetableRes.data as Record<string, unknown> | null)?.['total'] ?? 0))

    const subjectRes = getCore().listSubjects(getActiveUserId())
    setSubjects(
      ((subjectRes.data as Record<string, unknown> | null)?.['subjects'] ??
        []) as Array<{ name: string; source: string }>,
    )

    const docRes = getCore().listDocuments(getActiveUserId())
    setDocumentCount(Number((docRes.data as Record<string, unknown> | null)?.['total'] ?? 0))

    const dashboardRes = getCore().getDashboard(getActiveUserId())
    setDashboard((dashboardRes.data as unknown as DashboardView) ?? null)

    const reportRes = getCore().listWeeklyReports(getActiveUserId())
    setReport(
      ((reportRes.data as Record<string, unknown> | null)?.['latest'] ?? null) as WeeklyReportView | null,
    )

    const usersRes = getCore().listUsers()
    setUsers(((usersRes.data as Record<string, unknown> | null)?.['users'] ?? []) as LocalUser[])

    const memoryRes = getCore().listMemories(getActiveUserId())
    setMemories(
      ((memoryRes.data as Record<string, unknown> | null)?.['memories'] ?? []) as MemoryRow[],
    )
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 学习趋势按天数窗口单独加载：切换 7/30/90 天时只重算这一块
  useEffect(() => {
    const res = getCore().getTrends(getActiveUserId(), trendDays)
    setTrend((res.data as unknown as TrendView) ?? null)
  }, [trendDays])

  /** A3：切换本地档案。数据分桶在 core 里，切换后必须刷新才能让首屏读到新桶。 */
  const switchUser = (id: string) => {
    setActiveUserId(id)
    window.location.reload()
  }

  const createProfile = () => {
    const input = window.prompt('给这个本地档案起个名字')
    if (input === null) {
      return
    }
    const displayName = input.trim()
    if (!displayName) {
      flash('名字不能为空')
      return
    }
    const userId = `u-${crypto.randomUUID()}`
    const result = getCore().createUser(userId, displayName)
    console.log('[Synapse] 新建档案', result.success, result.message)
    flash(result.message)
    load()
  }

  const removeUser = (id: string) => {
    if (confirmUserDelete !== id) {
      setConfirmUserDelete(id)
      return
    }
    const result = getCore().deleteUser(id)
    console.log('[Synapse] 删除档案', id, result.success)
    setConfirmUserDelete('')
    flash(result.message)
    load()
  }

  /** B1：导入此前导出的 JSON。文件内容是 import_user_data 直接可吃的 payload。 */
  const importJson = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) {
      return
    }
    setImporting(true)
    try {
      const text = await file.text()
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(text) as Record<string, unknown>
      } catch {
        flash('不是合法的 JSON 文件')
        return
      }
      const result = getCore().importData(getActiveUserId(), payload)
      console.log('[Synapse] 数据导入', result.success, result.message)
      if (result.success) {
        window.alert(result.message)
        window.location.reload()
      } else {
        flash(result.message)
      }
    } finally {
      setImporting(false)
    }
  }

  /** B2：删除一条 AI 记忆。weak_points 传 value 只删该条，其余类型清空该字段。 */
  const removeMemory = (memory: MemoryRow) => {
    const result =
      memory.kind === 'weak_points'
        ? getCore().deleteMemory(getActiveUserId(), memory.kind, memory.value)
        : getCore().deleteMemory(getActiveUserId(), memory.kind)
    console.log('[Synapse] 删除记忆', memory.kind, result.success)
    flash(result.message)
    setMemories(
      ((result.data as Record<string, unknown> | null)?.['memories'] ?? []) as MemoryRow[],
    )
  }

  /** F：开启到期提醒（Web Notification）。 */
  const enableNotify = async () => {
    if (typeof Notification === 'undefined') {
      flash('当前浏览器不支持到期提醒')
      return
    }
    try {
      const permission = await Notification.requestPermission()
      setNotifyPermission(permission)
      flash(permission === 'granted' ? '已开启到期提醒' : '未获得通知权限')
    } catch (error) {
      console.error('[Synapse] 申请通知权限失败', error)
      flash('申请通知权限失败')
    }
  }

  const removeSubject = (subjectName: string) => {
    const result = getCore().removeSubject(getActiveUserId(), subjectName)
    console.log('[Synapse] 移除科目', subjectName, result.success)
    flash(result.message)
    load()
  }

  const saveProfile = () => {
    const result = getCore().saveProfile(
      getActiveUserId(),
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
      setKeyFormOpen(false)
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
    const result = getCore().deleteAllUserData(getActiveUserId())
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
      const result = await getCore().loadDemoData(getActiveUserId())
      console.log('[Synapse] 载入演示数据', result.success, result.message)
      flash(result.message)
      load()
    } finally {
      setLoadingDemo(false)
    }
  }

  /** G3：现场生成一期学情周报（演示时可以直接点）。 */
  const generateReport = async () => {
    if (generatingReport) {
      return
    }
    setGeneratingReport(true)
    try {
      const result = await getCore().generateWeeklyReport(getActiveUserId())
      console.log('[Synapse] 生成周报', result.success, result.message)
      flash(result.message)
      load()
    } finally {
      setGeneratingReport(false)
    }
  }

  /** F4.2：一键导出全部本地数据为 JSON 文件（数据主权归用户）。 */
  const exportJson = () => {
    const result = getCore().exportData(getActiveUserId())
    if (!result.success) {
      flash(result.message)
      return
    }
    const payload = (result.data ?? {}) as Record<string, unknown>
    const json = JSON.stringify(payload['data'] ?? {}, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = String(payload['filename'] ?? 'synapse-export.json')
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    console.log('[Synapse] 数据已导出', link.download)
    flash(result.message)
  }

  const nameLocked = Boolean(profile['display_name'])
  const nodeCount = Number(kgSummary['node_count'] ?? 0)
  const edgeCount = Number(kgSummary['edge_count'] ?? 0)
  // 柱状图归一化基准：全 0 时用 1 兜底，避免除零把柱子画成 NaN 高
  const trendMax = Math.max(1, ...(trend?.daily ?? []).map((point) => point.done_count))
  const demoEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === 'true'

  return (
    <div className="mine-page">
      <div className="notice snackbar">{notice}</div>
      <PageIntro eyebrow="YOUR PROGRESS / 05" title="我的空间" description="回看每一点积累，管理自己的科目、数据与学习方式。" />
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

      <p className="mine-group-title">今日状态</p>

      <div className="mine-card">
        <div className="card-title">学习仪表盘</div>
        <div className="card-desc">
          数据闭环一图流：今天做了多少、这周坚持了几天、有没有欠账、能力值往哪走。
        </div>
        <div className="dashboard-grid">
          <div className="dashboard-metric">
            <span className="dashboard-value">{dashboard?.today.rate ?? 0}%</span>
            <span className="dashboard-label">
              今日完成率（{dashboard?.today.done_count ?? 0}/{dashboard?.today.total ?? 0}）
            </span>
          </div>
          <div className="dashboard-metric">
            <span className="dashboard-value">{dashboard?.week.active_days ?? 0}/7</span>
            <span className="dashboard-label">本周打卡天数</span>
          </div>
          <div className="dashboard-metric">
            <span className="dashboard-value">{dashboard?.assignments.overdue ?? 0}</span>
            <span className="dashboard-label">逾期作业</span>
          </div>
          <div className="dashboard-metric">
            <span className="dashboard-value">{dashboard?.reviews.due_count ?? 0}</span>
            <span className="dashboard-label">今天该复习</span>
          </div>
        </div>
        {(dashboard?.subjects ?? []).length > 0 && (
          <div className="dashboard-abilities">
            {(dashboard?.subjects ?? []).map((subject) => (
              <div key={subject.name} className="ability-row">
                <span className="ability-name">{subject.name}</span>
                <span className="ability-track">
                  <span
                    className="ability-fill"
                    style={{ width: `${Math.min(100, (subject.skill_score / 5) * 100)}%` }}
                  />
                </span>
                <span className="ability-level">Lv.{subject.level}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mine-card">
        <div className="row-between">
          <span className="card-title-inline">学习趋势</span>
          <div className="trend-toggle">
            {[7, 30, 90].map((days) => (
              <button
                key={days}
                type="button"
                className={`trend-toggle-btn${trendDays === days ? ' active' : ''}`}
                onClick={() => setTrendDays(days)}
              >
                {days} 天
              </button>
            ))}
          </div>
        </div>
        <div className="card-desc">
          最近 {trend?.days ?? trendDays} 天的完成情况与各科目能力值走势，全部在本机计算。
        </div>
        {trend && trend.daily.length > 0 ? (
          <>
            <svg className="trend-chart" viewBox="0 0 320 110" role="img" aria-label="每日完成数柱状图">
              <line x1="0" y1="100" x2="320" y2="100" className="trend-axis" />
              {trend.daily.map((point, index) => {
                const barWidth = 320 / trend.daily.length
                const height = (point.done_count / trendMax) * 90
                return (
                  <rect
                    key={point.date}
                    x={index * barWidth + 1}
                    y={100 - height}
                    width={Math.max(1, barWidth - 2)}
                    height={height}
                    className="trend-bar"
                  >
                    <title>{`${point.date}：完成 ${point.done_count} 项`}</title>
                  </rect>
                )
              })}
            </svg>
            <div className="report-stats">
              <div className="report-stat">
                <span className="report-value">{trend.totals.done_count}</span>
                <span className="report-label">完成数</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{trend.totals.minutes}</span>
                <span className="report-label">总用时(分)</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{trend.totals.active_days}</span>
                <span className="report-label">活跃天数</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{trend.totals.streak_days}</span>
                <span className="report-label">连续打卡</span>
              </div>
            </div>
            {trend.subjects.length > 0 && (
              <div className="trend-subjects">
                {trend.subjects.map((subject) => (
                  <div key={subject.subject} className="trend-subject-row">
                    <span className="trend-subject-name">{subject.subject}</span>
                    <span
                      className={`trend-delta${subject.delta > 0 ? ' up' : subject.delta < 0 ? ' down' : ''}`}
                    >
                      {subject.delta > 0 ? `+${subject.delta}` : subject.delta}
                    </span>
                    <span className="trend-score">当前 {subject.last_score}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="feedback">这段时间还没有学习记录，先去「计划」页打几次卡。</div>
        )}
      </div>

      <div className="mine-card">
        <div className="card-title">AI 学情周报</div>
        <div className="card-desc">
          完成率、能力值变化、逾期、复习与连续打卡都由本机离线算好，模型只负责把它写成一段学情叙述；
          没配 Key 也能出，只是换成模板文案并标注「离线模板」。
        </div>
        {report ? (
          <>
            <div className="report-stats">
              <div className="report-stat">
                <span className="report-value">
                  {report.stats.done_count}/{report.stats.total_count}
                </span>
                <span className="report-label">本周完成</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{report.stats.completion_rate}%</span>
                <span className="report-label">完成率</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{report.stats.overdue_count}</span>
                <span className="report-label">逾期作业</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{report.stats.review_done}</span>
                <span className="report-label">本周复习</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{report.stats.streak_days}</span>
                <span className="report-label">连续打卡</span>
              </div>
            </div>
            {Object.keys(report.stats.ability_delta ?? {}).length > 0 && (
              <div className="report-abilities">
                {Object.entries(report.stats.ability_delta).map(([subject, delta]) => (
                  <span key={subject} className="report-ability">
                    {subject} {delta > 0 ? `+${delta}` : delta}
                  </span>
                ))}
              </div>
            )}
            <div className="report-narrative">
              {report.degraded && <span className="report-flag">离线模板</span>}
              <span>{report.narrative}</span>
            </div>
            <div className="report-window">
              统计窗口 {report.stats.window_start} ~ {report.stats.window_end}（本机最多保留 8 期）
            </div>
          </>
        ) : (
          <div className="feedback">还没生成过周报，点下面的按钮现场生成一期。</div>
        )}
        <button
          type="button"
          className="primary-button"
          onClick={generateReport}
          disabled={generatingReport}
        >
          {generatingReport ? '生成中…' : report ? '重新生成本周周报' : '生成本周周报'}
        </button>
      </div>

      <p className="mine-group-title">学习资产</p>

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
        <div className="card-title">AI 记忆</div>
        <div className="card-desc">
          这些是 AI 在对话里记住的关于你的内容（薄弱点、偏好、约束等）。记错了可以逐条删掉。
        </div>
        {memories.length === 0 && <div className="feedback">AI 还没记住什么</div>}
        {memories.map((memory) => (
          <div key={`${memory.kind}-${memory.value}`} className="memory-row">
            <div className="memory-info">
              <span className="memory-label">{memory.label}</span>
              <span className="memory-value">{memory.value}</span>
            </div>
            <button type="button" className="subject-remove" onClick={() => removeMemory(memory)}>
              删除
            </button>
          </div>
        ))}
      </div>

      <button type="button" className="mine-card mine-link-card" onClick={() => onNavigate('timetable')}>
        <div className="row-between">
          <span className="card-title-inline">我的课程表</span>
          <span className="row-arrow">›</span>
        </div>
        <div className="card-desc">
          {timetableCount > 0
            ? `已录入 ${timetableCount} 节课，生成计划时会自动避开上课时段。`
            : '还没录入课程。导入或手动录入后，计划会自动避开上课时间。'}
        </div>
      </button>

      <button type="button" className="mine-card mine-link-card" onClick={() => onNavigate('documents')}>
        <div className="row-between">
          <span className="card-title-inline">资料库</span>
          <span className="row-arrow">›</span>
        </div>
        <div className="card-desc">
          {documentCount > 0
            ? `已导入 ${documentCount} 份资料，生成计划时会用本地 BM25 检索它们作为参考。`
            : '粘贴笔记或教材片段，切片与检索都在本机完成，不联网、不上传。'}
        </div>
      </button>

      <button type="button" className="mine-card mine-link-card" onClick={() => onNavigate('graph')}>
        <div className="row-between">
          <span className="card-title-inline">知识图谱</span>
          <span className="row-arrow">›</span>
        </div>
        <div className="card-desc">
          {nodeCount > 0
            ? `共 ${nodeCount} 个节点、${edgeCount} 条边，全部由你的资料构建。`
            : '还没有节点。导入资料并在资料库里点「构建图谱」，知识点和它们的关系会长在这里。'}
        </div>
      </button>

      <p className="mine-group-title">设置</p>

      <div className="mine-card">
        <div className="card-title">本地档案</div>
        <div className="card-desc">
          每一份档案都是一个完全隔离的本地数据桶，切换后各自的学习记录互不影响。
        </div>
        {users.map((user) => {
          const active = user.user_id === activeUserId
          return (
            <div key={user.user_id} className={`profile-row${active ? ' active' : ''}`}>
              <div className="profile-info">
                <span className="profile-name">{user.display_name || user.user_id}</span>
                {active && <span className="profile-badge">当前</span>}
              </div>
              <div className="profile-actions">
                {!active && (
                  <button
                    type="button"
                    className="profile-switch"
                    onClick={() => switchUser(user.user_id)}
                  >
                    切换
                  </button>
                )}
                {user.user_id !== 'default' && (
                  <button
                    type="button"
                    className="subject-remove"
                    onClick={() => removeUser(user.user_id)}
                  >
                    {confirmUserDelete === user.user_id ? '确认删除' : '删除'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
        <button type="button" className="secondary-button" onClick={createProfile}>
          新建档案
        </button>
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
        <div className="row-between">
          <span className="card-title-inline">AI 模型接入</span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setKeyFormOpen((open) => !open)
              setFeedback('')
            }}
          >
            {keyFormOpen ? '收起' : deepseekConfigured ? '更换 Key' : '配置 Key'}
          </button>
        </div>
        <div className="card-desc">
          {deepseekConfigured
            ? '已接入 DeepSeek。Key 只保存在本设备，设备直连模型商，不经过任何中间服务器。'
            : '当前用本地规则模式：不填 Key 也能用，填上之后理解和表达会更贴近你的说法。'}
        </div>
        {keyFormOpen && (
          <>
            <input
              type="password"
              className="mine-input"
              placeholder={deepseekConfigured ? '输入新 Key 可覆盖' : 'sk-...'}
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
          </>
        )}
        {!keyFormOpen && !!feedback && <div className="feedback">{feedback}</div>}
      </div>

      <div className="mine-card">
        <div className="card-title">数据管理</div>
        <div className="card-desc">
          画像、计划、进度、课程表与 API Key 都只保存在这台设备上。数据主权归你：随时可以导出成 JSON
          带走。
        </div>
        <button type="button" className="secondary-button" onClick={exportJson}>
          导出 JSON 数据
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="file-input"
          onChange={(event) => {
            const files = event.target.files
            void importJson(files)
            event.target.value = ''
          }}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={importing}
          onClick={() => importInputRef.current?.click()}
        >
          {importing ? '正在导入…' : '导入 JSON 数据'}
        </button>
        {demoEnabled && (
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

      <div className="mine-card">
        <div className="card-title">到期提醒</div>
        <div className="card-desc">
          开启后，每天首次打开应用时，如果有到期的复习知识点会弹一条系统通知。通知内容只在本机生成。
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={notifyPermission === 'unsupported' || notifyPermission === 'granted'}
          onClick={enableNotify}
        >
          {notifyPermission === 'unsupported'
            ? '当前浏览器不支持通知'
            : notifyPermission === 'granted'
              ? '已开启到期提醒'
              : notifyPermission === 'denied'
                ? '通知权限被拒绝，请在浏览器设置中开启'
                : '开启到期提醒'}
        </button>
      </div>
    </div>
  )
}
