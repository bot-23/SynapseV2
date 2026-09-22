import { useState } from 'react'
import { View, Text, Button, Input } from '@tarojs/components'
import classnames from 'classnames'
import type { ClarificationAnswer, ClarificationPrompt } from '../../vendor/core'
import styles from './index.module.scss'

interface ClarificationCardProps {
  clarification: ClarificationPrompt
  submitting?: boolean
  onSubmit: (answers: ClarificationAnswer[]) => void
}

/** 澄清卡片：先补关键约束（可点选项或自定义输入），再正式生成计划 */
export default function ClarificationCard({ clarification, submitting, onSubmit }: ClarificationCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const setAnswer = (questionId: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }))
  }

  const allAnswered = clarification.questions.every((q) => (answers[q.id] ?? '').trim().length > 0)

  const submit = () => {
    const payload = clarification.questions.map((q) => ({
      questionId: q.id,
      answer: (answers[q.id] ?? '').trim()
    }))
    console.log('[Synapse] 提交澄清答案', payload)
    onSubmit(payload)
  }

  return (
    <View className={styles.clarifyCard}>
      <Text className={styles.clarifyTitle}>{clarification.title}</Text>
      <Text className={styles.clarifyDesc}>{clarification.description}</Text>

      {clarification.questions.map((question) => (
        <View key={question.id} className={styles.question}>
          <Text className={styles.questionLabel}>{question.label}</Text>
          {!!question.description && (
            <Text className={styles.questionDesc}>{question.description}</Text>
          )}
          <View className={styles.chips}>
            {question.suggestedAnswers.map((option) => {
              const active = answers[question.id] === option
              return (
                <View
                  key={option}
                  className={classnames(styles.chip, active && styles.chipActive)}
                  onClick={() => setAnswer(question.id, option)}
                >
                  <Text className={classnames(styles.chipText, active && styles.chipTextActive)}>
                    {option}
                  </Text>
                </View>
              )
            })}
          </View>
          <Input
            className={styles.questionInput}
            placeholder={question.placeholder || '也可以自己输入'}
            value={answers[question.id] ?? ''}
            onInput={(event) => setAnswer(question.id, String(event.detail.value))}
          />
        </View>
      ))}

      <Button
        className={classnames(styles.submitButton, !allAnswered && styles.submitButtonDisabled)}
        disabled={!allAnswered || submitting}
        onClick={submit}
      >
        {submitting ? '生成中…' : '确认，生成计划'}
      </Button>
    </View>
  )
}
