/**
 * 微信云开发 AI+（`wx.cloud.extend.AI`）薄封装。
 *
 * 动机：由云开发平台代发模型请求，不走 `wx.request` 直连外部域名 ——
 * 顺带绕开「服务器域名白名单」，用户也不需要自己填模型 Key。
 *
 * 四个必须遵守的点（其中第 1 条是踩过的坑）：
 * 1. **没调用 `wx.cloud.init()` 之前访问 `wx.cloud.extend` 会直接抛错**，不是返回
 *    undefined。所以任何探测都必须先 init、并且整段包在 try/catch 里，
 *    否则在页面渲染阶段调用会把整个页面打崩。
 * 2. 这是基础库内置能力（需微信小程序端 + 基础库 ≥ 3.15.1），H5 等其它端没有 `wx`。
 * 3. 官方文档里 `generateText` 与 `streamText` 的参数形状不一致：前者直接收 payload，
 *    后者要把 payload 塞进 `data`。这不是笔误，照抄文档。
 * 4. 云开发环境要先把小程序 AppID 绑定到 CloudBase 环境，并在控制台开通「AI+」。
 *
 * 目前只做「探测」用途（见 pages/cloudcheck）。等确认工具调用能透传后，
 * 再在这里补一个 HttpTransport 实现，把 core 的请求转发给 generateText。
 */

/**
 * provider + 模型的候选组合。
 *
 * 为什么要列多个：免费额度的归属和 provider 强相关 ——
 * 「小程序成长计划」赠送的额度是给混元 `hy3` 的，而 `hunyuan-v3` provider
 * 只消耗免费额度、且不需要在控制台开模型开关；`cloudbase` provider 则优先吃
 * 免费额度、吃不到就转套餐额度（没买套餐就会 429 EXCEED_TOKEN_QUOTA_LIMIT）。
 * 所以我们不猜，逐个试，用第一个真正能返回 choices 的组合。
 */
export interface CloudTarget {
  provider: string
  model: string
}

export const CLOUD_TARGETS: CloudTarget[] = [
  { provider: 'hunyuan-v3', model: 'hy3' },
  { provider: 'cloudbase', model: 'hy3' },
  { provider: 'cloudbase', model: 'deepseek-v4-flash' },
]

/**
 * 默认云开发环境 ID。
 * 环境 ID 不是密钥（云开发本身就把它写在小程序代码里），所以直接内置当默认值，
 * 界面上仍然可以改。多环境时改这里或用界面输入覆盖。
 */
export const DEFAULT_CLOUD_ENV = 'cloud1-d1gc1b5fh26b67651'

export interface CloudAiStatus {
  available: boolean
  text: string
}

function nativeWx(): any {
  return (globalThis as any).wx ?? null
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

let initializedEnv = ''

/**
 * 探测云开发 AI 是否可用。传了 envId 就顺便完成 init。
 *
 * **契约：这个函数永远不抛错。** 因为它会在页面渲染阶段被调用，
 * 一旦抛错整页白屏（这就是最初自检页空白的根因）。
 */
export function cloudAiStatus(envId = ''): CloudAiStatus {
  const wxApi = nativeWx()
  if (!wxApi) {
    return {
      available: false,
      text: '当前不是微信小程序环境（H5/预览下没有 wx），云开发 AI 需要在微信端验证。',
    }
  }
  if (!wxApi.cloud) {
    return {
      available: false,
      text: 'wx.cloud 不存在：基础库过低，请把调试基础库升到 3.15.1 以上。',
    }
  }

  const env = (envId || '').trim()
  if (env && initializedEnv !== env) {
    try {
      wxApi.cloud.init({ env, traceUser: true })
      initializedEnv = env
      console.log('[CloudAI] wx.cloud 已初始化', env)
    } catch (error) {
      return { available: false, text: `wx.cloud.init 失败：${errorText(error)}` }
    }
  }

  try {
    const entry = wxApi.cloud.extend?.AI ?? null
    if (!entry) {
      return {
        available: false,
        text: 'wx.cloud 里没有 extend.AI：基础库过低（需 ≥ 3.15.1），或该端不支持云开发 AI。',
      }
    }
    return {
      available: true,
      text: `云开发 AI 可用（环境 ${initializedEnv || env || '未指定'}）。`,
    }
  } catch (error) {
    // 未 init 就访问 extend 会走到这里
    return {
      available: false,
      text:
        `访问 wx.cloud.extend 出错：${errorText(error)}。` +
        '请确认云开发环境 ID 正确、且该环境已开通「AI+」能力。',
    }
  }
}

/** 创建模型句柄；不可用时抛出可直接展示给用户的错误。 */
function createModel(envId: string, provider: string): any {
  const status = cloudAiStatus(envId)
  if (!status.available) {
    throw new Error(status.text)
  }
  return nativeWx().cloud.extend.AI.createModel(provider)
}

/**
 * 已解析出的可用组合。云开发入口本身也是单例，这里缓存解析结果是一回事。
 * 解析前用候选表第一项兜底，解析后所有调用都走它。
 */
let activeTarget: CloudTarget | null = null

function currentTarget(): CloudTarget {
  return activeTarget ?? CLOUD_TARGETS[0]!
}

/** 非流式生成；返回平台原始响应（OpenAI 形状，含 choices[0].message）。 */
export async function cloudGenerateText(
  envId: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const target = currentTarget()
  // 模型名以解析结果为准，覆盖调用方给的任何 model
  return createModel(envId, target.provider).generateText({ ...payload, model: target.model })
}

/**
 * 逐个试候选组合，返回第一个能返回正常响应（有 choices）的，并缓存下来。
 * 失败原因一并带回，报告里能看出每个组合各自被什么挡住了。
 */
export async function resolveTarget(envId: string): Promise<{
  target: CloudTarget | null
  attempts: Array<{ label: string; ok: boolean; detail: string }>
}> {
  const attempts: Array<{ label: string; ok: boolean; detail: string }> = []

  for (const candidate of CLOUD_TARGETS) {
    const label = `${candidate.provider} / ${candidate.model}`
    try {
      const res = await createModel(envId, candidate.provider).generateText({
        model: candidate.model,
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        max_tokens: 32,
      })
      const payload = res as Record<string, unknown> | null
      if (payload && payload['choices']) {
        attempts.push({ label, ok: true, detail: '可用' })
        activeTarget = candidate
        return { target: candidate, attempts }
      }
      const code = String(payload?.['code'] ?? '未给出 code')
      const message = String(payload?.['message'] ?? '')
      attempts.push({ label, ok: false, detail: `${code}${message ? ` — ${message}` : ''}` })
    } catch (error) {
      attempts.push({ label, ok: false, detail: errorText(error) })
    }
  }

  activeTarget = null
  return { target: null, attempts }
}

/**
 * 流式生成；收集到 maxChunks 段增量文本后主动停止。
 * 自检时用短提示词 + 小上限，避免把额度跑满。
 *
 * 官方文档对参数形状有两处不一致的写法：SDK 参考是 `streamText({ data: payload })`，
 * 而 recipe 示例直接传 payload。两种都试，并把生效的那种一并返回 —— 这个歧义本身
 * 就是自检要回答的问题之一。
 */
export async function cloudStreamText(
  envId: string,
  payload: Record<string, unknown>,
  maxChunks = 12,
): Promise<{ chunks: string[]; joined: string; shape: string }> {
  const target = currentTarget()
  const model = createModel(envId, target.provider)
  const withModel = { ...payload, model: target.model }
  const attempts: Array<{ shape: string; args: Record<string, unknown> }> = [
    { shape: 'streamText({ data: payload })', args: { data: withModel } },
    { shape: 'streamText(payload)', args: withModel },
  ]

  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      const res = await model.streamText(attempt.args)
      const chunks: string[] = []
      for await (const chunk of res.textStream) {
        chunks.push(String(chunk))
        if (chunks.length >= maxChunks) {
          break
        }
      }
      if (chunks.length) {
        return { chunks, joined: chunks.join(''), shape: attempt.shape }
      }
      lastError = new Error('textStream 没有产出任何内容')
    } catch (error) {
      lastError = error
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `两种调用形状都没拿到流式内容（最后错误：${reason}）。` +
      '若额度已耗尽，流式同样拿不到任何内容。',
  )
}
