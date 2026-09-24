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
      <div className="profile-layout">
        <aside className="profile-intro">
          <div className="profile-stars" aria-hidden="true" />
          <div className="profile-brand">
            <span className="profile-logo">
              <img src="/icon.jpg" alt="" width="52" height="52" />
            </span>
            <span>Synapse</span>
          </div>
          <div className="profile-intro-copy">
            <p className="profile-eyebrow">你的智能学习助手</p>
            <p className="profile-headline">把目标，变成每天走得出的路。</p>
            <p>从规划到复习，让每一步都有方向，也看得见进步。</p>
          </div>
          <div className="profile-intro-foot">
            <span>01 / 规划</span>
            <span>02 / 执行</span>
            <span>03 / 复习</span>
          </div>
        </aside>

        <main className="profile-form-wrap">
          <p className="profile-step">初次见面 · 只需一步</p>
          <h1>先认识一下你</h1>
          <p className="profile-description">
            告诉我你的称呼和年级，一起开启适合你的学习节奏。
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
                placeholder="sk-…（也可以稍后再填）"
              />
            </label>
            <p className="profile-key-hint">不填写也能使用本地规则规划，之后可在设置中添加。</p>

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
        </main>
      </div>
    </div>
  )
}
