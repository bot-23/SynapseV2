import { useState } from 'react'
import { getCore, DEFAULT_USER_ID } from '../services/synapse'

interface OnboardingProps {
  onComplete: () => void
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [name, setName] = useState('')
  const [grade, setGrade] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [validating, setValidating] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !grade.trim()) {
      setError('请先填写称呼和年级')
      return
    }
    setValidating(true)
    setError('')
    setMessage('')

    try {
      // 保存画像
      getCore().saveProfile(DEFAULT_USER_ID, name.trim(), grade.trim())

      // 若填了 Key 则校验并保存；不填则直接进入本地规则模式
      const key = apiKey.trim()
      if (key) {
        const result = await getCore().validateApiKey(key)
        if (result.success) {
          getCore().saveApiKey(key)
          setMessage(`已连接 DeepSeek，欢迎 ${name.trim()}！`)
        } else {
          setError(result.message || 'Key 校验失败')
          setValidating(false)
          return
        }
      } else {
        setMessage('未配置 Key，将使用本地规则模式生成计划。')
      }

      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : '初始化失败')
    } finally {
      setValidating(false)
    }
  }

  return (
    <div className="profile-gate">
      <div className="profile-form-wrap">
        <span className="profile-logo">S</span>
        <p className="profile-kicker">Synapse</p>
        <h1>欢迎来到 Synapse</h1>
        <p className="profile-description">
          告诉我如何称呼你，几秒钟后开始规划。未配置 Key 也能用本地规则生成计划。
        </p>

        <form onSubmit={handleSubmit}>
          <label>
            <span>你的称呼</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError('')
              }}
              placeholder="例如：小明"
              autoFocus
            />
          </label>

          <label>
            <span>年级</span>
            <input
              value={grade}
              onChange={(event) => {
                setGrade(event.target.value)
                setError('')
              }}
              placeholder="例如：高三"
            />
          </label>

          <label>
            <span>DeepSeek API Key（可选）</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value)
                setError('')
              }}
              placeholder="sk-…（留空则用本地规则模式）"
            />
          </label>

          <div className="form-error visible">{error}</div>
          {!!message && <div className="form-message">{message}</div>}

          <button type="submit" className="profile-submit" disabled={validating}>
            {validating ? '校验中…' : '开始规划'}
          </button>

          <button
            type="button"
            className="secondary-button onboarding-skip"
            onClick={() => {
              getCore().saveProfile(DEFAULT_USER_ID, name.trim() && grade.trim() ? name.trim() : '同学', grade.trim() || '未填写')
              onComplete()
            }}
          >
            跳过，先用本地规则模式
          </button>
        </form>
      </div>
    </div>
  )
}