import { useCallback, useEffect, useMemo, useState } from 'react'
import { getCore, DEFAULT_USER_ID } from '../services/synapse'
import {
  group_tasks_by_subject,
  plan_task_key,
  type LongTermPlan,
  type Milestone,
  type ReviewHintResult,
  type ReviewItem,
  type StudyDayPlan,
  type TodayPlan,
} from '@synapse/core'
import { taskTypeLabel, formatDuration, formatRelativeTime } from '../utils/format'
import PageIntro from '../components/PageIntro'

type TabKey = 'today' | 'short' | 'long' | 'review'

/** 三级提示的档位名，与 core 的 HINT_TIERS 一一对应。 */
const HINT_TIER_LABELS = ['知识点方向', '解题思路', '关键步骤']

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
  { key: 'review', label: '复习' },
]

export default function PlanView() {
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
  const [notice, setNotice] = useState('')
  /** G2：当前展开的复习卡提示面板 */
  const [hintPanel, setHintPanel] = useState<{ id: string; data: ReviewHintResult } | null>(null)
  const [hintRevealed, setHintRevealed] = useState(0)
  const [hintAnswerOpen, setHintAnswerOpen] = useState(false)

  const flash = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2600)
  }

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
        changeSummary: String(payload['change_summary'] ?? ''),
      })
    } else {
      setData(null)
    }

    const versionResult = core.listPlanVersions(DEFAULT_USER_ID)
    setVersions(
      ((versionResult.data as Record<string, unknown> | null)?.['versions'] ??
        []) as VersionView[],
    )

    const todayResult = core.getTodayPlan(DEFAULT_USER_ID)
    setToday(
      ((todayResult.data as Record<string, unknown> | null)?.['today'] ?? null) as TodayPlan,
    )

    const longResult = core.getLongTermPlan(DEFAULT_USER_ID)
    setLongPlan(
      ((longResult.data as Record<string, unknown> | null)?.['long_plan'] ?? null) as LongTermPlan,
    )

    const reviewResult = core.listReviews(DEFAULT_USER_ID)
    const reviewData = (reviewResult.data ?? {}) as Record<string, unknown>
    setReviews((reviewData['items'] ?? []) as ReviewItem[])
    setDueReviews((reviewData['due'] ?? []) as ReviewItem[])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const subjects = useMemo(() => {
    if (!data) {
      return [] as string[]
    }
    const set = new Set<string>()
    data.weeklyPlan.forEach((day) =>
      day.tasks.forEach((task) => set.add((task.subject || '未分类').trim() || '未分类')),
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
    [reviews, dueReviews],
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
      subject: task.subject ?? '',
    })
    console.log('[Synapse] 更新进度', taskKey, nextDone, result.success)
    if (result.success) {
      const progress =
        ((result.data as Record<string, unknown>)['task_progress'] as Record<string, boolean>) ??
        {}
      setData({ ...data, progress })
    } else {
      flash(result.message || '更新失败')
    }
  }

  const toggleToday = (key: string) => {
    const result = getCore().toggleTodayItem(DEFAULT_USER_ID, key)
    if (!result.success) {
      flash(result.message || '更新失败')
      return
    }
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
      flash(result.message || '更新失败')
      return
    }
    flash('已记下 5 分钟，先动起来就赢一半')
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
    flash(result.message)
    load()
  }

  const removeToday = (key: string, title: string) => {
    if (!window.confirm(`把「${title}」从今天的清单里去掉？（短期计划不受影响）`)) {
      return
    }
    const result = getCore().removeTodayItem(DEFAULT_USER_ID, key)
    flash(result.message)
    load()
  }

  const restoreVersion = (version: number) => {
    if (
      !window.confirm(
        `回到第 ${version} 版？会把这一版的周计划重新设为当前计划，并生成一个新版本号。打卡记录不会丢。`,
      )
    ) {
      return
    }
    const result = getCore().restorePlanVersion(DEFAULT_USER_ID, version)
    console.log('[Synapse] 恢复计划版本', version, result.success)
    flash(result.message)
    load()
  }

  const planForMilestone = async (milestone: Milestone) => {
    if (busy) {
      return
    }
    if (!window.confirm(`用「${milestone.title}」的目标重新生成一版短期计划？`)) {
      return
    }
    setBusy(true)
    try {
      const result = await getCore().planForMilestone(DEFAULT_USER_ID, milestone.id)
      console.log('[Synapse] 按阶段排本周', milestone.id, result.success)
      flash(result.message)
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
    flash(result.message)
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
        longDeadline.trim(),
      )
      console.log('[Synapse] 划分长期阶段', result.success, result.message)
      flash(result.message)
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
    flash(result.message)
    // 评完分就收起提示面板，下一张卡从零开始
    if (hintPanel?.id === item.id) {
      setHintPanel(null)
    }
    load()
  }

  /**
   * G2「提示我」：第一次点取提示（可能走一次模型，之后直读缓存），
   * 同一张卡再点就是「再揭示一条」——依次给方向、思路、步骤，全部揭示完才允许看答案。
   */
  const askHint = async (item: ReviewItem) => {
    if (hintPanel?.id === item.id) {
      setHintRevealed((current) => Math.min(hintPanel.data.hints.length, current + 1))
      return
    }
    const result = await getCore().getReviewHints(DEFAULT_USER_ID, item.id)
    console.log('[Synapse] 复习提示', item.id, result.success, result.message)
    if (!result.success) {
      flash(result.message || '提示获取失败')
      return
    }
    setHintPanel({ id: item.id, data: result.data as unknown as ReviewHintResult })
    setHintRevealed(1)
    setHintAnswerOpen(false)
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
    flash(result.message)
    load()
  }

  const removeTopic = (item: ReviewItem) => {
    if (!window.confirm(`不再复习「${item.topic}」？`)) {
      return
    }
    const result = getCore().removeReviewItem(DEFAULT_USER_ID, item.id)
    flash(result.message)
    load()
  }

  const emptyState = (
    <div className="plan-empty">
      <div className="plan-empty-title">还没有计划</div>
      <div className="plan-empty-desc">
        去「对话」页说出你的学习目标，计划生成后会自动出现在这里，不需要手动保存。
      </div>
    </div>
  )

  return (
    <div className="plan-page">
      <div className="notice snackbar">{notice}</div>
      <PageIntro eyebrow="YOUR LEARNING PATH / 01" title="学习计划" description="今天该做什么、下一步怎么走，在这里都能找到答案。" />
      <div className="plan-tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`plan-tab${tab === item.key ? ' active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* ---------------- 今日：待办清单 ---------------- */}
      {tab === 'today' && (
        <>
          <div className="plan-summary">
            <div className="plan-summary-header">
              <span className="plan-summary-title">今日{today?.date ? ` · ${today.date}` : ''}</span>
              {!!today?.day_index && <span className="version-badge">Day {today.day_index}</span>}
            </div>
            <div className="progress-row">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${
                      todayStats.total
                        ? Math.round((todayStats.done / todayStats.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <span className="progress-text">
                {todayStats.done}/{todayStats.total}
              </span>
            </div>
          </div>

          {starter && (
            <button type="button" className="plan-starter" onClick={() => startFive(starter.key)}>
              <span className="plan-starter-kicker">先学 5 分钟</span>
              <span className="plan-starter-title">{starter.title}</span>
              <span className="plan-starter-hint">点一下就记下这次启动</span>
            </button>
          )}

          {(today?.items ?? []).length === 0 && (
            <div className="plan-today-empty">
              {!data
                ? '还没有短期计划，先去「对话」页生成，今天该做的会自动出现在这里。'
                : !today?.day_index
                  ? '本期短期计划已经走完了。可以在「长期」里按下一个阶段排本周，或回「对话」页开新一版。'
                  : '今天没有排到的任务，可以在下面手动加一条。'}
            </div>
          )}

          {(today?.items ?? []).map((item) => (
            <div key={item.key} className="plan-task-row" onClick={() => toggleToday(item.key)}>
              <span className={`plan-checkbox${item.done ? ' checked' : ''}`}>
                {item.done ? '✓' : ''}
              </span>
              <div className="plan-task-body">
                <div className={`plan-task-title${item.done ? ' done' : ''}`}>{item.title}</div>
                <div className="plan-task-meta">
                  {item.carried_from ? `昨日顺延 · ${item.carried_from} · ` : ''}
                  {item.subject} · {formatDuration(item.duration_minutes)}
                </div>
              </div>
              <button
                type="button"
                className="plan-remove"
                onClick={(event) => {
                  event.stopPropagation()
                  removeToday(item.key, item.title)
                }}
              >
                移出
              </button>
            </div>
          ))}

          <div className="plan-add-row">
            <input
              className="plan-add-input"
              placeholder="加一条今天要做的事…"
              value={newItem}
              onChange={(event) => setNewItem(event.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  addToday()
                }
              }}
            />
            <button
              type="button"
              className="plan-add-button"
              disabled={!newItem.trim()}
              onClick={addToday}
            >
              加入
            </button>
          </div>
        </>
      )}

      {/* ---------------- 短期：这一期的周计划 ---------------- */}
      {tab === 'short' && (
        <>
          {!data && emptyState}

          {data && (
            <>
              <div className="plan-summary">
                <div className="plan-summary-header">
                  <span className="plan-summary-title">本期计划</span>
                  <span className="version-badge">第 {data.version} 版</span>
                </div>
                {!!data.changeSummary && <div className="plan-change-summary">{data.changeSummary}</div>}
                {!!data.message && <div className="plan-summary-message">{data.message}</div>}
                <div className="progress-row">
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${
                          stats.total ? Math.round((stats.done / stats.total) * 100) : 0
                        }%`,
                      }}
                    />
                  </div>
                  <span className="progress-text">
                    {stats.done}/{stats.total}
                  </span>
                </div>
                {!!data.updatedAt && (
                  <div className="plan-updated">更新于 {formatRelativeTime(data.updatedAt)}</div>
                )}
              </div>

              {subjects.length > 1 && (
                <div className="subject-filter">
                  {['全部', ...subjects].map((subject) => (
                    <button
                      key={subject}
                      type="button"
                      className={`subject-chip${activeSubject === subject ? ' active' : ''}`}
                      onClick={() => setActiveSubject(subject)}
                    >
                      {subject}
                    </button>
                  ))}
                </div>
              )}

              {data.weeklyPlan.map((day) => {
                const groups = group_tasks_by_subject(day.tasks).filter(
                  (group) => activeSubject === '全部' || group.subject === activeSubject,
                )
                if (!groups.length) {
                  return null
                }
                return (
                  <div key={day.day_index} className="plan-day-card">
                    <div className="plan-day-header">
                      <span className="plan-day-index">Day {day.day_index}</span>
                      <span className="plan-day-focus">{day.focus}</span>
                    </div>
                    {groups.map((group) => (
                      <div key={group.subject} className="plan-subject-group">
                        <span className="plan-group-chip">{group.subject}</span>
                        {group.tasks.map((task) => {
                          const taskKey = plan_task_key(day.day_index, task)
                          const done = !!data.progress[taskKey]
                          return (
                            <div
                              key={taskKey}
                              className="plan-task-row"
                              onClick={() => toggleTask(day, task)}
                            >
                              <span className={`plan-checkbox${done ? ' checked' : ''}`}>
                                {done ? '✓' : ''}
                              </span>
                              <div className="plan-task-body">
                                <div className={`plan-task-title${done ? ' done' : ''}`}>
                                  {task.title}
                                </div>
                                <div className="plan-task-meta">
                                  {taskTypeLabel(task.task_type)} ·{' '}
                                  {formatDuration(task.duration_minutes)}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )
              })}
            </>
          )}

          {versions.length > 0 && (
            <div className="version-card">
              <div className="version-title">历史版本</div>
              <div className="version-hint">
                每一版计划都留在这里。一版执行完之后想调整，可以回到某一版继续，不必从零重生成。
              </div>
              {[...versions].reverse().map((item) => (
                <div key={item.version} className="version-row">
                  <div className="version-info">
                    <span className="version-name">第 {item.version} 版</span>
                    <span className="version-meta">
                      {formatRelativeTime(item.updated_at)}
                      {item.change_summary ? ` · ${item.change_summary}` : ''}
                    </span>
                  </div>
                  {item.version === data?.version ? (
                    <span className="version-current">当前</span>
                  ) : (
                    <button
                      type="button"
                      className="version-action"
                      onClick={() => restoreVersion(item.version)}
                    >
                      回到这版
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---------------- 长期：阶段划分 ---------------- */}
      {tab === 'long' && (
        <>
          {!longPlan && (
            <div className="plan-empty">
              <div className="plan-empty-title">还没有长期计划</div>
              <div className="plan-empty-desc">
                目标跨度超过一周时，我在对话里会自动帮你划分阶段。也可以在这里手动划分：
              </div>
              <input
                className="plan-add-input"
                placeholder="总目标，例如：三个月过六级"
                value={longGoal}
                onChange={(event) => setLongGoal(event.target.value)}
              />
              <input
                className="plan-add-input"
                placeholder="截止日期，格式 2026-12-21"
                value={longDeadline}
                onChange={(event) => setLongDeadline(event.target.value)}
              />
              <button
                type="button"
                className="plan-add-button"
                disabled={busy}
                onClick={buildLongPlan}
              >
                {busy ? '正在划分…' : '划分阶段'}
              </button>
            </div>
          )}

          {longPlan && (
            <>
              <div className="plan-summary">
                <div className="plan-summary-header">
                  <span className="plan-summary-title">长期计划</span>
                  <span className="version-badge">第 {longPlan.version} 版</span>
                </div>
                <div className="plan-summary-message">{longPlan.goal}</div>
                <div className="plan-updated">
                  {longPlan.deadline ? `截止 ${longPlan.deadline} · ` : ''}
                  共 {longPlan.milestones.length} 个阶段
                </div>
              </div>

              {longPlan.milestones.map((milestone) => (
                <div
                  key={milestone.id}
                  className={`milestone-card${milestone.status === 'active' ? ' active' : ''}`}
                >
                  <div className="milestone-header">
                    <span className="milestone-title">{milestone.title}</span>
                    <span className="milestone-status">
                      {milestone.status === 'done'
                        ? '已完成'
                        : milestone.status === 'active'
                          ? '进行中'
                          : '待开始'}
                    </span>
                  </div>
                  <div className="milestone-meta">
                    {milestone.start_date} ~ {milestone.due_date}
                  </div>
                  <div className="milestone-goal">{milestone.goal}</div>
                  <div className="milestone-acceptance">验收：{milestone.acceptance}</div>
                  <div className="milestone-actions">
                    <button type="button" className="version-action" onClick={() => planForMilestone(milestone)}>
                      按这个阶段排本周
                    </button>
                    {milestone.status !== 'done' && (
                      <button type="button" className="version-action" onClick={() => completeMilestone(milestone)}>
                        标记完成
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {/* ---------------- 复习：间隔重复队列 ---------------- */}
      {tab === 'review' && (
        <>
          <div className="plan-summary">
            <div className="plan-summary-header">
              <span className="plan-summary-title">复习</span>
              <span className="version-badge">今日 {dueReviews.length} 条</span>
            </div>
            <div className="plan-summary-message">
              完成学习类任务会自动进入复习队列，按间隔重复算法安排下次复习。间隔与难度都在本机计算，不需要联网。
            </div>
          </div>

          <div className="review-section">
            <div className="review-section-title">今天该复习</div>
            {dueReviews.length === 0 && (
              <div className="review-empty">今天没有到期的复习，先按计划推进新内容。</div>
            )}
            {dueReviews.map((item) => (
              <div key={item.id} className="review-row">
                <div className="review-info">
                  <div className="review-topic">{item.topic}</div>
                  <div className="review-meta">
                    {item.subject} · 间隔 {item.interval_days} 天 · 难度 {item.ease}
                  </div>
                </div>
                <div className="review-actions">
                  <button
                    type="button"
                    className="review-hint"
                    disabled={
                      hintPanel?.id === item.id && hintRevealed >= hintPanel.data.hints.length
                    }
                    onClick={() => void askHint(item)}
                  >
                    {hintPanel?.id !== item.id
                      ? '提示我'
                      : hintRevealed >= hintPanel.data.hints.length
                        ? '提示给完了'
                        : '再提示一点'}
                  </button>
                  <button type="button" className="review-pass" onClick={() => gradeReview(item, 5)}>
                    记得
                  </button>
                  <button type="button" className="review-fail" onClick={() => gradeReview(item, 2)}>
                    忘了
                  </button>
                </div>

                {hintPanel?.id === item.id && (
                  <div className="review-hint-panel">
                    <div className="review-hint-flags">
                      <span className="review-hint-flag">苏格拉底提示 · 不直接给答案</span>
                      {hintPanel.data.degraded && (
                        <span className="review-hint-flag warn">离线提示</span>
                      )}
                      {hintPanel.data.cached && <span className="review-hint-flag">已缓存</span>}
                      {!!hintPanel.data.filtered && (
                        <span className="review-hint-flag warn">
                          已拦下 {hintPanel.data.filtered} 条会泄露答案的提示
                        </span>
                      )}
                    </div>
                    <ol className="review-hint-list">
                      {hintPanel.data.hints.slice(0, hintRevealed).map((text, index) => (
                        <li key={`${item.id}-hint-${index}`}>
                          <span className="review-hint-tier">
                            {HINT_TIER_LABELS[index] ?? `第 ${index + 1} 级`}
                          </span>
                          <span className="review-hint-text">{text}</span>
                        </li>
                      ))}
                    </ol>
                    <div className="review-hint-foot">
                      <button
                        type="button"
                        className="review-answer-button"
                        disabled={hintRevealed < hintPanel.data.hints.length}
                        onClick={() => setHintAnswerOpen(true)}
                      >
                        {hintRevealed < hintPanel.data.hints.length
                          ? '三级提示用完才可看答案'
                          : '查看答案'}
                      </button>
                    </div>
                    {hintAnswerOpen && (
                      <div className="review-answer">
                        <div className="review-answer-text">
                          {hintPanel.data.answer || '这道题暂时没有可用的标准答案'}
                        </div>
                        <div className="review-answer-source">
                          依据：{hintPanel.data.answer_source}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="review-section">
            <div className="review-section-title">稍后复习（{upcomingReviews.length}）</div>
            {upcomingReviews.length === 0 && <div className="review-empty">队列里还没有后续安排。</div>}
            {upcomingReviews.map((item) => (
              <div key={item.id} className="review-row">
                <div className="review-info">
                  <div className="review-topic">{item.topic}</div>
                  <div className="review-meta">
                    {item.subject} · {item.due_date} · 间隔 {item.interval_days} 天
                  </div>
                </div>
                <button type="button" className="plan-remove" onClick={() => removeTopic(item)}>
                  移出
                </button>
              </div>
            ))}
          </div>

          <div className="review-section">
            <div className="review-section-title">手动加知识点</div>
            <input
              className="plan-add-input"
              placeholder="科目，如 高等数学"
              value={topicSubject}
              onChange={(event) => setTopicSubject(event.target.value)}
            />
            <div className="plan-add-row">
              <input
                className="plan-add-input"
                placeholder="知识点，如 夹逼定理"
                value={topicName}
                onChange={(event) => setTopicName(event.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    addTopic()
                  }
                }}
              />
              <button
                type="button"
                className="plan-add-button"
                disabled={!topicName.trim()}
                onClick={addTopic}
              >
                加入
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
