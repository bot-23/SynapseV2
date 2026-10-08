import { useEffect, useRef, useState } from 'react'
import { View, Text, Input, Textarea, Button } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import classnames from 'classnames'
import { getCore, getActiveUserId } from '../../services/synapse'
import type { ErrorItem, QuizGrade, QuizQuestion } from '../../vendor/core'
import styles from './index.module.scss'

export default function ErrorsPage() {
  const [items, setItems] = useState<ErrorItem[]>([])
  // 手动录入
  const [draftSubject, setDraftSubject] = useState('')
  const [draftTopic, setDraftTopic] = useState('')
  const [draftQuestion, setDraftQuestion] = useState('')
  const [draftAnswer, setDraftAnswer] = useState('')
  // 自测
  const [quizSubject, setQuizSubject] = useState('')
  const [quizTopic, setQuizTopic] = useState('')
  const [quizCount, setQuizCount] = useState('5')
  const [generating, setGenerating] = useState(false)
  const [questions, setQuestions] = useState<QuizQuestion[]>([])
  const [answers, setAnswers] = useState<number[]>([])
  const [grade, setGrade] = useState<QuizGrade | null>(null)
  const [wrongItems, setWrongItems] = useState<ErrorItem[]>([])
  // 全局搜索：searchQuery 为空时展示全部错题，非空时展示搜索结果
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchItems, setSearchItems] = useState<ErrorItem[]>([])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = () => {
    const result = getCore().listErrorItems(getActiveUserId())
    const data = (result.data ?? {}) as Record<string, unknown>
    setItems((data['items'] ?? []) as ErrorItem[])
  }

  // 页面卸载时清掉防抖定时器，避免在已卸载页面上发起搜索
  useEffect(
    () => () => {
      if (searchTimer.current !== null) {
        clearTimeout(searchTimer.current)
        searchTimer.current = null
      }
    },
    []
  )

  const runSearch = (query: string) => {
    const result = getCore().searchAll(getActiveUserId(), query, 20)
    console.log('[Synapse] 搜索错题', query, result.success)
    if (!result.success) {
      // 搜索失败必须显式提示，不能静默留白
      Taro.showToast({ title: result.message, icon: 'none' })
      return
    }
    const data = (result.data ?? {}) as Record<string, unknown>
    setSearchItems((data['errors'] ?? []) as ErrorItem[])
  }

  /** 300ms 防抖：清空则回到全部错题，否则按输入发起全局搜索。 */
  const onSearchInput = (value: string) => {
    setSearchInput(value)
    if (searchTimer.current !== null) {
      clearTimeout(searchTimer.current)
    }
    searchTimer.current = setTimeout(() => {
      const query = value.trim()
      if (!query) {
        setSearchQuery('')
        setSearchItems([])
        load()
        return
      }
      setSearchQuery(query)
      runSearch(query)
    }, 300)
  }

  /** 错题增删后同步刷新：搜索结果生效时一并重跑搜索。 */
  const refresh = () => {
    load()
    if (searchQuery) {
      runSearch(searchQuery)
    }
  }

  useDidShow(() => {
    load()
  })

  const removeItem = async (item: ErrorItem) => {
    const confirmed = await Taro.showModal({
      title: '移出错题本',
      content: '把这道题从错题本里删掉？（已排进的复习卡不受影响）',
      confirmText: '删除',
      confirmColor: '#dc2626'
    })
    if (!confirmed.confirm) {
      return
    }
    const result = getCore().removeErrorItem(getActiveUserId(), item.id)
    console.log('[Synapse] 移出错题', item.id, result.success)
    Taro.showToast({ title: result.message, icon: 'none' })
    refresh()
  }

  const addItem = () => {
    if (!draftQuestion.trim()) {
      Taro.showToast({ title: '请填写题目', icon: 'none' })
      return
    }
    const result = getCore().addErrorItem(getActiveUserId(), {
      subject: draftSubject.trim(),
      topic: draftTopic.trim(),
      question: draftQuestion.trim(),
      answer: draftAnswer.trim()
    })
    console.log('[Synapse] 添加错题', result.success, result.message)
    Taro.showToast({ title: result.message, icon: 'none' })
    if (result.success) {
      setDraftQuestion('')
      setDraftAnswer('')
      load()
    }
  }

  const generateQuiz = async () => {
    const subject = quizSubject.trim()
    const topic = quizTopic.trim()
    if (!subject || !topic) {
      Taro.showToast({ title: '请填写学科与知识点', icon: 'none' })
      return
    }
    if (generating) {
      return
    }
    setGenerating(true)
    try {
      const count = Math.max(1, Math.min(10, Math.trunc(Number(quizCount) || 5)))
      const result = await getCore().generateQuiz(getActiveUserId(), { subject, topic, count })
      if (!result.success) {
        // 没配模型 Key 时 success=false：必须把原因展示给用户，而不是静默失败
        await Taro.showModal({ title: '出题失败', content: result.message, showCancel: false })
        return
      }
      const data = (result.data ?? {}) as Record<string, unknown>
      const list = (data['questions'] ?? []) as QuizQuestion[]
      setQuestions(list)
      setAnswers(new Array(list.length).fill(-1))
      setGrade(null)
      setWrongItems([])
      Taro.showToast({ title: result.message, icon: 'none' })
    } finally {
      setGenerating(false)
    }
  }

  const selectOption = (questionIndex: number, optionIndex: number) => {
    setAnswers((prev) => {
      const next = prev.slice()
      next[questionIndex] = optionIndex
      return next
    })
  }

  const submitQuiz = () => {
    if (!questions.length) {
      return
    }
    // 未作答按 -1 交卷，判分完全离线
    const submitted = questions.map((_, index) => answers[index] ?? -1)
    const result = getCore().submitQuiz(getActiveUserId(), {
      questions,
      answers: submitted
    })
    console.log('[Synapse] 交卷判分', result.success, result.message)
    if (!result.success) {
      Taro.showToast({ title: result.message, icon: 'none' })
      return
    }
    const data = (result.data ?? {}) as Record<string, unknown>
    setGrade((data['grade'] ?? null) as QuizGrade | null)
    setWrongItems((data['wrong_items'] ?? []) as ErrorItem[])
    Taro.showToast({ title: result.message, icon: 'none', duration: 3000 })
    refresh()
  }

  // 搜索命中直接就是错题条目，无需再与全量列表合并
  const visibleItems: ErrorItem[] = searchQuery ? searchItems : items

  return (
    <View className={styles.page}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>AI 自测</Text>
        <Text className={styles.cardDesc}>
          指定学科与知识点，让 AI 出几道选择题，做完当场判分；做错的题会自动进错题本并排进复习队列。
        </Text>
        <View className={styles.fieldRow}>
          <Input
            className={styles.inputHalf}
            placeholder="学科，如 高等数学"
            value={quizSubject}
            onInput={(event) => setQuizSubject(String(event.detail.value))}
          />
          <Input
            className={styles.inputHalf}
            placeholder="知识点，如 导数"
            value={quizTopic}
            onInput={(event) => setQuizTopic(String(event.detail.value))}
          />
        </View>
        <View className={styles.fieldRow}>
          <Input
            className={styles.inputHalf}
            type="number"
            placeholder="题数（默认 5）"
            value={quizCount}
            onInput={(event) => setQuizCount(String(event.detail.value))}
          />
        </View>
        <Button
          className={classnames(styles.primaryButton, generating && styles.buttonDisabled)}
          disabled={generating}
          onClick={generateQuiz}
        >
          {generating ? '正在出题…' : '生成题目'}
        </Button>

        {questions.length > 0 && (
          <View className={styles.quizBox}>
            {questions.map((question, questionIndex) => (
              <View key={question.id || questionIndex} className={styles.quizQuestion}>
                <Text className={styles.quizStem}>
                  {questionIndex + 1}. {question.stem}
                </Text>
                {question.options.map((option, optionIndex) => {
                  const selected = (answers[questionIndex] ?? -1) === optionIndex
                  return (
                    <View
                      key={optionIndex}
                      className={classnames(
                        styles.quizOption,
                        selected && styles.quizOptionSelected
                      )}
                      onClick={() => selectOption(questionIndex, optionIndex)}
                    >
                      <Text
                        className={classnames(
                          styles.quizOptionText,
                          selected && styles.quizOptionTextSelected
                        )}
                      >
                        {String.fromCharCode(65 + optionIndex)}. {option}
                      </Text>
                    </View>
                  )
                })}
              </View>
            ))}
            <Button className={styles.primaryButton} onClick={submitQuiz}>
              交卷
            </Button>
          </View>
        )}

        {grade && (
          <View className={styles.gradeBox}>
            <Text className={styles.gradeScore}>得分 {grade.score}</Text>
            <Text className={styles.gradeDetail}>
              答对 {grade.correct}/{grade.total} 题
              {wrongItems.length > 0
                ? `，${wrongItems.length} 道错题已进错题本`
                : '，全部正确'}
            </Text>
            {wrongItems.map((item) => (
              <View key={item.id} className={styles.gradeWrong}>
                <Text className={styles.gradeWrongQ}>{item.question}</Text>
                <Text className={styles.gradeWrongA}>正确答案：{item.answer}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>手动录入错题</Text>
        <View className={styles.fieldRow}>
          <Input
            className={styles.inputHalf}
            placeholder="学科（可空）"
            value={draftSubject}
            onInput={(event) => setDraftSubject(String(event.detail.value))}
          />
          <Input
            className={styles.inputHalf}
            placeholder="知识点（可空）"
            value={draftTopic}
            onInput={(event) => setDraftTopic(String(event.detail.value))}
          />
        </View>
        <Textarea
          className={styles.textarea}
          placeholder="题目"
          value={draftQuestion}
          maxlength={-1}
          onInput={(event) => setDraftQuestion(String(event.detail.value))}
        />
        <Textarea
          className={styles.textarea}
          placeholder="答案 / 解析（可空）"
          value={draftAnswer}
          maxlength={-1}
          onInput={(event) => setDraftAnswer(String(event.detail.value))}
        />
        <Button className={styles.primaryButton} onClick={addItem}>
          加入错题本
        </Button>
      </View>

      <View className={styles.card}>
        <Text className={styles.cardTitle}>
          {searchQuery ? `搜索结果（${visibleItems.length} 道）` : `错题本（${items.length} 道）`}
        </Text>
        <Text className={styles.cardDesc}>
          做错或手动录入的题都沉淀在这里，按科目与题面判重。掌握后可以逐条删掉。
        </Text>
        <Input
          className={styles.searchInput}
          placeholder="搜索错题：题目 / 答案 / 科目"
          value={searchInput}
          onInput={(event) => onSearchInput(String(event.detail.value))}
        />
        {visibleItems.length === 0 && (
          <Text className={styles.emptyText}>
            {searchQuery ? '没有匹配结果' : '还没有错题。做一次自测，或手动录入一道试试。'}
          </Text>
        )}
        {visibleItems.map((item) => (
          <View key={item.id} className={styles.entry}>
            <View className={styles.entryHead}>
              <Text className={styles.entryTag}>{item.subject}</Text>
              {!!item.topic && <Text className={styles.entryTopic}>{item.topic}</Text>}
            </View>
            <Text className={styles.entryQuestion}>{item.question}</Text>
            {!!item.answer && <Text className={styles.entryAnswer}>答案：{item.answer}</Text>}
            <View
              className={styles.entryRemove}
              onClick={() => removeItem(item)}
            >
              <Text className={styles.entryRemoveText}>删除</Text>
            </View>
          </View>
        ))}
      </View>

      <View className={styles.bottomSpacer} />
    </View>
  )
}
