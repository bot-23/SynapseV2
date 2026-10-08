/**
 * Tauri 桌面壳的桥接：判断是否在桌面环境，以及调用 Rust 命令。
 *
 * 刻意不引 `@tauri-apps/api`：直接走 Tauri 注入的 `window.__TAURI_INTERNALS__`，
 * 这样 Web 端不必为了桌面端多背一个依赖（打包体积也干净）。
 */

interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

interface TauriWindow {
  __TAURI_INTERNALS__?: TauriInternals
}

function internals(): TauriInternals | null {
  if (typeof window === 'undefined') {
    return null
  }
  const candidate = (window as unknown as TauriWindow).__TAURI_INTERNALS__
  return candidate && typeof candidate.invoke === 'function' ? candidate : null
}

/** 当前是否运行在 Tauri 桌面壳里。 */
export function isTauri(): boolean {
  return internals() !== null
}

/** 调用一个 Rust 命令；不在桌面环境时直接抛错，避免静默失败。 */
export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = internals()
  if (!api) {
    return Promise.reject(new Error('不在 Tauri 运行环境中'))
  }
  return api.invoke<T>(cmd, args)
}
