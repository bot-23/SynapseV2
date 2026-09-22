import { useEffect, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import classnames from 'classnames'
import {
  DEFAULT_CLOUD_ENV,
  cloudAiStatus,
  cloudGenerateText,
  cloudStreamText,
  resolveTarget,
  type CloudAiStatus,
  type CloudTarget
} from '../../adapters/cloudAi'
import { getCloudEnvId, setCloudEnvId } from '../../utils/prefs'
import styles from './index.module.scss'

/**
 * 云开发 AI（wx.cloud.extend.AI）连通性自检。
 *
 * 存在的意义：判断「工具调用能不能透传」—— 我们的工作流（意图分类）强依赖
 * 模型返回 tool_calls，而官方 recipe 明说复杂编排建议走 Agent 模式，
 * 所以只能实测。每个探测只改一个变量，失败时能直接看出是哪一层不支持。
 */

type ProbeStatus = 'pending' | 'running' | 'ok' | 'fail'

interface ProbeResult {
  key: string
  label: string
  hint: string
  status: ProbeStatus
  ms: number
  verdict: string
  raw: string
}

interface ProbeOutcome {
  verdict: string
  raw: string
}

const PROBE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'register_goal',
      description: '登记学习目标',
      parameters: {
        type: 'object',
        properties: { goal: { type: 'string', description: '学习目标' } },
        required: ['goal']
      }
    }
  }
]

/**
 * 把响应解析成摘要。**平台错误直接抛**，交给 runAll 标成失败 ——
 * 否则「额度耗尽」会被误读成「参数被接受了」。
 */
function describeResponse(res: unknown): {
  contentLength: number
  toolCallCount: number
  toolNames: string
  hasReasoning: boolean
  finishReason: string
} {
  const platformFailure = platformError(res)
  if (platformFailure) {
    throw new Error(
      `云开发返回错误：${platformFailure.code || '未给出 code'}` +
        `${platformFailure.message ? ` — ${platformFailure.message}` : ''}` +
        `${platformFailure.requestId ? `（requestId ${platformFailure.requestId}）` : ''}`
    )
  }

  const payload = res as {
    choices?: Array<{ message?: Record<string, any>; finish_reason?: string }>
  } | null
  const choice = payload?.choices?.[0]
  const message = choice?.message ?? {}
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  return {
    contentLength: String(message.content ?? '').length,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls
      .map((call: any) => call?.function?.name)
      .filter(Boolean)
      .join('、'),
    hasReasoning: Boolean(message.reasoning_content),
    finishReason: String(choice?.finish_reason ?? '未知')
  }
}

/**
 * 云开发把模型层的错误也用 HTTP 200 返回，body 是 `{code, message, requestId}`，
 * 没有 `choices`。不识别它就会把「额度耗尽」这类错误误读成「参数被接受了」。
 */
function platformError(res: unknown): { code: string; message: string; requestId: string } | null {
  const payload = res as Record<string, unknown> | null
  if (!payload || typeof payload !== 'object') {
    return null
  }
  if (payload['choices']) {
    return null
  }
  if (!payload['code'] && !payload['message']) {
    return null
  }
  return {
    code: String(payload['code'] ?? ''),
    message: String(payload['message'] ?? ''),
    requestId: String(payload['requestId'] ?? '')
  }
}

function truncate(value: unknown, max = 900): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch (error) {
    text = String(value)
  }
  const safe = text ?? ''
  return safe.length > max ? `${safe.slice(0, max)}…（已截断）` : safe
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const detail = error as { errMsg?: unknown; message?: unknown }
    const message = detail.errMsg ?? detail.message
    if (message) {
      return String(message)
    }
  }
  return String(error)
}

const PROBES: Array<{ key: string; label: string; hint: string; run: (env: string) => Promise<ProbeOutcome> }> = [
  {
    key: 'basic',
    label: '1. 基础连通',
    hint: '只发一条最短消息，确认环境、模型名、鉴权都对。',
    run: async (env) => {
      const res = await cloudGenerateText(env, {
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        max_tokens: 64
      })
      const info = describeResponse(res)
      return {
        verdict:
          info.contentLength > 0
            ? `拿到正文 ${info.contentLength} 字${info.hasReasoning ? '；响应带 reasoning_content，说明默认开着思考' : ''}`
            : `没有正文（finish_reason=${info.finishReason}）`,
        raw: truncate(res)
      }
    }
  },
  {
    key: 'thinking',
    label: '2. 关思考 + temperature 能否透传',
    hint: '我们直连时要靠 thinking:disabled 才能强指定工具，且 temperature 才生效。',
    run: async (env) => {
      const res = await cloudGenerateText(env, {
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        thinking: { type: 'disabled' },
        temperature: 0.3,
        max_tokens: 64
      })
      const info = describeResponse(res)
      return {
        verdict: info.hasReasoning
          ? '请求被接受，但仍有 reasoning_content —— thinking 参数可能没生效'
          : '请求被接受且没有 reasoning_content —— 关思考的参数能透传',
        raw: truncate(res)
      }
    }
  },
  {
    key: 'tools',
    label: '3. 工具调用（关键）',
    hint: '传 tools + 强制 tool_choice，看能否拿到 tool_calls。这一条决定能不能迁移。',
    run: async (env) => {
      const res = await cloudGenerateText(env, {
        messages: [{ role: 'user', content: '把「学习高等数学」这个目标登记一下，请调用工具。' }],
        tools: PROBE_TOOLS,
        tool_choice: { type: 'function', function: { name: 'register_goal' } },
        thinking: { type: 'disabled' },
        max_tokens: 256
      })
      const info = describeResponse(res)
      if (info.toolCallCount > 0) {
        return {
          verdict: `拿到 ${info.toolCallCount} 个 tool_call（${info.toolNames}）—— 强制指定工具也能透传，core 的意图分类可照搬`,
          raw: truncate(res)
        }
      }
      return {
        verdict: `没有 tool_calls（finish_reason=${info.finishReason}，正文 ${info.contentLength} 字）—— 这条路不通，工作流需要改造`,
        raw: truncate(res)
      }
    }
  },
  {
    key: 'json',
    label: '4. JSON mode',
    hint: '计划生成依赖 response_format: json_object。',
    run: async (env) => {
      const res = await cloudGenerateText(env, {
        messages: [
          {
            role: 'user',
            content: '请只返回JSON对象，不要包含markdown代码块。给出 {subject, days} 两个字段。'
          }
        ],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        max_tokens: 256
      })
      const info = describeResponse(res)
      return {
        verdict:
          info.contentLength > 0
            ? '请求被接受并返回正文（正文是不是合法 JSON 见下方原始响应）'
            : '没有正文，response_format 可能不被支持',
        raw: truncate(res)
      }
    }
  },
  {
    key: 'stream',
    label: '5. 流式输出',
    hint: '看 textStream 能否逐段产出（流式打字机效果靠它）。',
    run: async (env) => {
      const out = await cloudStreamText(
        env,
        {
          messages: [{ role: 'user', content: '数到五，数字之间用空格隔开。' }],
          thinking: { type: 'disabled' },
          max_tokens: 64
        },
        12
      )
      return {
        verdict: `收到 ${out.chunks.length} 段增量文本；生效的调用形状是 ${out.shape}。内容：${out.joined.slice(0, 40)}`,
        raw: truncate(out.chunks)
      }
    }
  }
]

function emptyResults(): ProbeResult[] {
  return PROBES.map((probe) => ({
    key: probe.key,
    label: probe.label,
    hint: probe.hint,
    status: 'pending' as ProbeStatus,
    ms: 0,
    verdict: '',
    raw: ''
  }))
}

export default function CloudCheckPage() {
  const [envId, setEnvId] = useState(getCloudEnvId() || DEFAULT_CLOUD_ENV)
  const [status, setStatus] = useState<CloudAiStatus>(() => cloudAiStatus())
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<ProbeResult[]>(emptyResults)
  const [currentKey, setCurrentKey] = useState('')
  const [target, setTarget] = useState<CloudTarget | null>(null)
  const [targetAttempts, setTargetAttempts] = useState<
    Array<{ label: string; ok: boolean; detail: string }>
  >([])

  // 挂载时用当前环境 ID 探一次，顺便完成 wx.cloud.init。
  // 放在 effect 里而不是渲染期：init 是副作用，且渲染期抛错会打崩整页。
  useEffect(() => {
    setStatus(cloudAiStatus(getCloudEnvId() || DEFAULT_CLOUD_ENV))
  }, [])

  const update = (key: string, patch: Partial<ProbeResult>) => {
    setResults((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  const runAll = async () => {
    const env = envId.trim()
    if (!env) {
      Taro.showToast({ title: '请先填写云开发环境 ID', icon: 'none' })
      return
    }
    setCloudEnvId(env)
    setStatus(cloudAiStatus(env))
    setRunning(true)
    setResults(emptyResults())
    setTarget(null)
    setTargetAttempts([])
    console.log('[CloudAI] 开始自检', env)

    // 第 0 步：先找出这个环境真正能用的 provider / 模型组合。
    // 免费额度是按 provider 发的（成长计划给的是混元 hy3），不先探就会一路 429，
    // 而且会把「没额度」误读成「不支持工具调用」。
    let resolved: CloudTarget | null = null
    try {
      const resolution = await resolveTarget(env)
      setTargetAttempts(resolution.attempts)
      setTarget(resolution.target)
      resolved = resolution.target
      console.log('[CloudAI] 可用组合', resolution.target)
    } catch (error) {
      console.error('[CloudAI] 组合探测失败', error)
      setTargetAttempts([{ label: '探测本身失败', ok: false, detail: errorText(error) }])
    }

    if (!resolved) {
      // 没有可用组合时后面的探测没有意义，直接说明原因，避免得出错误结论
      setResults((prev) =>
        prev.map((item) => ({
          ...item,
          status: 'fail' as ProbeStatus,
          verdict: '没有可用的 provider / 模型组合，先解决额度问题（见上方矩阵）'
        }))
      )
      setRunning(false)
      return
    }

    for (const probe of PROBES) {
      setCurrentKey(probe.key)
      update(probe.key, { status: 'running' })
      const started = Date.now()
      try {
        const outcome = await probe.run(env)
        console.log('[CloudAI] 探测完成', probe.key, outcome.verdict)
        update(probe.key, {
          status: 'ok',
          ms: Date.now() - started,
          verdict: outcome.verdict,
          raw: outcome.raw
        })
      } catch (error) {
        console.error('[CloudAI] 探测失败', probe.key, error)
        update(probe.key, {
          status: 'fail',
          ms: Date.now() - started,
          verdict: errorText(error),
          raw: ''
        })
      }
    }

    setCurrentKey('')
    setRunning(false)
  }

  const copyReport = () => {
    const lines = [
      `云开发 AI 自检报告`,
      `环境 ID：${envId.trim() || '（空）'}`,
      `运行时：${status.text}`,
      `可用组合：${target ? `${target.provider} / ${target.model}` : '未解析出可用组合'}`,
      ''
    ]
    targetAttempts.forEach((attempt) => {
      lines.push(`  [${attempt.ok ? '✓' : '✗'}] ${attempt.label} — ${attempt.detail}`)
    })
    lines.push('')
    results.forEach((item) => {
      lines.push(`${item.label} [${item.status}] ${item.ms}ms`)
      lines.push(`  结论：${item.verdict || '（未执行）'}`)
      if (item.raw) {
        lines.push(`  原始：${item.raw}`)
      }
      lines.push('')
    })
    Taro.setClipboardData({ data: lines.join('\n') })
      .then(() => Taro.showToast({ title: '报告已复制', icon: 'none' }))
      .catch(() => Taro.showToast({ title: '复制失败', icon: 'none' }))
  }

  return (
    <View className={styles.page}>
      <View className={styles.card}>
        <Text className={styles.cardTitle}>云开发 AI 自检</Text>
        <Text className={styles.cardDesc}>
          用微信云开发（wx.cloud.extend.AI）代发模型请求，就不用配服务器域名白名单，用户也不必自己填
          Key。这里先验证它的能力边界，尤其是工具调用。
        </Text>
        <View className={styles.statusRow}>
          <Text className={status.available ? styles.statusOk : styles.statusWarn}>
            {status.text}
          </Text>
        </View>
        <Text className={styles.fieldLabel}>云开发环境 ID</Text>
        <Input
          className={styles.input}
          placeholder="例如：cloud1-1gxxxxxx"
          value={envId}
          onInput={(event) => setEnvId(String(event.detail.value))}
        />
        <Button
          className={classnames(styles.primaryButton, running && styles.buttonDisabled)}
          disabled={running}
          onClick={runAll}
        >
          {running ? `正在自检…（${currentKey || ''}）` : '开始自检'}
        </Button>
        <Button className={styles.secondaryButton} onClick={copyReport}>
          复制自检报告
        </Button>
      </View>

      <View className={styles.card}>
        <View className={styles.rowBetween}>
          <Text className={styles.cardTitle}>0. 可用 provider / 模型</Text>
          <Text className={styles.meta}>
            {target ? `${target.provider} / ${target.model}` : running ? '进行中…' : '未解析'}
          </Text>
        </View>
        <Text className={styles.cardDesc}>
          免费额度是按 provider 发的（成长计划给的是混元 hy3），所以先逐个试，找出这个环境真正能用的组合，再跑后面的探测。
        </Text>
        {targetAttempts.map((attempt) => (
          <View key={attempt.label} className={styles.attemptRow}>
            <Text className={attempt.ok ? styles.attemptOk : styles.attemptFail}>
              {attempt.ok ? '✓' : '✗'} {attempt.label}
            </Text>
            <Text className={styles.attemptDetail}>{attempt.detail}</Text>
          </View>
        ))}
      </View>

      {results.map((item) => (
        <View key={item.key} className={styles.card}>
          <View className={styles.rowBetween}>
            <Text className={styles.cardTitle}>{item.label}</Text>
            <Text className={styles.meta}>
              {item.status === 'running' ? '进行中…' : item.ms ? `${item.ms}ms` : ''}
            </Text>
          </View>
          <Text className={styles.cardDesc}>{item.hint}</Text>
          {!!item.verdict && (
            <Text
              className={
                item.status === 'fail'
                  ? styles.verdictFail
                  : item.status === 'ok'
                    ? styles.verdictOk
                    : styles.verdict
              }
            >
              {item.verdict}
            </Text>
          )}
          {!!item.raw && (
            <View className={styles.rawBox}>
              <Text className={styles.rawText} userSelect>
                {item.raw}
              </Text>
            </View>
          )}
        </View>
      ))}

      <View className={styles.bottomSpacer} />
    </View>
  )
}
