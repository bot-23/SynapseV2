/**
 * KV 存储接口（壳注入适配器）+ 内存实现（测试/开发用）。
 *
 * 键空间分桶（对应 architecture.md §5）：
 *   profile                         用户画像/API Key/能力（单键）
 *   conversations                   会话清单（单键，读取时按 updated_at 倒序）
 *   messages:{conversationId}       每会话消息一桶
 *   clarifications:{sessionId}      待确认会话（一次性消费）
 *   plans:{userId}                  已保存计划（含版本号）
 *   progress:{userId}               进度（task_key → 记录）
 *   documents:{userId}              用户资料切分块
 *   timetable:{userId}              课程表条目（v2）
 *   assessments:{userId}            能力评估记录
 *   kg:nodes / kg:edges             知识图谱
 *
 * 接口为同步：localStorage/wx.storage/内存天然同步；Tauri fs 等异步后端
 * 由壳侧做预加载 + 回写缓存适配。实现可换，接口不变。
 */

export interface KvStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export class MemoryKvStore implements KvStore {
  private readonly data = new Map<string, unknown>();

  get(key: string): unknown {
    return this.data.get(key);
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  delete(key: string): void {
    this.data.delete(key);
  }
}

/**
 * 异步持久化后端（IndexedDB / SQLite / 文件系统都只能异步读写）。
 *
 * 为什么单独抽一层：core 与 RuntimeStore 全线只认同步的 `KvStore`，
 * 换成异步后端如果直接改接口，几十个调用点都要跟着变 async。这里用
 * `CachedKvStore` 在中间做一层内存镜像，把「异步后端的代价」关在一个类里，
 * 业务代码零感知。
 */
export interface KvBackend {
  /** 一次性读出全部键值（必须在渲染前 await 完成）。 */
  load(): Promise<Record<string, unknown>>;
  save(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface CachedKvStoreOptions {
  /**
   * 出现脏数据时的回调（由壳做防抖写回）。
   * core 不碰定时器，所以「什么时候 flush」由平台壳决定；
   * 不传就只能手动调用 `flush()`。
   */
  onDirty?: () => void;
}

/**
 * 内存镜像 + 异步落盘。
 *
 * 读永远走内存（同步、快）；写先落内存并记脏，再由壳触发 `flush()` 批量写回后端。
 * 这样既保住了 core 的同步接口，又让 Web/桌面把存储上限从 localStorage 的
 * 约 5MB 抬到 IndexedDB / SQLite 的数百 MB 甚至更高。
 */
export class CachedKvStore implements KvStore {
  private readonly data = new Map<string, unknown>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private flushing: Promise<void> | null = null;

  private constructor(
    private readonly backend: KvBackend,
    private readonly options: CachedKvStoreOptions,
  ) {}

  /** 先把后端数据全量读进内存，再交给 core 使用。 */
  static async create(
    backend: KvBackend,
    options: CachedKvStoreOptions = {},
  ): Promise<CachedKvStore> {
    const store = new CachedKvStore(backend, options);
    const loaded = await backend.load();
    for (const [key, value] of Object.entries(loaded ?? {})) {
      store.data.set(key, value);
    }
    return store;
  }

  get(key: string): unknown {
    return this.data.get(key);
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
    this.removed.delete(key);
    this.dirty.add(key);
    this.options.onDirty?.();
  }

  delete(key: string): void {
    this.data.delete(key);
    this.dirty.delete(key);
    this.removed.add(key);
    this.options.onDirty?.();
  }

  /** 是否还有没写回后端的改动。 */
  get pending(): boolean {
    return this.dirty.size > 0 || this.removed.size > 0;
  }

  /** 把内存里的改动刷回后端；并发调用会合并成同一次写。 */
  async flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }
    this.flushing = this._flush();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async _flush(): Promise<void> {
    // 写入期间可能又产生新的脏数据，所以循环到全部落盘为止
    while (this.dirty.size || this.removed.size) {
      const keys = [...this.dirty];
      const gone = [...this.removed];
      this.dirty.clear();
      this.removed.clear();
      for (const key of keys) {
        await this.backend.save(key, this.data.get(key));
      }
      for (const key of gone) {
        await this.backend.remove(key);
      }
    }
  }
}
