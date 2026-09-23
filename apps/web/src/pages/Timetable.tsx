import { useEffect, useState } from 'react'
import { getCore, DEFAULT_USER_ID } from '../services/synapse'
import { browserIdGen } from '../adapters/system'
import type { TimetableEntry } from '@synapse/core'
import {
  WEEKDAY_OPTIONS,
  clockToMinute,
  minuteToClock,
  weekdayLabel,
} from '../utils/format'

const PASTE_EXAMPLE = `周一 高等数学 08:00-09:40
周一 大学物理 10:00-11:40
周三 线性代数 14:00-15:40 1-16周`

const emptyDraft = () => ({
  name: '',
  weekday: 1,
  startClock: '08:00',
  endClock: '09:40',
  weeks: '',
  location: '',
})

export default function TimetableView() {
  const [entries, setEntries] = useState<TimetableEntry[]>([])
  const [pasteText, setPasteText] = useState('')
  const [unparsedLines, setUnparsedLines] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState(emptyDraft())
  const [notice, setNotice] = useState('')

  const flash = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2600)
  }

  const load = () => {
    const result = getCore().getTimetable(DEFAULT_USER_ID)
    const data = (result.data ?? {}) as Record<string, unknown>
    setEntries((data['entries'] ?? []) as TimetableEntry[])
    setDirty(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const parsePaste = () => {
    if (!pasteText.trim()) {
      flash('先粘贴课表文本')
      return
    }
    const result = getCore().parseTimetable(pasteText)
    const data = (result.data ?? {}) as Record<string, unknown>
    const parsed = (data['entries'] ?? []) as TimetableEntry[]
    const missed = (data['unparsedLines'] ?? []) as string[]
    const warns = (data['warnings'] ?? []) as string[]
    console.log('[Synapse] 课表解析', parsed.length, missed.length)
    setUnparsedLines(missed)
    setWarnings(warns)

    if (!parsed.length) {
      flash('没识别出课程，可改用下方手动录入')
      return
    }
    setEntries([...entries, ...parsed])
    setDirty(true)
    setPasteText('')
    flash(`识别出 ${parsed.length} 节课，记得保存`)
  }

  const updateEntry = (id: string, patch: Partial<TimetableEntry>) => {
    setEntries((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
    setDirty(true)
  }

  const removeEntry = (id: string) => {
    setEntries((prev) => prev.filter((item) => item.id !== id))
    setDirty(true)
    if (editingId === id) {
      setEditingId('')
    }
  }

  const addDraft = () => {
    if (!draft.name.trim()) {
      flash('请填写课程名')
      return
    }
    if (clockToMinute(draft.endClock) <= clockToMinute(draft.startClock)) {
      flash('结束时间要晚于开始时间')
      return
    }
    const entry: TimetableEntry = {
      id: browserIdGen.next(),
      name: draft.name.trim(),
      subject: draft.name.trim(),
      weekday: draft.weekday,
      startMinute: clockToMinute(draft.startClock),
      endMinute: clockToMinute(draft.endClock),
      weeks: draft.weeks.trim(),
      location: draft.location.trim(),
      teacher: '',
    }
    setEntries((prev) => [...prev, entry])
    setDirty(true)
    setDraft(emptyDraft())
    flash('已添加，记得保存')
  }

  const saveAll = () => {
    const result = getCore().saveTimetable(DEFAULT_USER_ID, entries)
    console.log('[Synapse] 保存课表', result.success, result.message)
    flash(result.message)
    if (result.success) {
      const data = (result.data ?? {}) as Record<string, unknown>
      setEntries((data['entries'] ?? []) as TimetableEntry[])
      setDirty(false)
    }
  }

  const sorted = [...entries].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
  )

  return (
    <div className="docs-page">
      <div className="notice snackbar">{notice}</div>

      <div className="mine-card">
        <div className="card-title">从教务系统粘贴课表</div>
        <div className="card-desc">
          支持「周一 课程名 08:00-09:40」这类逐行文本，也支持先粘贴星期表头再粘贴课程行。解析后可以逐条校正。
        </div>
        <textarea
          className="mine-textarea"
          placeholder={PASTE_EXAMPLE}
          value={pasteText}
          onChange={(event) => setPasteText(event.target.value)}
          rows={5}
        />
        <button type="button" className="primary-button" onClick={parsePaste}>
          解析这段文本
        </button>
        {unparsedLines.length > 0 && (
          <div className="tt-warn-box">
            <div className="tt-warn-title">以下内容没识别出来，可手动录入：</div>
            {unparsedLines.map((line, index) => (
              <div key={index} className="tt-warn-line">
                · {line}
              </div>
            ))}
          </div>
        )}
        {warnings.map((warning, index) => (
          <div key={index} className="tt-warn-text">
            {warning}
          </div>
        ))}
      </div>

      <div className="mine-card">
        <div className="card-title">手动添加一节</div>
        <input
          className="mine-input"
          placeholder="课程名，如 高等数学"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <div className="tt-field-row">
          <select
            className="tt-picker"
            value={draft.weekday}
            onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })}
          >
            {WEEKDAY_OPTIONS.map((label, index) => (
              <option key={label} value={index + 1}>
                星期 {label}
              </option>
            ))}
          </select>
          <input
            type="time"
            className="tt-picker"
            value={draft.startClock}
            onChange={(event) => setDraft({ ...draft, startClock: event.target.value })}
          />
          <input
            type="time"
            className="tt-picker"
            value={draft.endClock}
            onChange={(event) => setDraft({ ...draft, endClock: event.target.value })}
          />
        </div>
        <div className="tt-field-row">
          <input
            className="mine-input"
            placeholder="周次，如 1-16（可空）"
            value={draft.weeks}
            onChange={(event) => setDraft({ ...draft, weeks: event.target.value })}
          />
          <input
            className="mine-input"
            placeholder="地点（可空）"
            value={draft.location}
            onChange={(event) => setDraft({ ...draft, location: event.target.value })}
          />
        </div>
        <button type="button" className="secondary-button" onClick={addDraft}>
          添加到课表
        </button>
      </div>

      <div className="mine-card">
        <div className="tt-list-header">
          <span className="card-title">课表（{entries.length} 节）</span>
          {dirty && <span className="tt-dirty">有未保存修改</span>}
        </div>

        {entries.length === 0 && (
          <div className="tt-empty">
            还没有课程。导入或手动添加后，生成的计划会自动避开上课时段。
          </div>
        )}

        {sorted.map((entry) => (
          <div key={entry.id} className="tt-entry">
            <div
              className="tt-entry-main"
              onClick={() => setEditingId(editingId === entry.id ? '' : entry.id)}
            >
              <div className="tt-entry-left">
                <span className="tt-entry-weekday">{weekdayLabel(entry.weekday)}</span>
                <div className="tt-entry-info">
                  <div className="tt-entry-name">{entry.name}</div>
                  <div className="tt-entry-time">
                    {minuteToClock(entry.startMinute)} - {minuteToClock(entry.endMinute)}
                    {entry.weeks ? ` · ${entry.weeks} 周` : ''}
                    {entry.location ? ` · ${entry.location}` : ''}
                  </div>
                </div>
              </div>
              <span className="tt-entry-toggle">{editingId === entry.id ? '收起' : '校正'}</span>
            </div>

            {editingId === entry.id && (
              <div className="tt-entry-editor">
                <input
                  className="mine-input"
                  value={entry.name}
                  onChange={(event) =>
                    updateEntry(entry.id, {
                      name: event.target.value,
                      subject: event.target.value,
                    })
                  }
                />
                <div className="tt-field-row">
                  <select
                    className="tt-picker"
                    value={entry.weekday}
                    onChange={(event) =>
                      updateEntry(entry.id, { weekday: Number(event.target.value) })
                    }
                  >
                    {WEEKDAY_OPTIONS.map((label, index) => (
                      <option key={label} value={index + 1}>
                        星期 {label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    className="tt-picker"
                    value={minuteToClock(entry.startMinute)}
                    onChange={(event) =>
                      updateEntry(entry.id, { startMinute: clockToMinute(event.target.value) })
                    }
                  />
                  <input
                    type="time"
                    className="tt-picker"
                    value={minuteToClock(entry.endMinute)}
                    onChange={(event) =>
                      updateEntry(entry.id, { endMinute: clockToMinute(event.target.value) })
                    }
                  />
                </div>
                <button type="button" className="tt-danger" onClick={() => removeEntry(entry.id)}>
                  删除这一节
                </button>
              </div>
            )}
          </div>
        ))}

        <button
          type="button"
          className={`primary-button${!dirty ? ' muted' : ''}`}
          disabled={!dirty}
          onClick={saveAll}
        >
          {dirty ? '保存课表' : '课表已是最新'}
        </button>
      </div>

      <div className="tt-foot-note">
        保存后，计划生成会把这些时段视为不可用，并按当天空闲时长压缩任务量。
      </div>
    </div>
  )
}