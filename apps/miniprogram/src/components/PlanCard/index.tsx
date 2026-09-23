import { useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import {
  build_plan_evidence,
  collect_document_hits,
  group_tasks_by_subject,
  summarize_context_sources,
  type StudyDayPlan,
  type StudyPlanRequest
} from '../../vendor/core'
import { taskTypeLabel } from '../../utils/labels'
import { formatDuration } from '../../utils/format'
import styles from './index.module.scss'

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
  profile: '画像'
}

/** 计划卡片：按科目分组展示每天任务（一份周计划内区分多科目） */
export default function PlanCard({
  weeklyPlan,
  retrievedContext = [],
  message,
  changeSummary,
  request = null,
  reason = ''
}: PlanCardProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showEvidence, setShowEvidence] = useState(false)

  if (!weeklyPlan.length) {
    return null
  }

  const totalTasks = weeklyPlan.reduce((sum, day) => sum + day.tasks.length, 0)
  const subjects = [
    ...new Set(weeklyPlan.flatMap((day) => day.tasks.map((task) => task.subject || '未分类')))
  ]
  const sourceCounts = summarize_context_sources(retrievedContext)
  const sourceSummary = [
    ['资料', sourceCounts.document],
    ['课表', sourceCounts.timetable],
    ['执行记录', sourceCounts.progress],
    ['画像', sourceCounts.profile],
    ['知识图谱', sourceCounts.graph]
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([label, count]) => `${label} ×${count}`)
    .join(' / ')
  const documentNames = [
    ...new Set(collect_document_hits(retrievedContext).map((hit) => hit.file_name))
  ]

  // G4.3：把「已经存在的证据」摊开——资料原文片段 / 图谱路径 / 命中的规则
  const evidence = build_plan_evidence({ context: retrievedContext, weeklyPlan, request })
  const hasEvidence =
    evidence.documents.length > 0 ||
    evidence.graph_paths.length > 0 ||
    evidence.others.length > 0 ||
    evidence.rules.length > 0

  return (
    <View className={styles.card}>
      <View className={styles.cardHeader} onClick={() => setCollapsed(!collapsed)}>
        <View className={styles.cardHeaderLeft}>
          <View className={styles.titleLine}>
            <Text className={styles.cardTitle}>学习计划</Text>
            <Text className={styles.aiBadge}>AI 生成</Text>
          </View>
          <Text className={styles.cardMeta}>
            {weeklyPlan.length} 天 · {totalTasks} 项 · {subjects.length} 个科目
          </Text>
        </View>
        <Text className={styles.cardToggle}>{collapsed ? '展开' : '收起'}</Text>
      </View>

      {!!changeSummary && <Text className={styles.changeSummary}>{changeSummary}</Text>}
      {!!message && <Text className={styles.cardMessage}>{message}</Text>}
      {!!sourceSummary && <Text className={styles.sourceSummary}>本次参考：{sourceSummary}</Text>}
      {!!documentNames.length && (
        <Text className={styles.sourceEvidence}>依据：你的资料《{documentNames.join('》《')}》</Text>
      )}

      {hasEvidence && (
        <View className={styles.evidence}>
          <Button
            className={styles.evidenceToggle}
            size="mini"
            onClick={() => setShowEvidence(!showEvidence)}
          >
            {showEvidence ? '收起依据' : 'AI 为什么这么安排'}
          </Button>
          {showEvidence && (
            <View className={styles.evidenceBody}>
              {!!reason && <Text className={styles.evidenceReason}>{reason}</Text>}

              {evidence.rules.length > 0 && (
                <View className={styles.evidenceGroup}>
                  <Text className={styles.evidenceTitle}>命中的规则（{evidence.rules.length}）</Text>
                  {evidence.rules.map((rule, index) => (
                    <Text key={`rule-${index}`} className={styles.evidenceBullet}>
                      · {rule}
                    </Text>
                  ))}
                </View>
              )}

              {evidence.documents.length > 0 && (
                <View className={styles.evidenceGroup}>
                  <Text className={styles.evidenceTitle}>
                    资料原文片段（{evidence.documents.length}）
                  </Text>
                  {evidence.documents.map((hit, index) => (
                    <View key={`doc-${index}`} className={styles.evidenceItem}>
                      <Text className={styles.evidenceName}>{hit.file_name}</Text>
                      <Text className={styles.evidenceText}>{hit.excerpt}</Text>
                    </View>
                  ))}
                </View>
              )}

              {evidence.graph_paths.length > 0 && (
                <View className={styles.evidenceGroup}>
                  <Text className={styles.evidenceTitle}>
                    图谱学习路径（{evidence.graph_paths.length}）
                  </Text>
                  {evidence.graph_paths.map((line, index) => (
                    <Text key={`graph-${index}`} className={styles.evidenceBullet}>
                      · {line}
                    </Text>
                  ))}
                </View>
              )}

              {evidence.others.length > 0 && (
                <View className={styles.evidenceGroup}>
                  <Text className={styles.evidenceTitle}>其他参考</Text>
                  {evidence.others.map((item, index) => (
                    <Text key={`other-${index}`} className={styles.evidenceBullet}>
                      · {EVIDENCE_SOURCE_LABELS[item.source] ?? item.source}：{item.text}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {!collapsed &&
        weeklyPlan.map((day) => {
          const groups = group_tasks_by_subject(day.tasks)
          return (
            <View key={day.day_index} className={styles.dayBlock}>
              <View className={styles.dayHeader}>
                <Text className={styles.dayIndex}>Day {day.day_index}</Text>
                <Text className={styles.dayFocus}>{day.focus}</Text>
              </View>

              {groups.map((group) => (
                <View key={group.subject} className={styles.subjectGroup}>
                  <View className={styles.subjectChip}>
                    <Text className={styles.chipText}>{group.subject}</Text>
                  </View>
                  {group.tasks.map((task, index) => (
                    <View key={`${group.subject}-${index}`} className={styles.taskRow}>
                      <View className={styles.taskBody}>
                        <Text className={styles.taskTitle}>{task.title}</Text>
                        {!!task.reason && <Text className={styles.taskReason}>{task.reason}</Text>}
                      </View>
                      <View className={styles.taskRight}>
                        <Text className={styles.taskType}>{taskTypeLabel(task.task_type)}</Text>
                        <Text className={styles.taskMinutes}>
                          {formatDuration(task.duration_minutes)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          )
        })}

      <Text className={styles.cardHint}>计划已自动保存，可在「计划」页勾选完成情况</Text>
    </View>
  )
}
