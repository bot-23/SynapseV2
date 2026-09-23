/**
 * 系统适配：时钟与 UUID（浏览器 crypto.randomUUID）。
 */

import type { Clock, IdGen } from '@synapse/core'

export const browserClock: Clock = {
  nowIso: () => new Date().toISOString(),
}

export const browserIdGen: IdGen = {
  next: () => window.crypto?.randomUUID?.() ?? fallbackUuid(),
}

function fallbackUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}