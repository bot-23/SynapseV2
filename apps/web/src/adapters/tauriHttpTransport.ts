/**
 * 桌面端（Tauri）HTTP 传输：由 Rust 侧代发请求，绕开 WebView 的 CORS。
 *
 * 为什么需要：桌面 WebView 里直连模型商接口，请求仍然算跨域，会被 CORS 拦下。
 * Rust 侧发请求没有这个限制，所以桌面环境走这条路；浏览器环境继续用 fetch。
 */

import type { HttpRequest, HttpResponse, HttpTransport } from '@synapse/core'
import { tauriInvoke } from './tauri'
import { describeRequestError } from './httpErrors'

export class TauriHttpTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    console.log('[Http] ->', req.method, req.url)
    try {
      const result = await tauriInvoke<{ status: number; body: string }>('http_request', {
        method: (req.method || 'GET').toUpperCase(),
        url: req.url,
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers ?? {}),
        },
        body: req.body === undefined ? null : JSON.stringify(req.body),
      })
      const text = result.body ?? ''
      let body: unknown = text
      try {
        body = text ? (JSON.parse(text) as unknown) : ''
      } catch {
        body = text
      }
      return { status: result.status, body }
    } catch (error) {
      const friendly = describeRequestError(error)
      console.error('[Http] 请求失败', req.url, friendly)
      throw new Error(friendly)
    }
  }
}
