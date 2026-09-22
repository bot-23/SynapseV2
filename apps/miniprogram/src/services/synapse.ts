/**
 * SynapseCore 单例与壳侧便捷封装。
 * core 为 vendored 源码（npm run sync:core 同步自 packages/core），进程内直调，无 HTTP 服务器。
 */

import { createSynapseCore, type SynapseCore } from '../vendor/core'
import type {
  ClarificationAnswer,
  StudyPilotRunRequest,
  StudyPilotRunResponse,
  StudyPlanRequest
} from '../vendor/core'
import { TaroKvStore } from '../adapters/kvStore'
import { TaroHttpTransport } from '../adapters/httpTransport'
import { taroClock, taroIdGen } from '../adapters/system'

let core: SynapseCore | null = null

export function getCore(): SynapseCore {
  if (!core) {
    core = createSynapseCore({
      kv: new TaroKvStore(),
      http: new TaroHttpTransport(),
      clock: taroClock,
      idGen: taroIdGen,
      // 没配 Key 时直接走规则引擎出计划，而不是回一句固定话术
      config: { offlinePlanFallback: true }
    })
    console.log('[Synapse] core 已初始化')
  }
  return core
}

export const DEFAULT_USER_ID = 'default'

/** 当前运行模式（deepseek = 已配置 Key；mock = 本地规则模式）。 */
export function currentRuntimeMode(): { provider: string; model: string; isFallback: boolean } {
  const status = getCore().settingsStatus()
  const configured = Boolean(
    (status.data as Record<string, unknown> | null)?.['deepseek_configured']
  )
  return {
    provider: configured ? 'deepseek' : 'mock',
    model: configured ? 'DeepSeek' : '本地规则模式',
    isFallback: !configured
  }
}

export function buildRunPayload(
  text: string,
  conversationId: string,
  planningMode: 'free' | 'blocks'
): StudyPilotRunRequest {
  const profile = getCore().getProfile(DEFAULT_USER_ID).data as Record<string, unknown> | null
  const displayName = String(profile?.['display_name'] ?? '').trim()
  const grade = String(profile?.['grade'] ?? '').trim()
  const userProfile =
    displayName || grade
      ? { name: displayName || '同学', grade: grade === '未填写' ? '' : grade }
      : null

  return {
    input: text,
    message: '',
    files: [],
    userProfile,
    user_profile: null,
    planningMode,
    mode: 'free',
    memories: [],
    conversationId
  }
}

export interface SavePlanResult {
  saved: boolean
  version: number
  message: string
}

/** 计划自动生效：任何产出计划的响应都立即保存为「当前计划」，界面无需手动再点保存。 */
export function autoSavePlan(
  response: StudyPilotRunResponse,
  changeSummary: string
): SavePlanResult {
  if (!response.plan && !response.blockPlan) {
    return { saved: false, version: 0, message: '' }
  }

  const result = getCore().savePlan(
    DEFAULT_USER_ID,
    {
      message: response.message,
      plan: response.plan ? { weekly_plan: response.plan.weekly_plan } : {},
      blockPlan: response.blockPlan ?? null
    },
    changeSummary
  )
  const data = (result.data ?? {}) as Record<string, unknown>
  const version = Number(data['version'] ?? 0)
  console.log('[Synapse] autoSavePlan', result.success, version, changeSummary)
  return {
    saved: Boolean(result.success),
    version,
    message: result.success ? `计划已更新（第 ${version} 版）` : result.message
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
  answers: ClarificationAnswer[]
): Promise<StudyPilotRunResponse> {
  return getCore().confirm({ sessionId, answers })
}

export function expandBlocks(
  normalized: StudyPlanRequest,
  blockPlan: Parameters<SynapseCore['expandBlocks']>[1]
): Promise<StudyPilotRunResponse> {
  return getCore().expandBlocks(normalized, blockPlan)
}
