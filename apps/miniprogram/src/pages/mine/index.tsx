import { useState } from 'react'
import { View, Text, Input, Textarea, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import {
  getCore,
  getActiveUserId,
  setActiveUserId,
  currentRuntimeMode
} from '../../services/synapse'
import type { LearningTrends, MemoryEntry } from '../../vendor/core'
import styles from './index.module.scss'

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

interface UserView {
  user_id: string
  display_name: string
  updated_at: string
}

/** 学习趋势的柱状图窗口档位。 */
const TREND_DAY_OPTIONS = [7, 30, 90]

export default function MinePage() {
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
  const [assignmentCount, setAssignmentCount] = useState(0)
  const [assignmentOverdue, setAssignmentOverdue] = useState(0)
  const [dashboard, setDashboard] = useState<DashboardView | null>(null)
  const [loadingDemo, setLoadingDemo] = useState(false)
  const [report, setReport] = useState<WeeklyReportView | null>(null)
  const [generatingReport, setGeneratingReport] = useState(false)
  /** A：本地多用户档案 */
  const [activeUserId, setActiveUser] = useState(getActiveUserId())
  const [users, setUsers] = useState<UserView[]>([])
  /** B：数据导入 */
  const [importText, setImportText] = useState('')
  /** B：AI 记忆 */
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  /** C：学习趋势 */
  const [trends, setTrends] = useState<LearningTrends | null>(null)
  const [trendDays, setTrendDays] = useState(7)
  const runtime = currentRuntimeMode()

  const loadUsers = () => {
    const result = getCore().listUsers()
    const data = (result.data ?? {}) as Record<string, unknown>
    const list = ((data['users'] ?? []) as UserView[]).slice()
    const current = getActiveUserId()
    // list_users 只返回画像存在的档案；当前档案可能还没画像行，补一条保证能高亮与切换。
    if (!list.some((item) => item.user_id === current)) {
      list.unshift({ user_id: current, display_name: '', updated_at: '' })
    }
    setUsers(list)
    setActiveUser(current)
  }

  const loadMemories = () => {
    const result = getCore().listMemories(getActiveUserId())
    const data = (result.data ?? {}) as Record<string, unknown>
    setMemories((data['memories'] ?? []) as MemoryEntry[])
  }

  const loadTrends = (days: number) => {
    const result = getCore().getTrends(getActiveUserId(), days)
    setTrends((result.data as unknown as LearningTrends) ?? null)
  }

  const load = () => {
    const userId = getActiveUserId()
    setActiveUser(userId)

    const profileRes = getCore().getProfile(userId)
    const data = (profileRes.data ?? {}) as Record<string, unknown>
    setProfile(data)
    setName(String(data['display_name'] ?? ''))
    const gradeValue = String(data['grade'] ?? '')
    setGrade(gradeValue === '未填写' ? '' : gradeValue)

    const statusRes = getCore().settingsStatus()
    setDeepseekConfigured(
      Boolean((statusRes.data as Record<string, unknown> | null)?.['deepseek_configured'])
    )

    const kgRes = getCore().getGraphSummary(getActiveUserId())
    setKgSummary((kgRes.data ?? {}) as Record<string, unknown>)

    const timetableRes = getCore().getTimetable(userId)
    setTimetableCount(Number((timetableRes.data as Record<string, unknown> | null)?.['total'] ?? 0))

    const subjectRes = getCore().listSubjects(userId)
    setSubjects(
      ((subjectRes.data as Record<string, unknown> | null)?.['subjects'] ??
        []) as Array<{ name: string; source: string }>
    )

    const docRes = getCore().listDocuments(userId)
    setDocumentCount(Number((docRes.data as Record<string, unknown> | null)?.['total'] ?? 0))

    const assignmentRes = getCore().listAssignments(userId)
    const assignmentData = (assignmentRes.data ?? {}) as Record<string, unknown>
    setAssignmentCount(Number(assignmentData['total'] ?? 0))
    setAssignmentOverdue(Number(assignmentData['overdue_count'] ?? 0))

    const dashboardRes = getCore().getDashboard(userId)
    setDashboard((dashboardRes.data as unknown as DashboardView) ?? null)

    const reportRes = getCore().listWeeklyReports(userId)
    setReport(
      ((reportRes.data as Record<string, unknown> | null)?.['latest'] ?? null) as WeeklyReportView | null
    )

    loadUsers()
    loadMemories()
    loadTrends(trendDays)
  }

  /** 科目表是排程的权威来源，识别错了必须能纠正，否则会一直按错科目排课。 */
  const removeSubject = (name: string) => {
    const result = getCore().removeSubject(getActiveUserId(), name)
    console.log('[Synapse] 移除科目', name, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  useDidShow(() => {
    load()
  })

  const saveProfile = () => {
    const result = getCore().saveProfile(
      getActiveUserId(),
      name.trim() || null,
      grade.trim() || null
    )
    console.log('[Synapse] 保存画像', result.success, result.message)
    Taro.showToast({ title: result.message, icon: 'none' })
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

  const clearAll = async () => {
    const confirmResult = await Taro.showModal({
      title: '清空全部数据',
      content: '将删除当前档案的画像、计划、进度、课程表与 API Key，且不可恢复。确定继续吗？',
      confirmText: '清空',
      confirmColor: '#dc2626'
    })
    if (!confirmResult.confirm) {
      return
    }
    const result = getCore().deleteAllUserData(getActiveUserId())
    console.log('[Synapse] 清空数据', result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
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
      Taro.showToast({ title: result.message, icon: 'none', duration: 3000 })
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
      Taro.showToast({ title: result.message, icon: 'none', duration: 3000 })
      load()
    } finally {
      setGeneratingReport(false)
    }
  }

  /** A：切换当前档案 —— 切数据桶，reLaunch 让所有页面用新档案重载。 */
  const switchUser = async (userId: string) => {
    if (userId === activeUserId) {
      return
    }
    const target = users.find((item) => item.user_id === userId)
    const confirmed = await Taro.showModal({
      title: '切换档案',
      content: `切换到「${target?.display_name || userId}」？各档案的数据彼此独立。`,
      confirmText: '切换'
    })
    if (!confirmed.confirm) {
      return
    }
    setActiveUserId(userId)
    Taro.reLaunch({ url: '/pages/mine/index' })
  }

  /** A：新建本地档案，user_id 用时间戳生成。 */
  const createProfile = async () => {
    const modal = (await Taro.showModal({
      title: '新建本地档案',
      editable: true,
      placeholderText: '给档案起个名字'
    } as any)) as { confirm: boolean; content?: string }
    if (!modal.confirm) {
      return
    }
    const displayName = String(modal.content ?? '').trim()
    if (!displayName) {
      Taro.showToast({ title: '请先填写档案名', icon: 'none' })
      return
    }
    const userId = `u-${Date.now()}`
    const result = getCore().createUser(userId, displayName)
    console.log('[Synapse] 新建档案', userId, result.success, result.message)
    Taro.showToast({ title: result.message, icon: 'none' })
    if (result.success) {
      loadUsers()
    }
  }

  /** A：删除非默认档案，二次确认。 */
  const deleteProfile = async (user: UserView) => {
    const confirmed = await Taro.showModal({
      title: '删除档案',
      content: `删除「${user.display_name || user.user_id}」及其全部本地数据？此操作不可恢复。`,
      confirmText: '删除',
      confirmColor: '#dc2626'
    })
    if (!confirmed.confirm) {
      return
    }
    const result = getCore().deleteUser(user.user_id)
    console.log('[Synapse] 删除档案', user.user_id, result.success, result.message)
    Taro.showToast({ title: result.message, icon: 'none' })
    if (result.success) {
      loadUsers()
    }
  }

  /** B：导入此前导出的 JSON（剪贴板或粘贴文本）。 */
  const importJson = (raw: string) => {
    const text = raw.trim()
    if (!text) {
      Taro.showToast({ title: '先粘贴导出的 JSON', icon: 'none' })
      return
    }
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        Taro.showToast({ title: '这段内容不是合法的 Synapse JSON', icon: 'none' })
        return
      }
      payload = parsed as Record<string, unknown>
    } catch (error) {
      console.error('[Synapse] JSON 解析失败', error)
      Taro.showToast({ title: 'JSON 解析失败，请检查粘贴内容', icon: 'none' })
      return
    }
    const result = getCore().importData(getActiveUserId(), payload)
    console.log('[Synapse] 导入数据', result.success, result.message)
    Taro.showToast({ title: result.message, icon: 'none', duration: 3000 })
    if (result.success) {
      setImportText('')
      load()
    }
  }

  const importFromClipboard = async () => {
    try {
      const clipboard = await Taro.getClipboardData()
      importJson(String(clipboard.data ?? ''))
    } catch (error) {
      console.error('[Synapse] 读取剪贴板失败', error)
      Taro.showToast({ title: '读取剪贴板失败', icon: 'none' })
    }
  }

  /** B：删除一条 AI 记忆（weak_points 传 value 只删该条）。 */
  const removeMemory = (memory: MemoryEntry) => {
    const result = getCore().deleteMemory(getActiveUserId(), memory.kind, memory.value)
    console.log('[Synapse] 删除记忆', memory.kind, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    const data = (result.data ?? {}) as Record<string, unknown>
    setMemories((data['memories'] ?? []) as MemoryEntry[])
  }

  const selectTrendDays = (days: number) => {
    setTrendDays(days)
    loadTrends(days)
  }

  /** F4.2：导出全部本地数据。小程序没有下载目录，直接把 JSON 放进剪贴板更实用。 */
  const exportJson = () => {
    const result = getCore().exportData(getActiveUserId())
    if (!result.success) {
      Taro.showToast({ title: result.message, icon: 'none' })
      return
    }
    const payload = (result.data ?? {}) as Record<string, unknown>
    const json = JSON.stringify(payload['data'] ?? {}, null, 2)
    console.log('[Synapse] 数据已导出', String(payload['filename'] ?? ''), json.length)
    Taro.setClipboardData({
      data: json,
      success: () => Taro.showToast({ title: 'JSON 已复制到剪贴板', icon: 'none', duration: 3000 })
    })
  }

  const accountInfo = (() => {
    try {
      return (Taro as any).getAccountInfoSync?.()
    } catch {
      return null
    }
  })()
  const environmentVersion = String(accountInfo?.miniProgram?.envVersion ?? '')
  const showDemo =
    process.env.NODE_ENV === 'development' ||
    environmentVersion === 'develop' ||
    environmentVersion === 'trial'

  const nameLocked = Boolean(profile['display_name'])
  const nodeCount = Number(kgSummary['node_count'] ?? 0)
  const edgeCount = Number(kgSummary['edge_count'] ?? 0)

  const trendBars = trends?.daily ?? []
  const trendMax = Math.max(1, ...trendBars.map((point) => point.done_count))

  return (
    <View className={styles.page}>
      <View className={styles.header}>
        <View className={styles.avatar}>
          <Text className={styles.avatarText}>
            {nameLocked ? String(profile['display_name']).slice(0, 1) : '我'}
          </Text>
        </View>
        <View className={styles.headerInfo}>
          <Text className={styles.headerName}>
            {nameLocked ? String(profile['display_name']) : '未设置姓名'}
          </Text>
          <Text className={styles.headerMeta}>
            {grade || '未填写年级'} ·{' '}
            {deepseekConfigured ? `已连接 ${runtime.model}` : '本地规则模式'}
          </Text>
        </View>
      </View>

      <Text className={styles.groupTitle}>今日状态</Text>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>学习仪表盘</Text>
        <Text className={styles.cardDesc}>
          数据闭环一图流：今天做了多少、这周坚持了几天、有没有欠账、能力值往哪走。
        </Text>
        <View className={styles.dashboardGrid}>
          <View className={styles.dashboardMetric}>
            <Text className={styles.dashboardValue}>{dashboard?.today.rate ?? 0}%</Text>
            <Text className={styles.dashboardLabel}>
              今日完成率（{dashboard?.today.done_count ?? 0}/{dashboard?.today.total ?? 0}）
            </Text>
          </View>
          <View className={styles.dashboardMetric}>
            <Text className={styles.dashboardValue}>{dashboard?.week.active_days ?? 0}/7</Text>
            <Text className={styles.dashboardLabel}>本周打卡天数</Text>
          </View>
          <View className={styles.dashboardMetric}>
            <Text className={styles.dashboardValue}>{dashboard?.assignments.overdue ?? 0}</Text>
            <Text className={styles.dashboardLabel}>逾期作业</Text>
          </View>
          <View className={styles.dashboardMetric}>
            <Text className={styles.dashboardValue}>{dashboard?.reviews.due_count ?? 0}</Text>
            <Text className={styles.dashboardLabel}>今天该复习</Text>
          </View>
        </View>
        {(dashboard?.subjects ?? []).map((subject) => (
          <View key={subject.name} className={styles.abilityRow}>
            <Text className={styles.abilityName}>{subject.name}</Text>
            <View className={styles.abilityTrack}>
              <View
                className={styles.abilityFill}
                style={{ width: `${Math.min(100, (subject.skill_score / 5) * 100)}%` }}
              />
            </View>
            <Text className={styles.abilityLevel}>Lv.{subject.level}</Text>
          </View>
        ))}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>学习趋势</Text>
        <Text className={styles.cardDesc}>
          最近一段时间的完成度逐日曲线与各科能力值变化。全部离线统计，柱子越高当天完成的任务越多。
        </Text>
        <View className={styles.trendTabs}>
          {TREND_DAY_OPTIONS.map((days) => (
            <View
              key={days}
              className={classnames(
                styles.trendTab,
                trendDays === days && styles.trendTabActive
              )}
              onClick={() => selectTrendDays(days)}
            >
              <Text
                className={classnames(
                  styles.trendTabText,
                  trendDays === days && styles.trendTabTextActive
                )}
              >
                {days} 天
              </Text>
            </View>
          ))}
        </View>
        {trends ? (
          <View>
            <View className={styles.trendChart}>
              {trendBars.map((point) => (
                <View key={point.date} className={styles.trendBarSlot}>
                  <View
                    className={styles.trendBar}
                    style={{
                      height: `${Math.max(point.done_count > 0 ? 8 : 2, Math.round((point.done_count / trendMax) * 140))}rpx`
                    }}
                  />
                </View>
              ))}
            </View>
            <View className={styles.trendTotals}>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>{trends.totals.done_count}</Text>
                <Text className={styles.reportLabel}>完成数</Text>
              </View>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>{trends.totals.minutes}</Text>
                <Text className={styles.reportLabel}>总用时(分)</Text>
              </View>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>{trends.totals.active_days}</Text>
                <Text className={styles.reportLabel}>活跃天数</Text>
              </View>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>{trends.totals.streak_days}</Text>
                <Text className={styles.reportLabel}>连续打卡</Text>
              </View>
            </View>
            {trends.subjects.length > 0 ? (
              <View className={styles.reportAbilities}>
                {trends.subjects.map((subject) => (
                  <Text key={subject.subject} className={styles.reportAbility}>
                    {subject.subject}{' '}
                    {subject.delta > 0 ? `+${subject.delta}` : subject.delta}
                  </Text>
                ))}
              </View>
            ) : (
              <Text className={styles.feedback}>这段时间还没有能力值快照，多打几次卡就有了。</Text>
            )}
            <Text className={styles.reportWindow}>
              统计窗口 {trends.from} ~ {trends.to}
            </Text>
          </View>
        ) : (
          <Text className={styles.feedback}>还没有可统计的学习记录。</Text>
        )}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>AI 学情周报</Text>
        <Text className={styles.cardDesc}>
          完成率、能力值变化、逾期、复习与连续打卡都由本机离线算好，模型只负责把它写成一段学情叙述；没配
          Key 也能出，只是换成模板文案并标注「离线模板」。
        </Text>
        {report ? (
          <View>
            <View className={styles.reportStats}>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>
                  {report.stats.done_count}/{report.stats.total_count}
                </Text>
                <Text className={styles.reportLabel}>本周完成</Text>
              </View>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>{report.stats.completion_rate}%</Text>
                <Text className={styles.reportLabel}>完成率</Text>
              </View>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>{report.stats.overdue_count}</Text>
                <Text className={styles.reportLabel}>逾期作业</Text>
              </View>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>{report.stats.review_done}</Text>
                <Text className={styles.reportLabel}>本周复习</Text>
              </View>
              <View className={styles.reportStat}>
                <Text className={styles.reportValue}>{report.stats.streak_days}</Text>
                <Text className={styles.reportLabel}>连续打卡</Text>
              </View>
            </View>
            {Object.keys(report.stats.ability_delta ?? {}).length > 0 && (
              <View className={styles.reportAbilities}>
                {Object.entries(report.stats.ability_delta).map(([subject, delta]) => (
                  <Text key={subject} className={styles.reportAbility}>
                    {subject} {delta > 0 ? `+${delta}` : delta}
                  </Text>
                ))}
              </View>
            )}
            <View className={styles.reportNarrative}>
              {report.degraded && <Text className={styles.reportFlag}>离线模板</Text>}
              <Text className={styles.reportText}>{report.narrative}</Text>
            </View>
            <Text className={styles.reportWindow}>
              统计窗口 {report.stats.window_start} ~ {report.stats.window_end}（本机最多保留 8 期）
            </Text>
          </View>
        ) : (
          <Text className={styles.feedback}>还没生成过周报，点下面的按钮现场生成一期。</Text>
        )}
        <Button
          className={classnames(styles.demoButton, generatingReport && styles.buttonDisabled)}
          disabled={generatingReport}
          onClick={generateReport}
        >
          {generatingReport ? '生成中…' : report ? '重新生成本周周报' : '生成本周周报'}
        </Button>
      </View>

      <Text className={styles.groupTitle}>学习资产</Text>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>我的科目</Text>
        <Text className={styles.cardDesc}>
          对话里提到的科目会记在这里，跨对话保留；生成计划时按这些科目一起排。识别错了可以删掉。
        </Text>
        {subjects.length === 0 && (
          <Text className={styles.feedback}>还没有科目，去「对话」页说说你要学什么。</Text>
        )}
        {subjects.map((subject) => (
          <View key={subject.name} className={styles.subjectRow}>
            <View className={styles.subjectInfo}>
              <Text className={styles.subjectName}>{subject.name}</Text>
              {!!subject.source && <Text className={styles.subjectSource}>{subject.source}</Text>}
            </View>
            <View className={styles.subjectRemove} onClick={() => removeSubject(subject.name)}>
              <Text className={styles.subjectRemoveText}>删除</Text>
            </View>
          </View>
        ))}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>AI 记忆</Text>
        <Text className={styles.cardDesc}>
          这是 AI 在对话里「记住」的关于你的内容（弱项、偏好、情绪、约束等）。记错了可以逐条删掉。
        </Text>
        {memories.length === 0 && (
          <Text className={styles.feedback}>还没有记忆。多聊几次，AI 会记住你的学习偏好与弱项。</Text>
        )}
        {memories.map((memory, index) => (
          <View key={`${memory.kind}-${index}`} className={styles.memoryRow}>
            <View className={styles.memoryInfo}>
              <Text className={styles.memoryLabel}>{memory.label}</Text>
              <Text className={styles.memoryValue}>{memory.value}</Text>
            </View>
            <View className={styles.subjectRemove} onClick={() => removeMemory(memory)}>
              <Text className={styles.subjectRemoveText}>删除</Text>
            </View>
          </View>
        ))}
      </View>

      <View
        className={styles.card}
        onClick={() => Taro.navigateTo({ url: '/pages/errors/index' })}
      >
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>错题本与自测</Text>
          <Text className={styles.rowArrow}>›</Text>
        </View>
        <Text className={styles.cardDesc}>
          做错的题自动进本并排进复习队列；也可以手动录入错题，或让 AI 出几道选择题当场自测判分。
        </Text>
      </View>

      <View
        className={styles.card}
        onClick={() => Taro.navigateTo({ url: '/pages/timetable/index' })}
      >
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>我的课程表</Text>
          <Text className={styles.rowArrow}>›</Text>
        </View>
        <Text className={styles.cardDesc}>
          {timetableCount > 0
            ? `已录入 ${timetableCount} 节课，生成计划时会自动避开上课时段。`
            : '还没录入课程。导入或手动录入后，计划会自动避开上课时间。'}
        </Text>
      </View>

      <View
        className={styles.card}
        onClick={() => Taro.navigateTo({ url: '/packageDocuments/index' })}
      >
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>资料库</Text>
          <Text className={styles.rowArrow}>›</Text>
        </View>
        <Text className={styles.cardDesc}>
          {documentCount > 0
            ? `已导入 ${documentCount} 份资料，生成计划时会用本地 BM25 检索它们作为参考。`
            : '粘贴笔记或教材片段，切片与检索都在本机完成，不联网、不上传。'}
        </Text>
      </View>

      <View
        className={styles.card}
        onClick={() => Taro.navigateTo({ url: '/pages/assignments/index' })}
      >
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>作业清单</Text>
          <Text className={styles.rowArrow}>›</Text>
        </View>
        <Text className={styles.cardDesc}>
          {assignmentCount > 0
            ? `共 ${assignmentCount} 条作业，${assignmentOverdue} 条逾期。按截止日摊到每天，做完打卡即可。`
            : '把老师布置的作业原话丢进来（如「数学第三章习题1-20明天交」），系统按截止日排进日程并盯着打卡。'}
        </Text>
      </View>

      <View
        className={styles.card}
        onClick={() => Taro.navigateTo({ url: '/pages/graph/index' })}
      >
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>知识图谱</Text>
          <Text className={styles.rowArrow}>›</Text>
        </View>
        <Text className={styles.cardDesc}>
          {nodeCount > 0
            ? `共 ${nodeCount} 个节点、${edgeCount} 条边，全部由你的资料构建。`
            : '还没有节点。导入资料并在资料库里点「构建图谱」，知识点和它们的关系会长在这里。'}
        </Text>
      </View>

      <Text className={styles.groupTitle}>设置</Text>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>本地档案</Text>
        <Text className={styles.cardDesc}>
          多份档案各自独立的画像与学习数据，保存在这台设备上（不是账号登录，不会上传）。切换后各页面都会用新档案。
        </Text>
        {users.map((user) => {
          const isActive = user.user_id === activeUserId
          return (
            <View key={user.user_id} className={styles.userRow}>
              <View className={styles.userInfo}>
                <View className={styles.userNameRow}>
                  <Text className={styles.userName}>
                    {user.display_name || user.user_id}
                  </Text>
                  {isActive && <Text className={styles.userBadge}>当前</Text>}
                </View>
                {!!user.display_name && (
                  <Text className={styles.userMeta}>{user.user_id}</Text>
                )}
              </View>
              <View className={styles.userActions}>
                {!isActive && (
                  <View
                    className={styles.userAction}
                    onClick={() => switchUser(user.user_id)}
                  >
                    <Text className={styles.userActionText}>切换</Text>
                  </View>
                )}
                {user.user_id !== 'default' && (
                  <View
                    className={styles.userDelete}
                    onClick={() => deleteProfile(user)}
                  >
                    <Text className={styles.subjectRemoveText}>删除</Text>
                  </View>
                )}
              </View>
            </View>
          )
        })}
        <Button className={styles.secondaryButton} onClick={createProfile}>
          新建档案
        </Button>
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>学习画像</Text>
        <Text className={styles.cardDesc}>年级与姓名会用于调整计划的语气和难度描述。</Text>
        <Text className={styles.fieldLabel}>姓名{nameLocked ? '（已设定，不可修改）' : ''}</Text>
        {nameLocked ? (
          <View className={styles.fieldValue}>
            <Text>{String(profile['display_name'])}</Text>
          </View>
        ) : (
          <Input
            className={styles.input}
            placeholder="给自己起个名字"
            value={name}
            onInput={(event) => setName(String(event.detail.value))}
          />
        )}
        <Text className={styles.fieldLabel}>年级</Text>
        <Input
          className={styles.input}
          placeholder="例如：大二"
          value={grade}
          onInput={(event) => setGrade(String(event.detail.value))}
        />
        <Button className={styles.primaryButton} onClick={saveProfile}>
          保存画像
        </Button>
      </View>

      <View className={styles.card}>
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>AI 模型接入</Text>
          <View
            className={styles.linkButton}
            onClick={() => {
              setKeyFormOpen((open) => !open)
              setFeedback('')
            }}
          >
            <Text className={styles.linkButtonText}>
              {keyFormOpen ? '收起' : deepseekConfigured ? '更换 Key' : '配置 Key'}
            </Text>
          </View>
        </View>
        <Text className={styles.cardDesc}>
          {deepseekConfigured
            ? '已接入 DeepSeek。Key 只保存在本设备，设备直连模型商，不经过任何中间服务器。'
            : '当前用本地规则模式：不填 Key 也能用，填上之后理解和表达会更贴近你的说法。'}
        </Text>
        {keyFormOpen && (
          <View>
            <Input
              className={styles.input}
              password
              placeholder={deepseekConfigured ? '输入新 Key 可覆盖' : 'sk-...'}
              value={apiKey}
              onInput={(event) => {
                setApiKey(String(event.detail.value))
                setFeedback('')
              }}
            />
            {!!feedback && <Text className={styles.feedback}>{feedback}</Text>}
            <Button
              className={classnames(styles.primaryButton, checking && styles.buttonDisabled)}
              disabled={checking}
              onClick={checkAndSaveKey}
            >
              {checking ? '正在校验…' : '校验并保存'}
            </Button>
          </View>
        )}
        {!keyFormOpen && !!feedback && <Text className={styles.feedback}>{feedback}</Text>}
      </View>

      <View
        className={styles.card}
        onClick={() => Taro.navigateTo({ url: '/pages/cloudcheck/index' })}
      >
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>云开发 AI 自检</Text>
          <Text className={styles.rowArrow}>›</Text>
        </View>
        <Text className={styles.cardDesc}>
          试用微信云开发 AI+（wx.cloud.extend.AI）：由云开发代发模型请求，不用配服务器域名白名单，也不用自己填
          Key。先在这里验证它支持哪些能力。
        </Text>
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>数据管理</Text>
        <Text className={styles.cardDesc}>
          画像、计划、进度、课程表与 API Key 都只保存在这台设备上。数据主权归你：随时可以导出成 JSON
          带走（复制到剪贴板），也能把导出的 JSON 再导入回来。
        </Text>
        <Button className={styles.secondaryButton} onClick={exportJson}>
          复制 JSON 数据
        </Button>
        <Text className={styles.fieldLabel}>导入 JSON（粘贴到这里，或用剪贴板）</Text>
        <Textarea
          className={styles.importTextarea}
          placeholder="把导出的 JSON 粘贴到这里"
          value={importText}
          maxlength={-1}
          onInput={(event) => setImportText(String(event.detail.value))}
        />
        <Button
          className={styles.secondaryButton}
          onClick={() => importJson(importText)}
        >
          导入这段 JSON
        </Button>
        <Button className={styles.secondaryButton} onClick={importFromClipboard}>
          从剪贴板导入
        </Button>
        {showDemo && (
          <Button
            className={classnames(styles.demoButton, loadingDemo && styles.buttonDisabled)}
            disabled={loadingDemo}
            onClick={loadDemo}
          >
            {loadingDemo ? '正在载入…' : '载入演示数据'}
          </Button>
        )}
        <Button className={styles.dangerButton} onClick={clearAll}>
          清空全部数据
        </Button>
      </View>

      <View className={styles.bottomSpacer} />
    </View>
  )
}
