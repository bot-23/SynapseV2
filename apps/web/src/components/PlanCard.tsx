import { useState } from 'react'
import {
  build_plan_evidence,
  collect_document_hits,
  group_tasks_by_subject,
  summarize_context_sources,
  type StudyDayPlan,
  type StudyPlanRequest,
} from '@synapse/core'
import { taskTypeLabel } from '../utils/format'
import { formatDuration } from '../utils/format'

interface PlanCardProps {
  weeklyPlan: StudyDayPlan[]
  retrievedContext?: string[]
  message?: string
  changeSummary?: string
  /** 归一化后的请求（透传，用于复述「这版是按什么约束排的」） */
  request?: StudyPlanRequest | null
  /** 计划生成时给出的理由（透传，来自落库的 reason） */
  reason?: string
}

const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  timetable: '课程表',
  progress: '执行记录',
  profile: '画像',
}

/** 计划卡片：按科目分组展示每天任务（一份周计划内区分多科目） */
export default function PlanCard({
  weeklyPlan,
  retrievedContext = [],
  message,
  changeSummary,
  request = null,
  reason = '',
}: PlanCardProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showEvidence, setShowEvidence] = useState(false)

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

  // G4.3：把「已经存在的证据」摊开——资料原文片段 / 图谱路径 / 命中的规则
  const evidence = build_plan_evidence({ context: retrievedContext, weeklyPlan, request })
  const hasEvidence =
    evidence.documents.length > 0 ||
    evidence.graph_paths.length > 0 ||
    evidence.others.length > 0 ||
    evidence.rules.length > 0

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

      {hasEvidence && (
        <div className="plan-evidence">
          <button
            type="button"
            className="plan-evidence-toggle"
            onClick={() => setShowEvidence(!showEvidence)}
          >
            {showEvidence ? '收起依据' : 'AI 为什么这么安排'}
          </button>
          {showEvidence && (
            <div className="plan-evidence-body">
              {!!reason && <div className="plan-evidence-reason">{reason}</div>}

              {evidence.rules.length > 0 && (
                <div className="plan-evidence-group">
                  <div className="plan-evidence-title">命中的规则（{evidence.rules.length}）</div>
                  <ul className="plan-evidence-list">
                    {evidence.rules.map((rule, index) => (
                      <li key={`rule-${index}`}>{rule}</li>
                    ))}
                  </ul>
                </div>
              )}

              {evidence.documents.length > 0 && (
                <div className="plan-evidence-group">
                  <div className="plan-evidence-title">
                    资料原文片段（{evidence.documents.length}）
                  </div>
                  {evidence.documents.map((hit, index) => (
                    <div key={`doc-${index}`} className="plan-evidence-item">
                      <span className="plan-evidence-name">{hit.file_name}</span>
                      <span className="plan-evidence-text">{hit.excerpt}</span>
                    </div>
                  ))}
                </div>
              )}

              {evidence.graph_paths.length > 0 && (
                <div className="plan-evidence-group">
                  <div className="plan-evidence-title">
                    图谱学习路径（{evidence.graph_paths.length}）
                  </div>
                  <ul className="plan-evidence-list">
                    {evidence.graph_paths.map((line, index) => (
                      <li key={`graph-${index}`}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}

              {evidence.others.length > 0 && (
                <div className="plan-evidence-group">
                  <div className="plan-evidence-title">其他参考</div>
                  <ul className="plan-evidence-list">
                    {evidence.others.map((item, index) => (
                      <li key={`other-${index}`}>
                        {EVIDENCE_SOURCE_LABELS[item.source] ?? item.source}：{item.text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
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