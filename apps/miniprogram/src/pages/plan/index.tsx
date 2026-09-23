import { useCallback, useMemo, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import { getCore, DEFAULT_USER_ID } from '../../services/synapse'
import {
  group_tasks_by_subject,
  plan_task_key,
  type LongTermPlan,
  type Milestone,
  type ReviewItem,
  type StudyDayPlan,
  type TodayPlan
} from '../../vendor/core'
import { taskTypeLabel } from '../../utils/labels'
import { formatDuration, formatRelativeTime } from '../../utils/format'
import styles from './index.module.scss'

type TabKey = 'today' | 'short' | 'long' | 'review'

interface PlanView {
  message: string
  weeklyPlan: StudyDayPlan[]
  progress: Record<string, boolean>
  version: number
  updatedAt: string
  changeSummary: string
}

interface VersionView {
  version: number
  updated_at: string
  change_summary: string
}

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'short', label: '短期' },
  { key: 'long', label: '长期' },
  { key: 'review', label: '复习' }
]

export default function PlanPage() {
  // 计划页默认停在今日待办：用起来就像一张待办清单
  const [tab, setTab] = useState<TabKey>('today')
  const [data, setData] = useState<PlanView | null>(null)
  const [versions, setVersions] = useState<VersionView[]>([])
  const [today, setToday] = useState<TodayPlan | null>(null)
  const [longPlan, setLongPlan] = useState<LongTermPlan | null>(null)
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [dueReviews, setDueReviews] = useState<ReviewItem[]>([])
  const [activeSubject, setActiveSubject] = useState('全部')
  const [newItem, setNewItem] = useState('')
  const [longGoal, setLongGoal] = useState('')
  const [longDeadline, setLongDeadline] = useState('')
  const [topicSubject, setTopicSubject] = useState('')
  const [topicName, setTopicName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    const core = getCore()

    const result = core.getCurrentPlan(DEFAULT_USER_ID)
    if (result.success) {
      const payload = (result.data ?? {}) as Record<string, unknown>
      const plan = (payload['plan'] ?? {}) as Record<string, unknown>
      setData({
        message: String(plan['message'] ?? ''),
        weeklyPlan: (plan['weekly_plan'] ?? []) as StudyDayPlan[],
        progress: (plan['task_progress'] ?? {}) as Record<string, boolean>,
        version: Number(payload['version'] ?? 0),
        updatedAt: String(payload['updated_at'] ?? ''),
        changeSummary: String(payload['change_summary'] ?? '')
      })
    } else {
      setData(null)
    }

    const versionResult = core.listPlanVersions(DEFAULT_USER_ID)
    setVersions(
      ((versionResult.data as Record<string, unknown> | null)?.['versions'] ??
        []) as VersionView[]
    )

    const todayResult = core.getTodayPlan(DEFAULT_USER_ID)
    setToday(((todayResult.data as Record<string, unknown> | null)?.['today'] ?? null) as TodayPlan)

    const longResult = core.getLongTermPlan(DEFAULT_USER_ID)
    setLongPlan(
      ((longResult.data as Record<string, unknown> | null)?.['long_plan'] ?? null) as LongTermPlan
    )

    const reviewResult = core.listReviews(DEFAULT_USER_ID)
    const reviewData = (reviewResult.data ?? {}) as Record<string, unknown>
    setReviews((reviewData['items'] ?? []) as ReviewItem[])
    setDueReviews((reviewData['due'] ?? []) as ReviewItem[])
  }, [])

  useDidShow(() => {
    load()
  })

  const subjects = useMemo(() => {
    if (!data) {
      return [] as string[]
    }
    const set = new Set<string>()
    data.weeklyPlan.forEach((day) =>
      day.tasks.forEach((task) => set.add((task.subject || '未分类').trim() || '未分类'))
    )
    return [...set]
  }, [data])

  const stats = useMemo(() => {
    if (!data) {
      return { total: 0, done: 0 }
    }
    let total = 0
    let done = 0
    data.weeklyPlan.forEach((day) => {
      day.tasks.forEach((task) => {
        if (activeSubject !== '全部' && (task.subject || '未分类') !== activeSubject) {
          return
        }
        total += 1
        if (data.progress[plan_task_key(day.day_index, task)]) {
          done += 1
        }
      })
    })
    return { total, done }
  }, [data, activeSubject])

  const todayStats = useMemo(() => {
    const items = today?.items ?? []
    return { total: items.length, done: items.filter((item) => item.done).length }
  }, [today])

  /** G4.2：今天第一条还没做的任务，就是「先学 5 分钟」的对象。 */
  const starter = (today?.items ?? []).find((item) => !item.done) ?? null

  const upcomingReviews = useMemo(
    () => reviews.filter((item) => !dueReviews.some((due) => due.id === item.id)),
    [reviews, dueReviews]
  )

  const toggleTask = (day: StudyDayPlan, task: StudyDayPlan['tasks'][number]) => {
    if (!data) {
      return
    }
    const taskKey = plan_task_key(day.day_index, task)
    const nextDone = !data.progress[taskKey]
    const result = getCore().updatePlanProgress({
      user_id: DEFAULT_USER_ID,
      conversation_id: '',
      plan_id: '',
      plan_version: data.version,
      task_key: taskKey,
      done: nextDone,
      task_title: task.title,
      task_type: task.task_type,
      actual_minutes: task.duration_minutes,
      plan_message: data.message,
      subject: task.subject ?? ''
    })
    console.log('[Synapse] 更新进度', taskKey, nextDone, result.success)
    if (result.success) {
      const progress =
        ((result.data as Record<string, unknown>)['task_progress'] as Record<string, boolean>) ?? {}
      setData({ ...data, progress })
    } else {
      Taro.showToast({ title: result.message || '更新失败', icon: 'none' })
    }
  }

  const toggleToday = (key: string) => {
    const result = getCore().toggleTodayItem(DEFAULT_USER_ID, key)
    if (!result.success) {
      Taro.showToast({ title: result.message || '更新失败', icon: 'none' })
      return
    }
    // 打卡是同一份数据，短期视图也要跟着刷新
    load()
  }

  /**
   * G4.2 最小启动行动：拖延的解法不是排得更满，而是把第一步缩到不可能失败。
   * 走的还是 toggleTodayItem 这条既有打卡链路，只是把用时记成 5 分钟。
   */
  const startFive = (key: string) => {
    const result = getCore().toggleTodayItem(DEFAULT_USER_ID, key, 5)
    console.log('[Synapse] 先学 5 分钟', key, result.success)
    if (!result.success) {
      Taro.showToast({ title: result.message || '更新失败', icon: 'none' })
      return
    }
    Taro.showToast({ title: '已记下 5 分钟，先动起来就赢一半', icon: 'none', duration: 2500 })
    load()
  }

  const addToday = () => {
    const title = newItem.trim()
    if (!title) {
      return
    }
    const result = getCore().addTodayItem(DEFAULT_USER_ID, { title })
    console.log('[Synapse] 加入今日', title, result.success)
    if (result.success) {
      setNewItem('')
    }
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const removeToday = async (key: string, title: string) => {
    const confirmed = await Taro.showModal({
      title: '移出今日',
      content: `把「${title}」从今天的清单里去掉？（短期计划不受影响）`,
      confirmText: '移出'
    })
    if (!confirmed.confirm) {
      return
    }
    const result = getCore().removeTodayItem(DEFAULT_USER_ID, key)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const restoreVersion = async (version: number) => {
    const confirmed = await Taro.showModal({
      title: `回到第 ${version} 版`,
      content: '会把这一版的周计划重新设为当前计划，并生成一个新版本号。打卡记录不会丢。',
      confirmText: '回到这版'
    })
    if (!confirmed.confirm) {
      return
    }
    const result = getCore().restorePlanVersion(DEFAULT_USER_ID, version)
    console.log('[Synapse] 恢复计划版本', version, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const planForMilestone = async (milestone: Milestone) => {
    if (busy) {
      return
    }
    const confirmed = await Taro.showModal({
      title: `按「${milestone.title}」排本周`,
      content: '会用这个阶段的目标重新生成一版短期计划（生成新版本，历史版本仍保留）。',
      confirmText: '生成'
    })
    if (!confirmed.confirm) {
      return
    }
    setBusy(true)
    try {
      const result = await getCore().planForMilestone(DEFAULT_USER_ID, milestone.id)
      console.log('[Synapse] 按阶段排本周', milestone.id, result.success)
      Taro.showToast({ title: result.message, icon: 'none' })
      load()
      if (result.success) {
        setTab('short')
      }
    } finally {
      setBusy(false)
    }
  }

  const completeMilestone = (milestone: Milestone) => {
    const result = getCore().completeMilestone(DEFAULT_USER_ID, milestone.id)
    console.log('[Synapse] 完成阶段', milestone.id, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const buildLongPlan = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      const result = await getCore().buildLongTermPlan(
        DEFAULT_USER_ID,
        longGoal.trim(),
        longDeadline.trim()
      )
      console.log('[Synapse] 划分长期阶段', result.success, result.message)
      Taro.showToast({ title: result.message, icon: 'none' })
      if (result.success) {
        setLongGoal('')
        setLongDeadline('')
        load()
      }
    } finally {
      setBusy(false)
    }
  }

  const gradeReview = (item: ReviewItem, grade: number) => {
    const result = getCore().reviewItem(DEFAULT_USER_ID, item.id, grade)
    console.log('[Synapse] 复习评分', item.topic, grade, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const addTopic = () => {
    const topic = topicName.trim()
    if (!topic) {
      return
    }
    const result = getCore().addReviewTopic(DEFAULT_USER_ID, topicSubject.trim(), topic)
    console.log('[Synapse] 加入复习队列', topic, result.success)
    if (result.success) {
      setTopicName('')
    }
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const removeTopic = async (item: ReviewItem) => {
    const confirmed = await Taro.showModal({
      title: '移出复习队列',
      content: `不再复习「${item.topic}」？`,
      confirmText: '移出'
    })
    if (!confirmed.confirm) {
      return
    }
    const result = getCore().removeReviewItem(DEFAULT_USER_ID, item.id)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const emptyState = (
    <View className={styles.empty}>
      <Text className={styles.emptyTitle}>还没有计划</Text>
      <Text className={styles.emptyDesc}>
        去「对话」页说出你的学习目标，计划生成后会自动出现在这里，不需要手动保存。
      </Text>
      <View
        className={styles.emptyButton}
        onClick={() => Taro.switchTab({ url: '/pages/chat/index' })}
      >
        <Text className={styles.emptyButtonText}>去生成计划</Text>
      </View>
    </View>
  )

  return (
    <View className={styles.page}>
      <View className={styles.tabs}>
        {TABS.map((item) => (
          <View
            key={item.key}
            className={classnames(styles.tab, tab === item.key && styles.tabActive)}
            onClick={() => setTab(item.key)}
          >
            <Text className={classnames(styles.tabText, tab === item.key && styles.tabTextActive)}>
              {item.label}
            </Text>
          </View>
        ))}
      </View>

      {/* ---------------- 今日：待办清单 ---------------- */}
      {tab === 'today' && (
        <>
          <View className={styles.summary}>
            <View className={styles.summaryHeader}>
              <Text className={styles.summaryTitle}>
                今日{today?.date ? ` · ${today.date}` : ''}
              </Text>
              {!!today?.day_index && (
                <View className={styles.versionBadge}>
                  <Text className={styles.versionText}>
                    Day {today.day_index}
                  </Text>
                </View>
              )}
            </View>

            <View className={styles.progressRow}>
              <View className={styles.progressBar}>
                <View
                  className={styles.progressFill}
                  style={{
                    width: `${
                      todayStats.total
                        ? Math.round((todayStats.done / todayStats.total) * 100)
                        : 0
                    }%`
                  }}
                />
              </View>
              <Text className={styles.progressText}>
                {todayStats.done}/{todayStats.total}
              </Text>
            </View>
          </View>

          {!!starter && (
            <View
              className={styles.starter}
              onClick={() => startFive(starter.key)}
            >
              <Text className={styles.starterKicker}>先学 5 分钟</Text>
              <Text className={styles.starterTitle}>{starter.title}</Text>
            </View>
          )}

          {(today?.items ?? []).length === 0 && (
            <View className={styles.todayEmpty}>
              <Text className={styles.emptyDesc}>
                {!data
                  ? '还没有短期计划，先去「对话」页生成，今天该做的会自动出现在这里。'
                  : !today?.day_index
                    ? '本期短期计划已经走完了。可以在「长期」里按下一个阶段排本周，或回「对话」页开新一版。'
                    : '今天没有排到的任务，可以在下面手动加一条。'}
              </Text>
            </View>
          )}

          {(today?.items ?? []).map((item) => (
            <View key={item.key} className={styles.taskRow} onClick={() => toggleToday(item.key)}>
              <View className={classnames(styles.checkbox, item.done && styles.checkboxDone)}>
                {item.done && <Text className={styles.checkMark}>✓</Text>}
              </View>
              <View className={styles.taskBody}>
                <Text className={classnames(styles.taskTitle, item.done && styles.taskTitleDone)}>
                  {item.title}
                </Text>
                <Text className={styles.taskMeta}>
                  {item.carried_from ? `昨日顺延 · ${item.carried_from} · ` : ''}
                  {item.subject} · {formatDuration(item.duration_minutes)}
                </Text>
              </View>
              <View
                className={styles.removeButton}
                onClick={(event) => {
                  event.stopPropagation()
                  removeToday(item.key, item.title)
                }}
              >
                <Text className={styles.removeButtonText}>移出</Text>
              </View>
            </View>
          ))}

          <View className={styles.addRow}>
            <Input
              className={styles.addInput}
              placeholder="加一条今天要做的事…"
              value={newItem}
              confirmType="done"
              onInput={(event) => setNewItem(String(event.detail.value))}
              onConfirm={addToday}
            />
            <Button
              className={styles.addButton}
              disabled={!newItem.trim()}
              onClick={addToday}
            >
              加入
            </Button>
          </View>
        </>
      )}

      {/* ---------------- 短期：这一期的周计划 ---------------- */}
      {tab === 'short' && (
        <>
          {!data && emptyState}

          {data && (
            <>
              <View className={styles.summary}>
                <View className={styles.summaryHeader}>
                  <Text className={styles.summaryTitle}>本期计划</Text>
                  <View className={styles.versionBadge}>
                    <Text className={styles.versionText}>第 {data.version} 版</Text>
                  </View>
                </View>

                {!!data.changeSummary && (
                  <Text className={styles.changeSummary}>{data.changeSummary}</Text>
                )}
                {!!data.message && <Text className={styles.summaryMessage}>{data.message}</Text>}

                <View className={styles.progressRow}>
                  <View className={styles.progressBar}>
                    <View
                      className={styles.progressFill}
                      style={{
                        width: `${stats.total ? Math.round((stats.done / stats.total) * 100) : 0}%`
                      }}
                    />
                  </View>
                  <Text className={styles.progressText}>
                    {stats.done}/{stats.total}
                  </Text>
                </View>

                <Text className={styles.updatedAt}>
                  {data.updatedAt ? `更新于 ${formatRelativeTime(data.updatedAt)}` : ''}
                </Text>
              </View>

              {subjects.length > 1 && (
                <View className={styles.subjectFilter}>
                  {['全部', ...subjects].map((subject) => (
                    <View
                      key={subject}
                      className={classnames(
                        styles.subjectChip,
                        activeSubject === subject && styles.subjectChipActive
                      )}
                      onClick={() => setActiveSubject(subject)}
                    >
                      <Text
                        className={classnames(
                          styles.subjectChipText,
                          activeSubject === subject && styles.subjectChipTextActive
                        )}
                      >
                        {subject}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {data.weeklyPlan.map((day) => {
                const groups = group_tasks_by_subject(day.tasks).filter(
                  (group) => activeSubject === '全部' || group.subject === activeSubject
                )
                if (!groups.length) {
                  return null
                }
                return (
                  <View key={day.day_index} className={styles.dayCard}>
                    <View className={styles.dayHeader}>
                      <Text className={styles.dayIndex}>Day {day.day_index}</Text>
                      <Text className={styles.dayFocus}>{day.focus}</Text>
                    </View>

                    {groups.map((group) => (
                      <View key={group.subject} className={styles.subjectGroup}>
                        <View className={styles.groupChip}>
                          <Text className={styles.groupChipText}>{group.subject}</Text>
                        </View>
                        {group.tasks.map((task) => {
                          const taskKey = plan_task_key(day.day_index, task)
                          const done = !!data.progress[taskKey]
                          return (
                            <View
                              key={taskKey}
                              className={styles.taskRow}
                              onClick={() => toggleTask(day, task)}
                            >
                              <View
                                className={classnames(styles.checkbox, done && styles.checkboxDone)}
                              >
                                {done && <Text className={styles.checkMark}>✓</Text>}
                              </View>
                              <View className={styles.taskBody}>
                                <Text
                                  className={classnames(
                                    styles.taskTitle,
                                    done && styles.taskTitleDone
                                  )}
                                >
                                  {task.title}
                                </Text>
                                <Text className={styles.taskMeta}>
                                  {taskTypeLabel(task.task_type)} ·{' '}
                                  {formatDuration(task.duration_minutes)}
                                </Text>
                              </View>
                            </View>
                          )
                        })}
                      </View>
                    ))}
                  </View>
                )
              })}
            </>
          )}

          {versions.length > 0 && (
            <View className={styles.versionCard}>
              <Text className={styles.versionTitle}>历史版本</Text>
              <Text className={styles.versionHint}>
                每一版计划都留在这里。一版执行完之后想调整，可以回到某一版继续，不必从零重生成。
              </Text>
              {[...versions].reverse().map((item) => (
                <View key={item.version} className={styles.versionRow}>
                  <View className={styles.versionInfo}>
                    <Text className={styles.versionName}>第 {item.version} 版</Text>
                    <Text className={styles.versionMeta}>
                      {formatRelativeTime(item.updated_at)}
                      {item.change_summary ? ` · ${item.change_summary}` : ''}
                    </Text>
                  </View>
                  {item.version === data?.version ? (
                    <Text className={styles.versionCurrent}>当前</Text>
                  ) : (
                    <View
                      className={styles.versionAction}
                      onClick={() => restoreVersion(item.version)}
                    >
                      <Text className={styles.versionActionText}>回到这版</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}
        </>
      )}

      {/* ---------------- 长期：阶段划分 ---------------- */}
      {tab === 'long' && (
        <>
          {!longPlan && (
            <View className={styles.empty}>
              <Text className={styles.emptyTitle}>还没有长期计划</Text>
              <Text className={styles.emptyDesc}>
                目标跨度超过一周时，我在对话里会自动帮你划分阶段。也可以在这里手动划分：
              </Text>
              <Input
                className={styles.addInput}
                placeholder="总目标，例如：三个月过六级"
                value={longGoal}
                onInput={(event) => setLongGoal(String(event.detail.value))}
              />
              <Input
                className={styles.addInput}
                placeholder="截止日期，格式 2026-12-21"
                value={longDeadline}
                onInput={(event) => setLongDeadline(String(event.detail.value))}
              />
              <Button
                className={classnames(styles.addButton, busy && styles.buttonDisabled)}
                disabled={busy}
                onClick={buildLongPlan}
              >
                {busy ? '正在划分…' : '划分阶段'}
              </Button>
            </View>
          )}

          {longPlan && (
            <>
              <View className={styles.summary}>
                <View className={styles.summaryHeader}>
                  <Text className={styles.summaryTitle}>长期计划</Text>
                  <View className={styles.versionBadge}>
                    <Text className={styles.versionText}>第 {longPlan.version} 版</Text>
                  </View>
                </View>
                <Text className={styles.summaryMessage}>{longPlan.goal}</Text>
                <Text className={styles.updatedAt}>
                  {longPlan.deadline ? `截止 ${longPlan.deadline} · ` : ''}
                  共 {longPlan.milestones.length} 个阶段
                </Text>
              </View>

              {longPlan.milestones.map((milestone) => (
                <View
                  key={milestone.id}
                  className={classnames(
                    styles.milestoneCard,
                    milestone.status === 'active' && styles.milestoneActive
                  )}
                >
                  <View className={styles.milestoneHeader}>
                    <Text className={styles.milestoneTitle}>{milestone.title}</Text>
                    <Text className={styles.milestoneStatus}>
                      {milestone.status === 'done'
                        ? '已完成'
                        : milestone.status === 'active'
                          ? '进行中'
                          : '待开始'}
                    </Text>
                  </View>
                  <Text className={styles.milestoneMeta}>
                    {milestone.start_date} ~ {milestone.due_date}
                  </Text>
                  <Text className={styles.milestoneGoal}>{milestone.goal}</Text>
                  <Text className={styles.milestoneAcceptance}>
                    验收：{milestone.acceptance}
                  </Text>
                  <View className={styles.milestoneActions}>
                    <View
                      className={styles.versionAction}
                      onClick={() => planForMilestone(milestone)}
                    >
                      <Text className={styles.versionActionText}>按这个阶段排本周</Text>
                    </View>
                    {milestone.status !== 'done' && (
                      <View
                        className={styles.versionAction}
                        onClick={() => completeMilestone(milestone)}
                      >
                        <Text className={styles.versionActionText}>标记完成</Text>
                      </View>
                    )}
                  </View>
                </View>
              ))}
            </>
          )}
        </>
      )}

      {/* ---------------- 复习：间隔重复队列 ---------------- */}
      {tab === 'review' && (
        <>
          <View className={styles.summary}>
            <View className={styles.summaryHeader}>
              <Text className={styles.summaryTitle}>复习</Text>
              <View className={styles.versionBadge}>
                <Text className={styles.versionText}>今日 {dueReviews.length} 条</Text>
              </View>
            </View>
            <Text className={styles.summaryMessage}>
              完成学习类任务会自动进入复习队列，按间隔重复算法安排下次复习。
              间隔与难度都在本机计算，不需要联网。
            </Text>
          </View>

          <View className={styles.reviewSection}>
            <Text className={styles.reviewSectionTitle}>今天该复习</Text>
            {dueReviews.length === 0 && (
              <Text className={styles.reviewEmpty}>今天没有到期的复习，先按计划推进新内容。</Text>
            )}
            {dueReviews.map((item) => (
              <View key={item.id} className={styles.reviewRow}>
                <View className={styles.reviewInfo}>
                  <Text className={styles.reviewTopic}>{item.topic}</Text>
                  <Text className={styles.reviewMeta}>
                    {item.subject} · 间隔 {item.interval_days} 天 · 难度 {item.ease}
                  </Text>
                </View>
                <View className={styles.reviewActions}>
                  <View className={styles.reviewPass} onClick={() => gradeReview(item, 5)}>
                    <Text className={styles.reviewActionTextLight}>记得</Text>
                  </View>
                  <View className={styles.reviewFail} onClick={() => gradeReview(item, 2)}>
                    <Text className={styles.reviewActionTextDark}>忘了</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>

          <View className={styles.reviewSection}>
            <Text className={styles.reviewSectionTitle}>稍后复习（{upcomingReviews.length}）</Text>
            {upcomingReviews.length === 0 && (
              <Text className={styles.reviewEmpty}>队列里还没有后续安排。</Text>
            )}
            {upcomingReviews.map((item) => (
              <View key={item.id} className={styles.reviewRow}>
                <View className={styles.reviewInfo}>
                  <Text className={styles.reviewTopic}>{item.topic}</Text>
                  <Text className={styles.reviewMeta}>
                    {item.subject} · {item.due_date} · 间隔 {item.interval_days} 天
                  </Text>
                </View>
                <View className={styles.removeButton} onClick={() => removeTopic(item)}>
                  <Text className={styles.removeButtonText}>移出</Text>
                </View>
              </View>
            ))}
          </View>

          <View className={styles.reviewSection}>
            <Text className={styles.reviewSectionTitle}>手动加知识点</Text>
            <Input
              className={styles.addInput}
              placeholder="科目，如 高等数学"
              value={topicSubject}
              onInput={(event) => setTopicSubject(String(event.detail.value))}
            />
            <View className={styles.addRow}>
              <Input
                className={styles.addInput}
                placeholder="知识点，如 夹逼定理"
                value={topicName}
                onInput={(event) => setTopicName(String(event.detail.value))}
                confirmType="done"
                onConfirm={addTopic}
              />
              <Button
                className={styles.addButton}
                disabled={!topicName.trim()}
                onClick={addTopic}
              >
                加入
              </Button>
            </View>
          </View>
        </>
      )}

      <View className={styles.bottomSpacer} />
    </View>
  )
}
