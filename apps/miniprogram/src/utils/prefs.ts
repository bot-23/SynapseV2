/**
 * 本地偏好（壳层私有，不进入 core）：引导完成标记、最近使用的会话。
 */

import Taro from '@tarojs/taro'

const KEY_ONBOARDED = 'synapse:onboarded'
const KEY_LAST_CONVERSATION = 'synapse:lastConversationId'
const KEY_CLOUD_ENV = 'synapse:cloudEnvId'

export function isOnboarded(): boolean {
  try {
    return Taro.getStorageSync(KEY_ONBOARDED) === '1'
  } catch (error) {
    console.error('[Prefs] 读取引导标记失败', error)
    return false
  }
}

export function markOnboarded(): void {
  try {
    Taro.setStorageSync(KEY_ONBOARDED, '1')
  } catch (error) {
    console.error('[Prefs] 写入引导标记失败', error)
  }
}

export function getLastConversationId(): string {
  try {
    return String(Taro.getStorageSync(KEY_LAST_CONVERSATION) || '')
  } catch (error) {
    console.error('[Prefs] 读取最近会话失败', error)
    return ''
  }
}

export function setLastConversationId(conversationId: string): void {
  try {
    Taro.setStorageSync(KEY_LAST_CONVERSATION, conversationId)
  } catch (error) {
    console.error('[Prefs] 写入最近会话失败', error)
  }
}

/** 云开发环境 ID（云开发 AI 自检用；留空表示不用云开发 AI）。 */
export function getCloudEnvId(): string {
  try {
    return String(Taro.getStorageSync(KEY_CLOUD_ENV) || '')
  } catch (error) {
    console.error('[Prefs] 读取云开发环境 ID 失败', error)
    return ''
  }
}

export function setCloudEnvId(envId: string): void {
  try {
    Taro.setStorageSync(KEY_CLOUD_ENV, envId)
  } catch (error) {
    console.error('[Prefs] 写入云开发环境 ID 失败', error)
  }
}
