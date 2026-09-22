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
