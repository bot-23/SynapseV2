/**
 * HTTP 适配器：core 的 HttpTransport → 浏览器 fetch（桌面端见 tauriHttpTransport）。
 * 浏览器直连模型商接口会受 CORS 限制 —— 把错误翻译成用户能看懂的原因。
 */

import type { HttpRequest, HttpResponse, HttpTransport } from '@synapse/core'
import { describeRequestError } from './httpErrors'
import { TauriHttpTransport } from './tauriHttpTransport'
import { isTauri } from './tauri'

export { describeRequestError } from './httpErrors'

export class BrowserHttpTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    console.log('[Http] ->', req.method, req.url)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60000)
      const response = await fetch(req.url, {
        method: req.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers ?? {}),
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const text = await response.text()
      let body: unknown = text
      try {
        body = text ? (JSON.parse(text) as unknown) : ''
      } catch {
        body = text
      }
      return { status: response.status, body }
    } catch (error) {
      const friendly = describeRequestError(error)
      // 不把原始 error 对象打出来：它可能带上含 Authorization 头的请求配置
      console.error('[Http] 请求失败', req.url, friendly)
      throw new Error(friendly)
    }
  }
}

/** 按运行环境挑传输：桌面端走 Rust 代理（无 CORS），浏览器走 fetch。 */
export function createHttpTransport(): HttpTransport {
  return isTauri() ? new TauriHttpTransport() : new BrowserHttpTransport()
}
