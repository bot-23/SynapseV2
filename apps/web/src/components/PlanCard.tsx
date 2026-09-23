import { useState } from 'react'
import {
  collect_document_hits,
  group_tasks_by_subject,
  summarize_context_sources,
  type StudyDayPlan,
} from '@synapse/core'
import { taskTypeLabel } from '../utils/format'
import { formatDuration } from '../utils/format'

interface PlanCardProps {
  weeklyPlan: StudyDayPlan[]
  retrievedContext?: string[]
  message?: string
  changeSummary?: string
}

/** 计划卡片：按科目分组展示每天任务（一份周计划内区分多科目） */
export default function PlanCard({
  weeklyPlan,
  retrievedContext = [],
  message,
  changeSummary,
}: PlanCardProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (!weeklyPlan.length) {
    return null
  }

  const totalTasks = weeklyPlan.reduce((sum, day) => sum + day.tasks.length, 0)
  const subjects = [
    ...new Set(weeklyPlan.flatMap((day) => day.tasks.map((task) => task.subject || '未分类'))),
  ]
  const sourceCounts = summarize_context_sources(retrievedContext)
  const sourceSummary = [
    ['资料', sourceCounts.document],
    ['课表', sourceCounts.timetable],
    ['执行记录', sourceCounts.progress],
    ['画像', sourceCounts.profile],
    ['知识图谱', sourceCounts.graph],
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([label, count]) => `${label} ×${count}`)
    .join(' / ')
  const documentNames = [
    ...new Set(collect_document_hits(retrievedContext).map((hit) => hit.file_name)),
  ]

  return (
    <div className="plan-card">
      <div className="plan-card-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="plan-card-header-left">
          <div className="plan-card-title-line">
            <span className="plan-card-title">学习计划</span>
            <span className="ai-badge">AI 生成</span>
          </div>
          <span className="plan-card-meta">
            {weeklyPlan.length} 天 · {totalTasks} 项 · {subjects.length} 个科目
          </span>
        </div>
        <span className="plan-card-toggle">{collapsed ? '展开' : '收起'}</span>
      </div>

      {!!changeSummary && <div className="plan-change-summary">{changeSummary}</div>}
      {!!message && <div className="plan-card-message">{message}</div>}
      {!!sourceSummary && (
        <div className="plan-source-summary">本次参考：{sourceSummary}</div>
      )}
      {!!documentNames.length && (
        <div className="plan-source-evidence">
          依据：你的资料《{documentNames.join('》《')}》
        </div>
      )}

      {!collapsed &&
        weeklyPlan.map((day) => {
          const groups = group_tasks_by_subject(day.tasks)
          return (
            <div key={day.day_index} className="plan-day-block">
              <div className="plan-day-header">
                <span className="plan-day-index">Day {day.day_index}</span>
                <span className="plan-day-focus">{day.focus}</span>
              </div>

              {groups.map((group) => (
                <div key={group.subject} className="plan-subject-group">
                  <span className="plan-subject-chip">{group.subject}</span>
                  {group.tasks.map((task, index) => (
                    <div key={`${group.subject}-${index}`} className="plan-task-row">
                      <div className="plan-task-body">
                        <div className="plan-task-title">{task.title}</div>
                        {!!task.reason && <div className="plan-task-reason">{task.reason}</div>}
                      </div>
                      <div className="plan-task-right">
                        <span className="plan-task-type">{taskTypeLabel(task.task_type)}</span>
                        <span className="plan-task-minutes">{formatDuration(task.duration_minutes)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )
        })}

      <div className="plan-card-hint">计划已自动保存，可在「计划」页勾选完成情况</div>
    </div>
  )
}