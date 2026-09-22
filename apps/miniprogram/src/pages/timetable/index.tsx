import { useState } from 'react'
import { View, Text, Input, Textarea, Button, Picker } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import { getCore, DEFAULT_USER_ID } from '../../services/synapse'
import { taroIdGen } from '../../adapters/system'
import type { TimetableEntry } from '../../vendor/core'
import {
  WEEKDAY_OPTIONS,
  clockToMinute,
  minuteToClock,
  weekdayLabel
} from '../../utils/format'
import styles from './index.module.scss'

const PASTE_EXAMPLE = `周一 高等数学 08:00-09:40
周一 大学物理 10:00-11:40
周三 线性代数 14:00-15:40 1-16周`

const emptyDraft = () => ({
  name: '',
  weekday: 1,
  startClock: '08:00',
  endClock: '09:40',
  weeks: '',
  location: ''
})

export default function TimetablePage() {
  const [entries, setEntries] = useState<TimetableEntry[]>([])
  const [pasteText, setPasteText] = useState('')
  const [unparsedLines, setUnparsedLines] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState(emptyDraft())

  const load = () => {
    const result = getCore().getTimetable(DEFAULT_USER_ID)
    const data = (result.data ?? {}) as Record<string, unknown>
    setEntries((data['entries'] ?? []) as TimetableEntry[])
    setDirty(false)
  }

  useDidShow(() => {
    load()
  })

  const parsePaste = () => {
    if (!pasteText.trim()) {
      Taro.showToast({ title: '先粘贴课表文本', icon: 'none' })
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
      Taro.showToast({ title: '没识别出课程，可改用下方手动录入', icon: 'none' })
      return
    }
    setEntries([...entries, ...parsed])
    setDirty(true)
    setPasteText('')
    Taro.showToast({ title: `识别出 ${parsed.length} 节课，记得保存`, icon: 'none' })
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
      Taro.showToast({ title: '请填写课程名', icon: 'none' })
      return
    }
    if (clockToMinute(draft.endClock) <= clockToMinute(draft.startClock)) {
      Taro.showToast({ title: '结束时间要晚于开始时间', icon: 'none' })
      return
    }
    const entry: TimetableEntry = {
      id: taroIdGen.next(),
      name: draft.name.trim(),
      subject: draft.name.trim(),
      weekday: draft.weekday,
      startMinute: clockToMinute(draft.startClock),
      endMinute: clockToMinute(draft.endClock),
      weeks: draft.weeks.trim(),
      location: draft.location.trim(),
      teacher: ''
    }
    setEntries((prev) => [...prev, entry])
    setDirty(true)
    setDraft(emptyDraft())
    Taro.showToast({ title: '已添加，记得保存', icon: 'none' })
  }

  const saveAll = () => {
    const result = getCore().saveTimetable(DEFAULT_USER_ID, entries)
    console.log('[Synapse] 保存课表', result.success, result.message)
    Taro.showToast({ title: result.message, icon: 'none' })
    if (result.success) {
      const data = (result.data ?? {}) as Record<string, unknown>
      setEntries((data['entries'] ?? []) as TimetableEntry[])
      setDirty(false)
    }
  }

  const sorted = [...entries].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute
  )

  return (
    <View className={styles.page}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>从教务系统粘贴课表</Text>
        <Text className={styles.cardDesc}>
          支持「周一 课程名 08:00-09:40」这类逐行文本，也支持先粘贴星期表头再粘贴课程行。解析后可以逐条校正。
        </Text>
        <Textarea
          className={styles.textarea}
          placeholder={PASTE_EXAMPLE}
          value={pasteText}
          maxlength={-1}
          onInput={(event) => setPasteText(String(event.detail.value))}
        />
        <Button className={styles.primaryButton} onClick={parsePaste}>
          解析这段文本
        </Button>
        {unparsedLines.length > 0 && (
          <View className={styles.warnBox}>
            <Text className={styles.warnTitle}>以下内容没识别出来，可手动录入：</Text>
            {unparsedLines.map((line, index) => (
              <Text key={index} className={styles.warnLine}>
                · {line}
              </Text>
            ))}
          </View>
        )}
        {warnings.map((warning, index) => (
          <Text key={index} className={styles.warnText}>
            {warning}
          </Text>
        ))}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>手动添加一节</Text>
        <Input
          className={styles.input}
          placeholder="课程名，如 高等数学"
          value={draft.name}
          onInput={(event) => setDraft({ ...draft, name: String(event.detail.value) })}
        />
        <View className={styles.fieldRow}>
          <Picker
            mode="selector"
            range={WEEKDAY_OPTIONS}
            value={draft.weekday - 1}
            onChange={(event) =>
              setDraft({ ...draft, weekday: Number(event.detail.value) + 1 })
            }
          >
            <View className={styles.picker}>
              <Text className={styles.pickerLabel}>星期</Text>
              <Text className={styles.pickerValue}>{weekdayLabel(draft.weekday)}</Text>
            </View>
          </Picker>
          <Picker
            mode="time"
            value={draft.startClock}
            onChange={(event) => setDraft({ ...draft, startClock: String(event.detail.value) })}
          >
            <View className={styles.picker}>
              <Text className={styles.pickerLabel}>开始</Text>
              <Text className={styles.pickerValue}>{draft.startClock}</Text>
            </View>
          </Picker>
          <Picker
            mode="time"
            value={draft.endClock}
            onChange={(event) => setDraft({ ...draft, endClock: String(event.detail.value) })}
          >
            <View className={styles.picker}>
              <Text className={styles.pickerLabel}>结束</Text>
              <Text className={styles.pickerValue}>{draft.endClock}</Text>
            </View>
          </Picker>
        </View>
        <View className={styles.fieldRow}>
          <Input
            className={styles.inputHalf}
            placeholder="周次，如 1-16（可空）"
            value={draft.weeks}
            onInput={(event) => setDraft({ ...draft, weeks: String(event.detail.value) })}
          />
          <Input
            className={styles.inputHalf}
            placeholder="地点（可空）"
            value={draft.location}
            onInput={(event) => setDraft({ ...draft, location: String(event.detail.value) })}
          />
        </View>
        <Button className={styles.ghostButton} onClick={addDraft}>
          添加到课表
        </Button>
      </View>

      <View className={styles.card}>
        <View className={styles.listHeader}>
          <Text className={styles.cardTitle}>课表（{entries.length} 节）</Text>
          {dirty && <Text className={styles.dirtyBadge}>有未保存修改</Text>}
        </View>

        {entries.length === 0 && (
          <Text className={styles.emptyText}>还没有课程。导入或手动添加后，生成的计划会自动避开上课时段。</Text>
        )}

        {sorted.map((entry) => (
          <View key={entry.id} className={styles.entry}>
            <View className={styles.entryMain} onClick={() => setEditingId(editingId === entry.id ? '' : entry.id)}>
              <View className={styles.entryLeft}>
                <Text className={styles.entryWeekday}>{weekdayLabel(entry.weekday)}</Text>
                <View className={styles.entryInfo}>
                  <Text className={styles.entryName}>{entry.name}</Text>
                  <Text className={styles.entryTime}>
                    {minuteToClock(entry.startMinute)} - {minuteToClock(entry.endMinute)}
                    {entry.weeks ? ` · ${entry.weeks} 周` : ''}
                    {entry.location ? ` · ${entry.location}` : ''}
                  </Text>
                </View>
              </View>
              <Text className={styles.entryToggle}>{editingId === entry.id ? '收起' : '校正'}</Text>
            </View>

            {editingId === entry.id && (
              <View className={styles.entryEditor}>
                <Input
                  className={styles.input}
                  value={entry.name}
                  onInput={(event) =>
                    updateEntry(entry.id, {
                      name: String(event.detail.value),
                      subject: String(event.detail.value)
                    })
                  }
                />
                <View className={styles.fieldRow}>
                  <Picker
                    mode="selector"
                    range={WEEKDAY_OPTIONS}
                    value={entry.weekday - 1}
                    onChange={(event) =>
                      updateEntry(entry.id, { weekday: Number(event.detail.value) + 1 })
                    }
                  >
                    <View className={styles.picker}>
                      <Text className={styles.pickerLabel}>星期</Text>
                      <Text className={styles.pickerValue}>{weekdayLabel(entry.weekday)}</Text>
                    </View>
                  </Picker>
                  <Picker
                    mode="time"
                    value={minuteToClock(entry.startMinute)}
                    onChange={(event) =>
                      updateEntry(entry.id, { startMinute: clockToMinute(String(event.detail.value)) })
                    }
                  >
                    <View className={styles.picker}>
                      <Text className={styles.pickerLabel}>开始</Text>
                      <Text className={styles.pickerValue}>{minuteToClock(entry.startMinute)}</Text>
                    </View>
                  </Picker>
                  <Picker
                    mode="time"
                    value={minuteToClock(entry.endMinute)}
                    onChange={(event) =>
                      updateEntry(entry.id, { endMinute: clockToMinute(String(event.detail.value)) })
                    }
                  >
                    <View className={styles.picker}>
                      <Text className={styles.pickerLabel}>结束</Text>
                      <Text className={styles.pickerValue}>{minuteToClock(entry.endMinute)}</Text>
                    </View>
                  </Picker>
                </View>
                <Button
                  className={styles.dangerGhostButton}
                  onClick={() => removeEntry(entry.id)}
                >
                  删除这一节
                </Button>
              </View>
            )}
          </View>
        ))}

        <Button
          className={classnames(styles.primaryButton, !dirty && styles.buttonMuted)}
          disabled={!dirty}
          onClick={saveAll}
        >
          {dirty ? '保存课表' : '课表已是最新'}
        </Button>
      </View>

      <Text className={styles.footNote}>
        保存后，计划生成会把这些时段视为不可用，并按当天空闲时长压缩任务量。
      </Text>

      <View className={styles.bottomSpacer} />
    </View>
  )
}
