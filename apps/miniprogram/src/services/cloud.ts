import Taro from '@tarojs/taro'

const isWeapp = process.env.TARO_ENV === 'weapp'

/** 云函数名必须是合法标识符：不接受外部传入的任意字符串，避免越权调用。 */
const FUNCTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export async function callFunction<T = any>(
  name: string,
  data?: Record<string, any>
): Promise<T> {
  if (!FUNCTION_NAME_RE.test(name)) {
    throw new Error('非法的云函数名')
  }
  if (!isWeapp) {
    // 不再用 `import('../data/' + name)` 这种模板化动态导入：
    // 一旦 name 来自用户输入，就变成任意模块加载。非小程序端没有云函数可调。
    throw new Error(`当前环境不支持云函数调用：${name}`)
  }
  const res = await Taro.cloud.callFunction({ name, data })
  const result = res.result as { code: number; message: string; data: T }
  if (result.code !== 0) {
    console.error(`[Cloud] ${name} failed:`, result.message)
    throw new Error(result.message || '请求失败')
  }
  return result.data
}

export function getDatabase() {
  if (!isWeapp) {
    return null
  }
  return Taro.cloud.database()
}
