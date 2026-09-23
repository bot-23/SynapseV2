import { useState } from 'react'
import type { ClarificationAnswer, ClarificationPrompt } from '@synapse/core'

interface ClarificationCardProps {
  clarification: ClarificationPrompt
  submitting?: boolean
  onSubmit: (answers: ClarificationAnswer[]) => void
}

/** 澄清卡片：先补关键约束（可点选项或自定义输入），再正式生成计划 */
export default function ClarificationCard({
  clarification,
  submitting,
  onSubmit,
}: ClarificationCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const setAnswer = (questionId: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }))
  }

  const allAnswered = clarification.questions.every((q) =>
    (answers[q.id] ?? '').trim().length > 0,
  )

  const submit = () => {
    const payload = clarification.questions.map((q) => ({
      questionId: q.id,
      answer: (answers[q.id] ?? '').trim(),
    }))
    console.log('[Synapse] 提交澄清答案', payload)
    onSubmit(payload)
  }

  return (
    <div className="clarification-card">
      <div className="clarification-title">{clarification.title}</div>
      <div className="clarification-desc">{clarification.description}</div>

      {clarification.questions.map((question) => (
        <div key={question.id} className="clarification-question">
          <div className="clarification-question-label">{question.label}</div>
          {!!question.description && (
            <div className="clarification-question-desc">{question.description}</div>
          )}
          <div className="clarification-chips">
            {question.suggestedAnswers.map((option) => {
              const active = answers[question.id] === option
              return (
                <button
                  key={option}
                  type="button"
                  className={`clarification-chip${active ? ' active' : ''}`}
                  onClick={() => setAnswer(question.id, option)}
                >
                  {option}
                </button>
              )
            })}
          </div>
          <input
            className="clarification-input"
            placeholder={question.placeholder || '也可以自己输入'}
            value={answers[question.id] ?? ''}
            onChange={(event) => setAnswer(question.id, event.target.value)}
          />
        </div>
      ))}

      <button
        type="button"
        className={`clarification-submit${!allAnswered ? ' disabled' : ''}`}
        disabled={!allAnswered || submitting}
        onClick={submit}
      >
        {submitting ? '生成中…' : '确认，生成计划'}
      </button>
    </div>
  )
}