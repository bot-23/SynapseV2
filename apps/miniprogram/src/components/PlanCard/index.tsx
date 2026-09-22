import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import { group_tasks_by_subject, type StudyDayPlan } from '../../vendor/core'
import { taskTypeLabel } from '../../utils/labels'
import { formatDuration } from '../../utils/format'
import styles from './index.module.scss'

interface PlanCardProps {
  weeklyPlan: StudyDayPlan[]
  message?: string
  changeSummary?: string
}

/** 计划卡片：按科目分组展示每天任务（一份周计划内区分多科目） */
export default function PlanCard({ weeklyPlan, message, changeSummary }: PlanCardProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (!weeklyPlan.length) {
    return null
  }

  const totalTasks = weeklyPlan.reduce((sum, day) => sum + day.tasks.length, 0)
  const subjects = [
    ...new Set(weeklyPlan.flatMap((day) => day.tasks.map((task) => task.subject || '未分类')))
  ]

  return (
    <View className={styles.card}>
      <View className={styles.cardHeader} onClick={() => setCollapsed(!collapsed)}>
        <View className={styles.cardHeaderLeft}>
          <Text className={styles.cardTitle}>学习计划</Text>
          <Text className={styles.cardMeta}>
            {weeklyPlan.length} 天 · {totalTasks} 项 · {subjects.length} 个科目
          </Text>
        </View>
        <Text className={styles.cardToggle}>{collapsed ? '展开' : '收起'}</Text>
      </View>

      {!!changeSummary && <Text className={styles.changeSummary}>{changeSummary}</Text>}
      {!!message && <Text className={styles.cardMessage}>{message}</Text>}

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
