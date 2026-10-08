/**
 * 桌面端（Tauri）KV 后端：把数据落到本机文件，而不是浏览器的 IndexedDB。
 *
 * 为什么单独一个后端：桌面场景下数据应该是一份可以备份/搬走的文件，
 * 而不是藏在 WebView 的 IndexedDB 里。Rust 侧把整个 KV 存成一个 JSON 文件，
 * 这里只负责通过 IPC 读写 —— core 依然只认同步 KvStore，完全不感知平台。
 */

import type { KvBackend } from '@synapse/core'
import { tauriInvoke } from './tauri'

export class TauriKvBackend implements KvBackend {
  async load(): Promise<Record<string, unknown>> {
    const raw = await tauriInvoke<string>('kv_load')
    if (!raw) {
      return {}
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  async save(key: string, value: unknown): Promise<void> {
    await tauriInvoke('kv_set', { key, value: JSON.stringify(value) })
  }

  async remove(key: string): Promise<void> {
    await tauriInvoke('kv_remove', { key })
  }
}
