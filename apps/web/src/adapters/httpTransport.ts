/**
 * HTTP 适配器：core 的 HttpTransport → 浏览器 fetch。
 * 浏览器直连模型商接口会受 CORS 限制 —— 把错误翻译成用户能看懂的原因。
 */

import type { HttpRequest, HttpResponse, HttpTransport } from '@synapse/core'

const CORS_HINT =
  '浏览器跨域限制：浏览器不允许网页直连模型商接口。' +
  '你可以在本地开发时通过 Vite 代理绕过，或后续用 Tauri 壳/自建网关转发。'

function rawMessage(error: unknown): string {
  if (!error) {
    return ''
  }
  if (typeof error === 'string') {
    return error
  }
  const message = (error as { errMsg?: unknown }).errMsg ?? (error as { message?: unknown }).message
  return typeof message === 'string' ? message : String(error)
}

export function describeRequestError(error: unknown): string {
  const message = rawMessage(error)
  const lower = message.toLowerCase()

  if (lower.includes('cors') || lower.includes('failed to fetch') || lower.includes('network error')) {
    return CORS_HINT
  }
  if (lower.includes('timeout')) {
    return '请求超时，请检查网络后重试。'
  }
  if (lower.includes('certificate')) {
    return 'HTTPS 证书校验失败，请确认域名证书有效。'
  }
  return message ? `请求失败：${message}` : '请求失败，请稍后重试。'
}

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
      console.error('[Http] 请求失败', req.url, friendly, error)
      throw new Error(friendly)
    }
  }
}