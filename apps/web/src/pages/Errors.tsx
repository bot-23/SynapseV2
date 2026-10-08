import { useEffect, useState } from 'react'
import { getCore, getActiveUserId } from '../services/synapse'
import { useFlash } from '../utils/useFlash'
import type { ErrorItem, QuizGrade, QuizQuestion } from '@synapse/core'
import PageIntro from '../components/PageIntro'

interface QuizResult {
  grade: QuizGrade
  wrong_items: ErrorItem[]
  error_total: number
}

/** 一次错题搜索的落地结果，带上关键词以防输入过程中的旧结果串台。 */
interface ErrorSearchState {
  query: string
  items: ErrorItem[]
  notice: string
}

const SOURCE_LABELS: Record<string, string> = {
  manual: '手动录入',
  quiz: '自测错题',
}

export default function ErrorsView() {
  const [items, setItems] = useState<ErrorItem[]>([])
  const [notice, flash] = useFlash()
  /** 全局搜索：关键词与最近一次落地结果。 */
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<ErrorSearchState | null>(null)
  const [searchTick, setSearchTick] = useState(0)

  // 手动添加表单
  const [subject, setSubject] = useState('')
  const [topic, setTopic] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')

  // 自测区
  const [quizSubject, setQuizSubject] = useState('')
  const [quizTopic, setQuizTopic] = useState('')
  const [quizCount, setQuizCount] = useState('5')
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [quizError, setQuizError] = useState('')
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null)
  const [answers, setAnswers] = useState<number[]>([])
  const [result, setResult] = useState<QuizResult | null>(null)

  const load = () => {
    const res = getCore().listErrorItems(getActiveUserId())
    setItems(((res.data as Record<string, unknown> | null)?.['items'] ?? []) as ErrorItem[])
  }

  /** 错题变动后刷新列表；若正在搜索，顺带重跑搜索，保证结果与数据一致。 */
  const reload = () => {
    load()
    if (query.trim()) {
      setSearchTick((tick) => tick + 1)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 输入后 200ms 再查，避免每敲一个字都跑一次检索
  useEffect(() => {
    const keyword = query.trim()
    if (!keyword) {
      setSearchState(null)
      return
    }
    const timer = window.setTimeout(() => {
      const res = getCore().searchAll(getActiveUserId(), keyword, 20)
      if (!res.success) {
        setSearchState({ query: keyword, items: [], notice: res.message })
        return
      }
      const data = (res.data ?? {}) as Record<string, unknown>
      setSearchState({
        query: keyword,
        items: (data['errors'] ?? []) as ErrorItem[],
        notice: '',
      })
    }, 200)
    return () => window.clearTimeout(timer)
  }, [query, searchTick])

  const addItem = () => {
    if (!question.trim()) {
      flash('请先填写题目')
      return
    }
    const res = getCore().addErrorItem(getActiveUserId(), {
      subject: subject.trim(),
      topic: topic.trim(),
      question: question.trim(),
      answer: answer.trim(),
    })
    console.log('[Synapse] 加入错题本', res.success, res.message)
    flash(res.message)
    if (res.success) {
      setSubject('')
      setTopic('')
      setQuestion('')
      setAnswer('')
      reload()
    }
  }

  const removeItem = (item: ErrorItem) => {
    const res = getCore().removeErrorItem(getActiveUserId(), item.id)
    console.log('[Synapse] 移出错题', item.id, res.success)
    flash(res.message)
    reload()
  }

  const generate = async () => {
    if (generating) {
      return
    }
    if (!quizSubject.trim() || !quizTopic.trim()) {
      setQuizError('请先填写学科与知识点')
      return
    }
    setGenerating(true)
    setQuizError('')
    setResult(null)
    setQuestions(null)
    try {
      const count = Math.max(1, Math.min(10, Number(quizCount) || 5))
      const res = await getCore().generateQuiz(getActiveUserId(), {
        subject: quizSubject.trim(),
        topic: quizTopic.trim(),
        count,
      })
      console.log('[Synapse] 生成自测题', res.success, res.message)
      setQuizError(res.message)
      if (res.success) {
        const list = ((res.data as Record<string, unknown> | null)?.['questions'] ?? []) as QuizQuestion[]
        setQuestions(list)
        setAnswers(list.map(() => -1))
        flash(`已出 ${list.length} 题`)
      }
    } catch (error) {
      console.error('[Synapse] 生成自测题异常', error)
      setQuizError(error instanceof Error ? error.message : String(error))
    } finally {
      setGenerating(false)
    }
  }

  const pickAnswer = (questionIndex: number, optionIndex: number) => {
    setAnswers((prev) => prev.map((value, index) => (index === questionIndex ? optionIndex : value)))
  }

  const submit = () => {
    if (!questions || !questions.length || submitting) {
      return
    }
    setSubmitting(true)
    try {
      const res = getCore().submitQuiz(getActiveUserId(), { questions, answers })
      console.log('[Synapse] 交卷判分', res.success, res.message)
      flash(res.message)
      if (res.success) {
        const data = (res.data ?? {}) as Record<string, unknown>
        setResult({
          grade: data['grade'] as QuizGrade,
          wrong_items: (data['wrong_items'] ?? []) as ErrorItem[],
          error_total: Number(data['error_total'] ?? 0),
        })
        reload()
      }
    } finally {
      setSubmitting(false)
    }
  }

  const answeredCount = answers.filter((value) => value >= 0).length

  const keyword = query.trim()
  const searching = keyword.length > 0
  // 结果关键词与当前输入一致才展示，输入过程中不闪「无结果」
  const ready = searchState !== null && searchState.query === keyword
  const visibleItems = searching ? (ready ? searchState.items : []) : items
  const showEmptySearch = searching && ready && !searchState.notice && visibleItems.length === 0

  return (
    <div className="docs-page">
      <div className="notice snackbar">{notice}</div>
      <PageIntro
        eyebrow="PRACTICE & REVIEW / 07"
        title="错题与自测"
        description="做错不可怕，怕的是错完就忘。把错题留下来，让自测帮你补上最后的缺口。"
      />

      <div className="mine-card">
        <div className="card-title">手动添加一道错题</div>
        <div className="card-desc">
          录入后会同步排进复习队列。同一科目下题目相同会被判重，不会重复入库。
        </div>
        <input
          className="mine-input"
          placeholder="学科，如 高等数学"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <input
          className="mine-input"
          placeholder="知识点，如 夹逼定理"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
        />
        <textarea
          className="mine-textarea"
          placeholder="题目（必填）"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
        />
        <textarea
          className="mine-textarea"
          placeholder="正确答案（可空）"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          rows={2}
        />
        <button type="button" className="primary-button" onClick={addItem}>
          加入错题本
        </button>
      </div>

      <div className="mine-card">
        <div className="card-title">自测（出题 → 判分 → 错题入本）</div>
        <div className="card-desc">
          出题走模型，判分完全在本机完成。没配置模型 Key 时无法出题，会明确提示而不会硬凑题目。
        </div>
        <div className="tt-field-row">
          <input
            className="mine-input"
            placeholder="学科，如 高等数学"
            value={quizSubject}
            onChange={(event) => setQuizSubject(event.target.value)}
          />
          <input
            className="mine-input"
            placeholder="知识点，如 导数"
            value={quizTopic}
            onChange={(event) => setQuizTopic(event.target.value)}
          />
          <input
            className="mine-input"
            type="number"
            min={1}
            max={10}
            placeholder="题数 1-10"
            value={quizCount}
            onChange={(event) => setQuizCount(event.target.value)}
          />
        </div>
        <button type="button" className="primary-button" disabled={generating} onClick={generate}>
          {generating ? '正在出题…' : '生成自测题'}
        </button>
        {!!quizError && <div className="feedback">{quizError}</div>}

        {questions && questions.length > 0 && (
          <div className="quiz-block">
            {questions.map((item, questionIndex) => (
              <div key={item.id || questionIndex} className="quiz-question">
                <div className="quiz-stem">
                  {questionIndex + 1}. {item.stem}
                  {!!item.topic && <span className="quiz-topic">{item.topic}</span>}
                </div>
                {item.options.map((option, optionIndex) => (
                  <label key={optionIndex} className="quiz-option">
                    <input
                      type="radio"
                      name={`quiz-${questionIndex}`}
                      checked={answers[questionIndex] === optionIndex}
                      onChange={() => pickAnswer(questionIndex, optionIndex)}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            ))}
            <button
              type="button"
              className="primary-button"
              disabled={submitting}
              onClick={submit}
            >
              {submitting ? '正在判分…' : `交卷（已作答 ${answeredCount}/${questions.length}）`}
            </button>
          </div>
        )}

        {result && (
          <div className="quiz-result">
            <div className="report-stats">
              <div className="report-stat">
                <span className="report-value">{result.grade.score}</span>
                <span className="report-label">得分</span>
              </div>
              <div className="report-stat">
                <span className="report-value">
                  {result.grade.correct}/{result.grade.total}
                </span>
                <span className="report-label">答对</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{result.wrong_items.length}</span>
                <span className="report-label">本次错题</span>
              </div>
              <div className="report-stat">
                <span className="report-value">{result.error_total}</span>
                <span className="report-label">错题本累计</span>
              </div>
            </div>
            {result.wrong_items.length > 0 && (
              <div className="quiz-wrong">
                <div className="review-section-title">本次错题已进错题本</div>
                {result.wrong_items.map((item) => (
                  <div key={item.id} className="error-row">
                    <div className="error-info">
                      <div className="error-topic">
                        {item.subject} · {item.topic}
                      </div>
                      <div className="error-question">{item.question}</div>
                      <div className="error-answer">
                        正确答案：{item.answer || '未提供'}
                        {item.user_answer ? ` · 你的答案：${item.user_answer}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mine-card">
        <div className="card-title">错题本（{items.length}）</div>
        <input
          className="search-input"
          placeholder="搜索错题（题目 / 答案 / 科目）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching && ready && searchState.notice && (
          <div className="search-status is-error">{searchState.notice}</div>
        )}
        {showEmptySearch && <div className="search-status">没有匹配结果</div>}
        {!searching && items.length === 0 && (
          <div className="feedback">错题本还是空的。去上面自测一次，或手动录入一道题。</div>
        )}
        {visibleItems.map((item) => (
          <div key={item.id} className="error-row">
            <div className="error-info">
              <div className="error-topic">
                {item.subject} · {item.topic}
                {!!SOURCE_LABELS[item.source] && (
                  <span className="error-source">{SOURCE_LABELS[item.source]}</span>
                )}
              </div>
              <div className="error-question">{item.question}</div>
              {!!item.answer && <div className="error-answer">正确答案：{item.answer}</div>}
              {!!item.user_answer && (
                <div className="error-answer error-user-answer">你的答案：{item.user_answer}</div>
              )}
            </div>
            <button type="button" className="subject-remove" onClick={() => removeItem(item)}>
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
