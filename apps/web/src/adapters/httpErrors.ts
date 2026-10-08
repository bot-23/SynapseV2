/**
 * 网络错误 → 用户能读懂的原因（浏览器与桌面端共用）。
 */

const CORS_HINT =
  '浏览器跨域限制：网页不允许直连模型商接口。' +
  '本地开发可用 Vite 代理绕过；桌面端（Tauri）已改为由 Rust 侧代发请求，不受此限制。'

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
