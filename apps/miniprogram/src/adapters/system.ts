/**
 * 系统适配：时钟与 UUID（小程序无 crypto.randomUUID，用 Math.random 版 v4）。
 */

import type { Clock, IdGen } from '../vendor/core'

export const taroClock: Clock = {
  nowIso: () => new Date().toISOString()
}

export const taroIdGen: IdGen = {
  next: () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
}
