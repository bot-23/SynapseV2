/**
 * KV 适配器：core 的 KvStore 接口 → 浏览器 localStorage。
 * 约 30 行，零依赖；换平台就是换这个实现，core 一行不用动。
 */

import type { KvStore } from '@synapse/core'

export class BrowserKvStore implements KvStore {
  get(key: string): unknown {
    try {
      const value = window.localStorage.getItem(key)
      if (value === null) {
        return undefined
      }
      return JSON.parse(value) as unknown
    } catch (error) {
      console.error('[KvStore] get 失败', key, error)
      return undefined
    }
  }

  set(key: string, value: unknown): void {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      console.error('[KvStore] set 失败（可能超出配额）', key, error)
    }
  }

  delete(key: string): void {
    try {
      window.localStorage.removeItem(key)
    } catch (error) {
      console.error('[KvStore] delete 失败', key, error)
    }
  }
}