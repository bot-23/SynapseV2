/**
 * KV 适配器：core 的同步 `KvStore` → 浏览器 IndexedDB（异步）。
 *
 * 为什么不再直接用 localStorage：
 * - localStorage 通常只有约 5MB，资料多一点、或者以后放向量就会顶到天花板；
 * - IndexedDB 上限通常是几百 MB 起，且是结构化存储。
 *
 * 但 IndexedDB 只能异步读写，而 core 全线用同步接口。这里用 core 的
 * `CachedKvStore` 在中间做内存镜像：读走内存（同步），写先落内存、再由本适配器
 * 防抖写回 IndexedDB。core 一行不用改。
 *
 * 降级：IndexedDB 不可用（隐私模式等）时回退 localStorage；
 * 老用户第一次升级时，会把 localStorage 里的 core 数据迁移到 IndexedDB 并清掉旧键。
 */

import { CachedKvStore, type KvBackend } from '@synapse/core'
import { TauriKvBackend } from './tauriKvBackend'
import { isTauri } from './tauri'

const DB_NAME = 'synapse'
const DB_VERSION = 1
const STORE_NAME = 'kv'

/** 壳层私有的 localStorage 前缀（引导标记、侧边栏宽度、会话卡片），不属于 core 数据。 */
const SHELL_KEY_PREFIX = 'synapse.'

function isCoreKey(key: string): boolean {
  return !key.startsWith(SHELL_KEY_PREFIX)
}

/** 读出 localStorage 里属于 core 的键（老数据 / 降级后端共用）。 */
function readLegacyLocalStorage(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const storage = window.localStorage
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key || !isCoreKey(key)) {
      continue
    }
    const raw = storage.getItem(key)
    if (raw === null) {
      continue
    }
    try {
      out[key] = JSON.parse(raw) as unknown
    } catch {
      // 损坏条目直接跳过，不让一条坏数据拦住整个启动
    }
  }
  return out
}

export class IndexedDbBackend implements KvBackend {
  private dbPromise: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'))
      })
    }
    return this.dbPromise
  }

  async load(): Promise<Record<string, unknown>> {
    const db = await this.open()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const out: Record<string, unknown> = {}
      const tx = db.transaction(STORE_NAME, 'readonly')
      const cursorRequest = tx.objectStore(STORE_NAME).openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) {
          resolve(out)
          return
        }
        out[String(cursor.key)] = cursor.value
        cursor.continue()
      }
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB 读取失败'))
    })
  }

  async save(key: string, value: unknown): Promise<void> {
    // IndexedDB 不接受 undefined 值，按删除处理
    if (value === undefined) {
      return this.remove(key)
    }
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 写入被中止'))
    })
  }

  async remove(key: string): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 删除失败'))
    })
  }
}

/** 降级后端：IndexedDB 不可用时保持老行为（受 localStorage 配额限制）。 */
export class LocalStorageBackend implements KvBackend {
  async load(): Promise<Record<string, unknown>> {
    return readLegacyLocalStorage()
  }

  async save(key: string, value: unknown): Promise<void> {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      console.error('[KvStore] 写 localStorage 失败（可能超出配额）', key, error)
    }
  }

  async remove(key: string): Promise<void> {
    window.localStorage.removeItem(key)
  }
}

async function pickBackend(): Promise<KvBackend> {
  // 桌面端（Tauri）优先：数据落成本机文件，可备份、可搬走
  if (isTauri()) {
    return new TauriKvBackend()
  }
  if (!window.indexedDB) {
    return new LocalStorageBackend()
  }
  const backend = new IndexedDbBackend()
  try {
    // 探活：能打开、能读一次才算可用
    await backend.load()
    return backend
  } catch (error) {
    console.warn('[KvStore] IndexedDB 不可用，回退 localStorage', error)
    return new LocalStorageBackend()
  }
}

/**
 * 把老版本留在 localStorage 里的 core 数据搬进 IndexedDB，再清掉旧键释放配额。
 * 只补 IndexedDB 里缺失的键，避免覆盖新数据；写回失败时保留 localStorage 原样。
 */
async function migrateLegacyLocalStorage(store: CachedKvStore): Promise<void> {
  const legacy = readLegacyLocalStorage()
  const keys = Object.keys(legacy)
  if (!keys.length) {
    return
  }
  let moved = 0
  for (const key of keys) {
    if (store.get(key) === undefined) {
      store.set(key, legacy[key])
      moved += 1
    }
  }
  if (!moved) {
    return
  }
  await store.flush()
  for (const key of keys) {
    window.localStorage.removeItem(key)
  }
  console.log('[KvStore] 已把', moved, '个键从 localStorage 迁移到 IndexedDB')
}

/**
 * 创建 Web 端 KV：IndexedDB（首选）或 localStorage（降级）+ 防抖写回。
 * 必须在渲染前 await 完成 —— 内存镜像要先装满数据，否则首屏会读到空。
 */
export async function createWebKvStore(): Promise<CachedKvStore> {
  const backend = await pickBackend()

  let store: CachedKvStore | null = null
  let scheduled = false
  const onDirty = () => {
    if (scheduled) {
      return
    }
    scheduled = true
    // 同一个同步批次里的多次写入（如批量载入演示数据）合并成一次 flush
    window.setTimeout(() => {
      scheduled = false
      void store?.flush().catch((error) => console.error('[KvStore] 写回失败', error))
    }, 0)
  }

  store = await CachedKvStore.create(backend, { onDirty })

  if (backend instanceof IndexedDbBackend) {
    try {
      await migrateLegacyLocalStorage(store)
    } catch (error) {
      console.warn('[KvStore] localStorage 迁移失败，原数据保留', error)
    }
  }

  // 切后台/关页面前尽量落盘（异步写不保证一定完成，但能覆盖绝大多数情况）
  window.addEventListener('pagehide', () => {
    void store?.flush().catch(() => undefined)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void store?.flush().catch(() => undefined)
    }
  })

  return store
}
