import { useState } from 'react'
import { View, Text, Input, Textarea, Button, Picker } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import { getCore, getActiveUserId } from '../../services/synapse'
import { taroIdGen } from '../../adapters/system'
import { syncTimetableToPhoneCalendar } from '../../adapters/phoneCalendar'
import type { TimetableEntry } from '../../vendor/core'
import {
  WEEKDAY_OPTIONS,
  clockToMinute,
  minuteToClock,
  weekdayLabel
} from '../../utils/format'
import styles from './index.module.scss'

const PASTE_EXAMPLE = `周一 高等数学 第1-2节
周二 大学物理 10:00-11:40 A101 张三老师
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
  const [syncing, setSyncing] = useState(false)
  const [icsText, setIcsText] = useState('')
  const [icsWarnings, setIcsWarnings] = useState<string[]>([])
  const [importingIcs, setImportingIcs] = useState(false)

  const load = () => {
    const result = getCore().getTimetable(getActiveUserId())
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

  /** E：解析 ICS 文本，确认后把条目并进课表（保存后才生效）。 */
  const applyIcsText = async (text: string) => {
    if (!text.trim()) {
      Taro.showToast({ title: '先选择或粘贴 ICS 内容', icon: 'none' })
      return
    }
    const result = getCore().parseTimetableIcs(text)
    const data = (result.data ?? {}) as Record<string, unknown>
    const parsed = (data['entries'] ?? []) as TimetableEntry[]
    const warns = (data['warnings'] ?? []) as string[]
    console.log('[Synapse] ICS 解析', parsed.length, warns.length)
    setIcsWarnings(warns)
    if (!result.success || !parsed.length) {
      Taro.showToast({ title: result.message || '没能识别出课程', icon: 'none' })
      return
    }
    const confirmed = await Taro.showModal({
      title: '导入 ICS 课表',
      content: `从日历里识别出 ${parsed.length} 节课，确认后会直接保存进课表。`,
      confirmText: '导入并保存'
    })
    if (!confirmed.confirm) {
      return
    }
    const saveResult = getCore().saveTimetable(getActiveUserId(), [...entries, ...parsed])
    console.log('[Synapse] ICS 导入并保存', saveResult.success, saveResult.message)
    Taro.showToast({ title: saveResult.message, icon: 'none', duration: 3000 })
    if (saveResult.success) {
      const saved = (saveResult.data ?? {}) as Record<string, unknown>
      setEntries((saved['entries'] ?? []) as TimetableEntry[])
      setDirty(false)
      setIcsText('')
    }
  }

  /** E：选一个 .ics 文件，读出文本后交给解析。 */
  const pickIcsFile = async () => {
    if (importingIcs) {
      return
    }
    try {
      const picked = await (Taro as any).chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['ics']
      })
      const files = (picked.tempFiles ?? []) as Array<{ path: string; name: string }>
      if (!files.length) {
        return
      }
      setImportingIcs(true)
      const file = files[0]!
      const fs = Taro.getFileSystemManager()
      const text = fs.readFileSync(file.path, 'utf-8') as unknown as string
      await applyIcsText(String(text ?? ''))
    } catch (error) {
      console.error('[Synapse] 读取 ICS 文件失败', error)
      Taro.showToast({ title: '读取 ICS 文件失败', icon: 'none' })
    } finally {
      setImportingIcs(false)
    }
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
    const result = getCore().saveTimetable(getActiveUserId(), entries)
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

  /** 把课表写进系统日历：每节课一条「每周重复」事件，由微信逐条弹确认。 */
  const syncCalendar = async () => {
    if (syncing || dirty) {
      if (dirty) {
        Taro.showToast({ title: '先保存课表再同步', icon: 'none' })
      }
      return
    }
    const confirmed = await Taro.showModal({
      title: '同步到系统日历',
      content: `会把 ${entries.length} 节课写成每周重复的日历事件。微信会对每条事件各弹一次确认，请逐条允许。`,
      confirmText: '开始同步'
    })
    if (!confirmed.confirm) {
      return
    }
    setSyncing(true)
    try {
      const result = await syncTimetableToPhoneCalendar(entries)
      console.log('[Synapse] 同步课表到日历', result.added, result.failed)
      Taro.showToast({
        title: result.failed
          ? `写入 ${result.added} 条，${result.failed} 条未成功`
          : `已写入 ${result.added} 条日历事件`,
        icon: 'none',
        duration: 2500
      })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <View className={styles.page}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>从教务系统粘贴课表</Text>
        <Text className={styles.cardDesc}>
          支持「周一 课程名 第1-2节」或「周一 课程名 08:00-09:40」这类逐行文本，也支持先粘贴星期表头再粘贴课程行。节次会按默认作息表换算成时间；教室与「张三老师」这样的教师名会自动分列。解析后可以逐条校正。
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
        <Text className={styles.cardTitle}>导入 ICS 日历（.ics）</Text>
        <Text className={styles.cardDesc}>
          教务系统或手机日历导出的 .ics 文件可以直接导入：选文件或把文件内容粘贴进来，解析出「每周重复」的课程后确认加入。识别结果同样可以逐条校正。
        </Text>
        <Button
          className={classnames(styles.ghostButton, importingIcs && styles.buttonMuted)}
          disabled={importingIcs}
          onClick={pickIcsFile}
        >
          {importingIcs ? '正在读取…' : '选择 .ics 文件'}
        </Button>
        <Textarea
          className={styles.textarea}
          placeholder="或把 .ics 文件内容粘贴到这里"
          value={icsText}
          maxlength={-1}
          onInput={(event) => setIcsText(String(event.detail.value))}
        />
        <Button className={styles.primaryButton} onClick={() => applyIcsText(icsText)}>
          解析粘贴的 ICS
        </Button>
        {icsWarnings.map((warning, index) => (
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

        {entries.length > 0 && (
          <Button
            className={styles.ghostButton}
            disabled={syncing}
            onClick={syncCalendar}
          >
            {syncing ? '正在写入日历…' : '同步到系统日历'}
          </Button>
        )}
      </View>

      <Text className={styles.footNote}>
        保存后，计划生成会把这些时段视为不可用，并按当天空闲时长压缩任务量。
      </Text>

      <View className={styles.bottomSpacer} />
    </View>
  )
}
