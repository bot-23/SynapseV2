import { useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import { getCore, DEFAULT_USER_ID, currentRuntimeMode } from '../../services/synapse'
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
  const runtime = currentRuntimeMode()

  const load = () => {
    const profileRes = getCore().getProfile(DEFAULT_USER_ID)
    const data = (profileRes.data ?? {}) as Record<string, unknown>
    setProfile(data)
    setName(String(data['display_name'] ?? ''))
    const gradeValue = String(data['grade'] ?? '')
    setGrade(gradeValue === '未填写' ? '' : gradeValue)

    const statusRes = getCore().settingsStatus()
    setDeepseekConfigured(
      Boolean((statusRes.data as Record<string, unknown> | null)?.['deepseek_configured'])
    )

    const kgRes = getCore().getGraphSummary()
    setKgSummary((kgRes.data ?? {}) as Record<string, unknown>)

    const timetableRes = getCore().getTimetable(DEFAULT_USER_ID)
    setTimetableCount(Number((timetableRes.data as Record<string, unknown> | null)?.['total'] ?? 0))

    const subjectRes = getCore().listSubjects(DEFAULT_USER_ID)
    setSubjects(
      ((subjectRes.data as Record<string, unknown> | null)?.['subjects'] ??
        []) as Array<{ name: string; source: string }>
    )

    const docRes = getCore().listDocuments(DEFAULT_USER_ID)
    setDocumentCount(Number((docRes.data as Record<string, unknown> | null)?.['total'] ?? 0))

    const assignmentRes = getCore().listAssignments(DEFAULT_USER_ID)
    const assignmentData = (assignmentRes.data ?? {}) as Record<string, unknown>
    setAssignmentCount(Number(assignmentData['total'] ?? 0))
    setAssignmentOverdue(Number(assignmentData['overdue_count'] ?? 0))

    const dashboardRes = getCore().getDashboard(DEFAULT_USER_ID)
    setDashboard((dashboardRes.data as unknown as DashboardView) ?? null)

    const reportRes = getCore().listWeeklyReports(DEFAULT_USER_ID)
    setReport(
      ((reportRes.data as Record<string, unknown> | null)?.['latest'] ?? null) as WeeklyReportView | null
    )
  }

  /** 科目表是排程的权威来源，识别错了必须能纠正，否则会一直按错科目排课。 */
  const removeSubject = (name: string) => {
    const result = getCore().removeSubject(DEFAULT_USER_ID, name)
    console.log('[Synapse] 移除科目', name, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  useDidShow(() => {
    load()
  })

  const saveProfile = () => {
    const result = getCore().saveProfile(
      DEFAULT_USER_ID,
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
      content: '将删除画像、计划、进度、课程表与 API Key，且不可恢复。确定继续吗？',
      confirmText: '清空',
      confirmColor: '#dc2626'
    })
    if (!confirmResult.confirm) {
      return
    }
    const result = getCore().deleteAllUserData(DEFAULT_USER_ID)
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
      const result = await getCore().loadDemoData(DEFAULT_USER_ID)
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
      const result = await getCore().generateWeeklyReport(DEFAULT_USER_ID)
      console.log('[Synapse] 生成周报', result.success, result.message)
      Taro.showToast({ title: result.message, icon: 'none', duration: 3000 })
      load()
    } finally {
      setGeneratingReport(false)
    }
  }

  /** F4.2：导出全部本地数据。小程序没有下载目录，直接把 JSON 放进剪贴板更实用。 */
  const exportJson = () => {
    const result = getCore().exportData(DEFAULT_USER_ID)
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
        onClick={() => Taro.navigateTo({ url: '/pages/documents/index' })}
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
          带走（复制到剪贴板）。
        </Text>
        <Button className={styles.secondaryButton} onClick={exportJson}>
          复制 JSON 数据
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
