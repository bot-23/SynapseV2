/**
 * KV 适配器：core 的 KvStore 接口 → Taro 同步存储（wx.storage / H5 localStorage）。
 * 约 30 行，零原生代码；core 实现可换。
 */

import Taro from '@tarojs/taro'
import type { KvStore } from '../vendor/core'

export class TaroKvStore implements KvStore {
  get(key: string): unknown {
    try {
      const value = Taro.getStorageSync(key)
      // Taro 对不存在的 key 返回 ''
      return value === '' || value === undefined || value === null ? undefined : value
    } catch (error) {
      console.error('[KvStore] get 失败', key, error)
      return undefined
    }
  }

  set(key: string, value: unknown): void {
    try {
      Taro.setStorageSync(key, value)
    } catch (error) {
      console.error('[KvStore] set 失败（可能超出 10MB 上限）', key, error)
    }
  }

  delete(key: string): void {
    try {
      Taro.removeStorageSync(key)
    } catch (error) {
      console.error('[KvStore] delete 失败', key, error)
    }
  }
}
