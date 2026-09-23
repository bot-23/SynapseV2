import { useEffect, useState } from 'react'
import { getCore, DEFAULT_USER_ID } from '../services/synapse'

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
  subject: string
  minutes: number
}

interface DaySlotView {
  date: string
  day_index: number
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

function amountOf(item: AssignmentItemView): string {
  if (!item.quantity) {
    return ''
  }
  return item.unit ? `${item.quantity}${item.unit}` : `${item.quantity}`
}

export default function AssignmentsView() {
  const [board, setBoard] = useState<BoardView | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const flash = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2600)
  }

  const load = () => {
    const result = getCore().listAssignments(DEFAULT_USER_ID)
    setBoard((result.data as unknown as BoardView) ?? null)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addAssignments = async () => {
    const content = text.trim()
    if (!content || busy) {
      return
    }
    setBusy(true)
    try {
      const result = await getCore().createAssignments(DEFAULT_USER_ID, content)
      console.log('[Synapse] 添加作业', result.success, result.message)
      flash(result.message)
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
    flash(result.message)
    load()
  }

  const reschedule = () => {
    const result = getCore().rescheduleOverdueAssignments(DEFAULT_USER_ID)
    console.log('[Synapse] 逾期重排', result.success, result.message)
    flash(result.message)
    load()
  }

  const today = todayString()
  const items = board?.items ?? []
  const groups = items.reduce<Array<{ date: string; items: AssignmentItemView[] }>>(
    (accumulator, item) => {
      const bucket = accumulator.find((group) => group.date === item.due_date)
      if (bucket) {
        bucket.items.push(item)
      } else {
        accumulator.push({ date: item.due_date, items: [item] })
      }
      return accumulator
    },
    [],
  )
  groups.sort((a, b) => (a.date < b.date ? -1 : 1))

  return (
    <div className="docs-page">
      <div className="notice snackbar">{notice}</div>

      <div className="mine-card">
        <div className="card-title">作业式计划</div>
        <div className="card-desc">
          「目标式计划」是我想学，「作业式计划」是我必须交。把老师布置的任务原话丢进来，系统按截止日摊到每一天，并盯着打卡。
        </div>
        <textarea
          className="mine-textarea"
          placeholder="例如：数学第三章习题1-20明天交，英语背Unit3单词周五默写"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
        />
        <button
          type="button"
          className={`primary-button${busy || !text.trim() ? ' disabled' : ''}`}
          disabled={busy || !text.trim()}
          onClick={addAssignments}
        >
          {busy ? '正在排期…' : '排进日程'}
        </button>
      </div>

      <div className="mine-card">
        <div className="assignment-head">
          <div>
            <div className="card-title">作业清单（{board?.total ?? 0}）</div>
            <div className="card-desc">
              待办 {board?.pending_count ?? 0} · 逾期 {board?.overdue_count ?? 0} · 已完成{' '}
              {board?.done_count ?? 0}
            </div>
          </div>
          <button
            type="button"
            className="doc-build"
            disabled={!board?.overdue_count}
            onClick={reschedule}
          >
            重新排期
          </button>
        </div>

        {!items.length && (
          <div className="card-desc">还没有作业。上面粘一句「数学第三章习题1-20明天交」试试。</div>
        )}

        {groups.map((group) => {
          const countdown = countdownOf(group.date, today)
          const urgent = countdown === '今天截止' || countdown.startsWith('已逾期')
          return (
            <div key={group.date} className="assignment-group">
              <div className="assignment-group-head">
                <span className="assignment-date">{group.date}</span>
                <span className={`assignment-countdown${urgent ? ' urgent' : ''}`}>
                  {countdown}
                </span>
              </div>
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className={`assignment-row${item.status === 'done' ? ' done' : ''}${
                    item.status === 'overdue' ? ' overdue' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    className="assignment-toggle"
                    aria-label={`完成 ${item.title}`}
                    checked={item.status === 'done'}
                    onChange={() => toggle(item)}
                  />
                  <div className="assignment-info">
                    <div className="assignment-title">
                      {item.subject && <span className="doc-subject">{item.subject}</span>}
                      <span className="assignment-name">{item.title}</span>
                      {!!amountOf(item) && <span className="assignment-amount">{amountOf(item)}</span>}
                    </div>
                    <div className="doc-meta">
                      预估 {item.estimated_minutes} 分钟
                      {item.status === 'done'
                        ? ` · 已于 ${item.done_at} 完成`
                        : item.status === 'overdue'
                          ? ` · 已逾期${item.original_due_date ? `（原定 ${item.original_due_date}）` : ''}`
                          : ''}
                      {item.review_card_ids.length
                        ? ` · ${item.review_card_ids.length} 张复习卡`
                        : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <div className="mine-card">
        <div className="card-title">未来排期</div>
        <div className="card-desc">
          每条作业从今天起均匀摊到截止日，并按你的每日时长预算收口（逾期项排在今天补做）。
        </div>
        {!(board?.schedule ?? []).length && <div className="card-desc">暂时没有需要排的作业。</div>}
        {(board?.schedule ?? []).map((day) => (
          <div key={day.date} className="assignment-day">
            <div className="assignment-group-head">
              <span className="assignment-date">{day.date}</span>
              <span className="assignment-countdown">{day.countdown}</span>
              <span className="assignment-minutes">约 {day.total_minutes} 分钟</span>
            </div>
            {day.tasks.map((task, index) => (
              <div key={`${day.date}-${index}`} className="assignment-slot">
                {task.title}
                <span className="assignment-slot-minutes">{task.minutes} 分钟</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
