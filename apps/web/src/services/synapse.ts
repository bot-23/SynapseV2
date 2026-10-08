/**
 * SynapseCore 单例与壳侧便捷封装。
 * 进程内直调 @synapse/core，无 HTTP 服务器，完全离线可用（模型调用除外）。
 */

import { CachedKvStore, createSynapseCore, type SynapseCore } from '@synapse/core'
import type {
  ClarificationAnswer,
  CopilotStreamEvent,
  FrontendAttachment,
  StudyPilotRunRequest,
  StudyPilotRunResponse,
  StudyPlanRequest,
} from '@synapse/core'
import { createWebKvStore } from '../adapters/kvStore'
import { createHttpTransport } from '../adapters/httpTransport'
import { pdfExtractor } from '../adapters/pdfExtractor'
import { browserClock, browserIdGen } from '../adapters/system'

let core: SynapseCore | null = null
let kv: CachedKvStore | null = null
let booting: Promise<void> | null = null

/**
 * 初始化 core。必须在使用 getCore() 之前 await 完成：
 * 存储是异步后端（IndexedDB），内存镜像要先装满数据，否则首屏会读到空。
 */
export function initCore(): Promise<void> {
  if (!booting) {
    booting = bootCore()
  }
  return booting
}

async function bootCore(): Promise<void> {
  let store: CachedKvStore
  try {
    store = await createWebKvStore()
    kv = store
  } catch (error) {
    // 存储整条链路都不可用时也要能开起来：退化为「纯内存」，本次会话可用、刷新即丢
    console.error('[Synapse] 存储初始化失败，退化为纯内存模式', error)
    store = await CachedKvStore.create({
      load: async () => ({}),
      save: async () => undefined,
      remove: async () => undefined,
    })
    kv = store
  }

  core = createSynapseCore({
    kv: store,
    http: createHttpTransport(),
    // 资料库的 PDF 由壳注入 pdf.js 提取，core 只声明 FileExtractor 端口
    fileExtractor: pdfExtractor,
    clock: browserClock,
    idGen: browserIdGen,
    // 没配 Key 时直接走规则引擎出计划，而不是回一句固定话术
    config: { offlinePlanFallback: true },
  })
  console.log('[Synapse] core 已初始化（Web 端，IndexedDB 缓存存储）')
}

/** 当前 core；未初始化时抛错（正常流程由 App 在渲染前 await initCore()）。 */
export function getCore(): SynapseCore {
  if (!core) {
    throw new Error('core 尚未初始化：请先 await initCore()')
  }
  return core
}

/** 立即把内存里的改动写回后端（导出/清空等关键操作后调用）。 */
export function flushKv(): Promise<void> {
  return kv ? kv.flush() : Promise.resolve()
}

export const DEFAULT_USER_ID = 'default'

/** localStorage 中记录当前激活档案的键。 */
const ACTIVE_USER_KEY = 'synapse.activeUser'

/**
 * 当前档案 id：多用户是「纯本地多数据桶」，切换只改这个键，
 * 刷新后所有业务调用都会落到对应的数据桶上。
 */
export function getActiveUserId(): string {
  return window.localStorage.getItem(ACTIVE_USER_KEY) || DEFAULT_USER_ID
}

export function setActiveUserId(id: string): void {
  window.localStorage.setItem(ACTIVE_USER_KEY, id)
}

/** 当前运行模式（deepseek = 已配置 Key；mock = 本地规则模式）。 */
export function currentRuntimeMode(): { provider: string; model: string; isFallback: boolean } {
  const status = getCore().settingsStatus()
  const configured = Boolean(
    (status.data as Record<string, unknown> | null)?.['deepseek_configured'],
  )
  return {
    provider: configured ? 'deepseek' : 'mock',
    model: configured ? 'DeepSeek' : '本地规则模式',
    isFallback: !configured,
  }
}

export function buildRunPayload(
  text: string,
  conversationId: string,
  planningMode: 'free' | 'blocks',
  files: FrontendAttachment[] = [],
): StudyPilotRunRequest {
  const profile = getCore().getProfile(getActiveUserId()).data as Record<string, unknown> | null
  const displayName = String(profile?.['display_name'] ?? '').trim()
  const grade = String(profile?.['grade'] ?? '').trim()
  const userProfile =
    displayName || grade
      ? { name: displayName || '同学', grade: grade === '未填写' ? '' : grade }
      : null

  return {
    input: text,
    message: '',
    // 聊天附件：由壳先用 core 的 extractFiles 抽好文本，再随本轮请求带进去
    files,
    userProfile,
    user_profile: null,
    planningMode,
    mode: 'free',
    memories: [],
    conversationId,
  }
}

export interface SavePlanResult {
  saved: boolean
  version: number
  message: string
}

/**
 * 流式入口：core 的 `runStream` 先产出若干条 stage（进度标签），
 * 最后一条 done 携带与 `run` 完全一致的完整结果。
 * 壳侧消费它就能把「正在整理你的需求…」这类等待反馈显示出来，
 * 不用再干等一个 60 秒的静默请求。
 */
export function streamRun(payload: StudyPilotRunRequest): AsyncIterable<CopilotStreamEvent> {
  return getCore().runStream(payload)
}

/** 计划自动生效：任何产出计划的响应都立即保存为「当前计划」，界面无需手动再点保存。 */
export function autoSavePlan(
  response: StudyPilotRunResponse,
  changeSummary: string,
): SavePlanResult {
  if (!response.plan && !response.blockPlan) {
    return { saved: false, version: 0, message: '' }
  }

  const result = getCore().savePlan(
    getActiveUserId(),
    {
      message: response.message,
      plan: response.plan ? { weekly_plan: response.plan.weekly_plan } : {},
      blockPlan: response.blockPlan ?? null,
    },
    changeSummary,
  )
  const data = (result.data ?? {}) as Record<string, unknown>
  const version = Number(data['version'] ?? 0)
  console.log('[Synapse] autoSavePlan', result.success, version, changeSummary)
  return {
    saved: Boolean(result.success),
    version,
    message: result.success ? `计划已更新（第 ${version} 版）` : result.message,
  }
}

export function changeSummaryOf(response: StudyPilotRunResponse): string {
  if (response.mode === 'plan-tweaked') {
    return '按你的反馈调整了计划'
  }
  if (response.mode === 'subjects-appended') {
    return '在现有计划上追加了新科目（原有条目与打卡保留）'
  }
  if (response.mode === 'append-subjects-full') {
    return '新科目已记住，但这周时间已排满，计划未改动'
  }
  if (response.mode === 'blocks-expanded-week') {
    return '按积木计划展开为一周安排'
  }
  if (response.mode === 'blocks-co-create') {
    return '按积木模式生成 Day 1'
  }
  return '初次生成计划'
}

export function confirmClarification(
  sessionId: string,
  answers: ClarificationAnswer[],
  conversationId: string,
): Promise<StudyPilotRunResponse> {
  return getCore().confirm({ sessionId, answers, conversationId })
}

export function expandBlocks(
  normalized: StudyPlanRequest,
  blockPlan: Parameters<SynapseCore['expandBlocks']>[1],
  conversationId: string,
): Promise<StudyPilotRunResponse> {
  return getCore().expandBlocks(normalized, blockPlan, conversationId)
}