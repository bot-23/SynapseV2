import { useState } from 'react'
import { View, Text, Textarea, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import { getCore, DEFAULT_USER_ID } from '../../services/synapse'
import styles from './index.module.scss'

interface AssignmentItemView {
  id: string
  subject: string
  title: string
  quantity: number
  unit: string
  due_date: string
  estimated_minutes: number
  status: string
  done_at: string
  review_card_ids: string[]
  original_due_date: string
}

interface SlotTaskView {
  assignment_id: string
  title: string
  minutes: number
}

interface DaySlotView {
  date: string
  countdown: string
  tasks: SlotTaskView[]
  total_minutes: number
}

interface BoardView {
  items: AssignmentItemView[]
  schedule: DaySlotView[]
  total: number
  pending_count: number
  done_count: number
  overdue_count: number
}

function todayString(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function countdownOf(dueDate: string, today: string): string {
  const due = Date.parse(`${dueDate}T00:00:00Z`)
  const base = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(due) || !Number.isFinite(base)) {
    return ''
  }
  const days = Math.round((due - base) / 86400000)
  if (days > 0) {
    return `D-${days}`
  }
  if (days === 0) {
    return '今天截止'
  }
  return `已逾期 ${-days} 天`
}

export default function AssignmentsPage() {
  const [board, setBoard] = useState<BoardView | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => {
    const result = getCore().listAssignments(DEFAULT_USER_ID)
    setBoard((result.data as unknown as BoardView) ?? null)
  }

  useDidShow(() => {
    load()
  })

  const addAssignments = async () => {
    const content = text.trim()
    if (!content || busy) {
      return
    }
    setBusy(true)
    try {
      const result = await getCore().createAssignments(DEFAULT_USER_ID, content)
      console.log('[Synapse] 添加作业', result.success, result.message)
      Taro.showToast({ title: result.message, icon: 'none' })
      if (result.success && Number((result.data ?? {})['added'] ?? 0) > 0) {
        setText('')
      }
      load()
    } finally {
      setBusy(false)
    }
  }

  const toggle = (item: AssignmentItemView) => {
    const done = item.status !== 'done'
    const result = getCore().completeAssignment(DEFAULT_USER_ID, item.id, done)
    console.log('[Synapse] 作业打卡', item.id, done, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const reschedule = () => {
    const result = getCore().rescheduleOverdueAssignments(DEFAULT_USER_ID)
    console.log('[Synapse] 逾期重排', result.success, result.message)
    Taro.showToast({ title: result.message, icon: 'none' })
    load()
  }

  const today = todayString()
  const items = board?.items ?? []
  const groups: Array<{ date: string; items: AssignmentItemView[] }> = []
  for (const item of items) {
    const bucket = groups.find((group) => group.date === item.due_date)
    if (bucket) {
      bucket.items.push(item)
    } else {
      groups.push({ date: item.due_date, items: [item] })
    }
  }
  groups.sort((a, b) => (a.date < b.date ? -1 : 1))

  return (
    <View className={styles.page}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>作业式计划</Text>
        <Text className={styles.cardDesc}>
          「目标式计划」是我想学，「作业式计划」是我必须交。把老师布置的任务原话丢进来，按截止日摊到每一天。
        </Text>
        <Textarea
          className={styles.textarea}
          placeholder="例如：数学第三章习题1-20明天交，英语背Unit3单词周五默写"
          value={text}
          maxlength={-1}
          onInput={(event) => setText(String(event.detail.value))}
        />
        <Button
          className={classnames(styles.primaryButton, busy && styles.buttonDisabled)}
          disabled={busy || !text.trim()}
          onClick={addAssignments}
        >
          {busy ? '正在排期…' : '排进日程'}
        </Button>
      </View>

      <View className={styles.card}>
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>作业清单（{board?.total ?? 0}）</Text>
          <View
            className={classnames(styles.smallButton, !board?.overdue_count && styles.buttonDisabled)}
            onClick={() => board?.overdue_count && reschedule()}
          >
            <Text className={styles.smallButtonText}>重新排期</Text>
          </View>
        </View>
        <Text className={styles.cardDesc}>
          待办 {board?.pending_count ?? 0} · 逾期 {board?.overdue_count ?? 0} · 已完成{' '}
          {board?.done_count ?? 0}
        </Text>

        {items.length === 0 && (
          <Text className={styles.cardDesc}>还没有作业。上面粘一句「数学第三章习题1-20明天交」试试。</Text>
        )}

        {groups.map((group) => {
          const countdown = countdownOf(group.date, today)
          const urgent = countdown === '今天截止' || countdown.startsWith('已逾期')
          return (
            <View key={group.date}>
              <View className={styles.groupHead}>
                <Text className={styles.groupDate}>{group.date}</Text>
                <Text className={classnames(styles.countdown, urgent && styles.countdownUrgent)}>
                  {countdown}
                </Text>
              </View>
              {group.items.map((item) => (
                <View
                  key={item.id}
                  className={classnames(
                    styles.itemRow,
                    item.status === 'done' && styles.itemDone,
                    item.status === 'overdue' && styles.itemOverdue
                  )}
                >
                  <View className={styles.toggle} onClick={() => toggle(item)}>
                    <Text className={styles.toggleText}>
                      {item.status === 'done' ? '✓' : '○'}
                    </Text>
                  </View>
                  <View className={styles.itemInfo}>
                    <View className={styles.itemTitleRow}>
                      {!!item.subject && <Text className={styles.subjectTag}>{item.subject}</Text>}
                      <Text className={styles.itemTitle}>{item.title}</Text>
                      {!!item.quantity && (
                        <Text className={styles.amountTag}>
                          {item.quantity}
                          {item.unit}
                        </Text>
                      )}
                    </View>
                    <Text className={styles.itemMeta}>
                      预估 {item.estimated_minutes} 分钟
                      {item.status === 'done'
                        ? ` · 已于 ${item.done_at} 完成`
                        : item.status === 'overdue'
                          ? ` · 已逾期${item.original_due_date ? `（原定 ${item.original_due_date}）` : ''}`
                          : ''}
                      {item.review_card_ids.length
                        ? ` · ${item.review_card_ids.length} 张复习卡`
                        : ''}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )
        })}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>未来排期</Text>
        <Text className={styles.cardDesc}>
          每条作业从今天起均匀摊到截止日，并按你的每日时长预算收口（逾期项排在今天补做）。
        </Text>
        {(board?.schedule ?? []).map((day) => (
          <View key={day.date}>
            <View className={styles.groupHead}>
              <Text className={styles.groupDate}>{day.date}</Text>
              <Text className={styles.countdown}>{day.countdown}</Text>
              <Text className={styles.dayMinutes}>约 {day.total_minutes} 分钟</Text>
            </View>
            {day.tasks.map((task, index) => (
              <View key={`${day.date}-${index}`} className={styles.slotRow}>
                <Text className={styles.slotTitle}>{task.title}</Text>
                <Text className={styles.slotMinutes}>{task.minutes} 分钟</Text>
              </View>
            ))}
          </View>
        ))}
      </View>

      <View className={styles.bottomSpacer} />
    </View>
  )
}
