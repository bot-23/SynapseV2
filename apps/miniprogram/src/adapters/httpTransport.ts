/**
 * HTTP 适配器：core 的 HttpTransport → Taro.request（小程序端包 wx.request）。
 * 用户设备直连模型商，无中间服务器。
 *
 * 失败时把平台错误翻译成用户能看懂的原因，尤其是微信的「域名白名单」拦截 ——
 * 该拦截只在非调试模式生效，必须让用户明确知道要去小程序后台配置服务器域名。
 */

import Taro from '@tarojs/taro'
import type { HttpRequest, HttpResponse, HttpTransport } from '../vendor/core'

const DOMAIN_HINT =
  '请求被小程序平台拦截：当前域名不在「服务器域名」白名单里。' +
  '请到小程序后台 → 开发管理 → 开发设置 → 服务器域名，把 api.deepseek.com 加入 request 合法域名' +
  '（域名需满足平台的 HTTPS 与备案要求）。调试模式下平台会跳过这项校验，所以只有关闭调试才会暴露。'

const TLS_HINT = 'HTTPS 证书校验失败，请确认域名证书有效且完整。'
const TIMEOUT_HINT = '请求超时，请检查网络后重试。'
const CORS_HINT =
  '浏览器跨域限制：当前是 H5 预览环境，浏览器不允许网页直连模型商接口；用手机预览小程序可绕过该限制。'

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

  if (
    lower.includes('not in domain list') ||
    lower.includes('不在以下 request 合法域名') ||
    lower.includes('url not in domain')
  ) {
    return DOMAIN_HINT
  }
  if (lower.includes('err_cert') || lower.includes('certificate')) {
    return TLS_HINT
  }
  if (lower.includes('timeout')) {
    return TIMEOUT_HINT
  }
  if (lower.includes('cors') || lower.includes('failed to fetch') || lower.includes('network error')) {
    return CORS_HINT
  }
  return message ? `请求失败：${message}` : '请求失败，请稍后重试。'
}

export class TaroHttpTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    console.log('[Http] ->', req.method, req.url)
    try {
      const res = await Taro.request({
        url: req.url,
        method: (req.method || 'GET') as never,
        data: req.body as never,
        header: req.headers,
        timeout: 60000
      })
      return { status: res.statusCode, body: res.data }
    } catch (error) {
      const friendly = describeRequestError(error)
      console.error('[Http] 请求失败', req.url, friendly, error)
      throw new Error(friendly)
    }
  }
}
