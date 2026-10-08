/**
 * 小程序侧的 pdf.js 运行环境补齐（纯壳侧代码，不进 packages/core）。
 *
 * 微信小程序没有 DOM、没有 Worker，也没有 TextDecoder / structuredClone，
 * 而 pdf.js 的 legacy 构建在「主线程 fake worker」模式下会用到三样东西：
 *
 *   - Promise.withResolvers（ES2024，PDFWorker 的类字段初始化时就调用）
 *   - structuredClone（LoopbackPort 在主线程的两个 MessageHandler 之间传消息）
 *   - TextDecoder / TextEncoder（解析 PDF 字符串与文档元数据）
 *
 * 这里只在缺失时补上，绝不覆盖宿主已有实现；全部实现都是幂等的。
 */

type WithResolvers = <T>() => {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

/** Promise.withResolvers：ES2024 提案，小程序引擎不一定有。 */
function installPromiseWithResolvers(): void {
  const target = Promise as unknown as { withResolvers?: WithResolvers }
  if (typeof target.withResolvers === 'function') {
    return
  }
  target.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

/**
 * structuredClone 的最小实现。
 *
 * pdf.js 传的 transfer 列表只是性能优化（把 ArrayBuffer 的所有权移过去），
 * 这里一律深拷贝、忽略 transfer —— 语义等价（数据都在），代价是多一次复制。
 */
function deepClone(value: unknown, seen: Map<unknown, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return seen.get(value)
  }

  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0)
    seen.set(value, copy)
    return copy
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView & { length?: number }
    const buffer = view.buffer.slice(0) as ArrayBuffer
    const ctor = view.constructor as new (
      buffer: ArrayBuffer,
      byteOffset: number,
      length: number,
    ) => ArrayBufferView
    const copy = new ctor(buffer, view.byteOffset, view.length ?? view.byteLength)
    seen.set(value, copy)
    return copy
  }

  if (value instanceof Date) {
    return new Date(value.getTime())
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags)
  }
  if (value instanceof Error) {
    const copy = new Error(value.message)
    copy.name = value.name
    return copy
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value) {
      copy.push(deepClone(item, seen))
    }
    return copy
  }

  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>()
    seen.set(value, copy)
    value.forEach((mapValue, mapKey) => {
      copy.set(deepClone(mapKey, seen), deepClone(mapValue, seen))
    })
    return copy
  }

  if (value instanceof Set) {
    const copy = new Set<unknown>()
    seen.set(value, copy)
    value.forEach((item) => {
      copy.add(deepClone(item, seen))
    })
    return copy
  }

  const source = value as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  seen.set(value, copy)
  for (const key of Object.keys(source)) {
    copy[key] = deepClone(source[key], seen)
  }
  return copy
}

function installStructuredClone(): void {
  const target = globalThis as unknown as { structuredClone?: (value: unknown) => unknown }
  if (typeof target.structuredClone === 'function') {
    return
  }
  target.structuredClone = (value: unknown) => deepClone(value, new Map())
}

function toBytes(input?: ArrayBufferView | ArrayBuffer | null): Uint8Array {
  if (!input) {
    return new Uint8Array(0)
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input)
  }
  const view = input as ArrayBufferView
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

/** UTF-8 解码；fatal 为真时遇到非法字节直接抛错（与 WHATWG 行为一致）。 */
function decodeUtf8(bytes: Uint8Array, fatal: boolean): string {
  let out = ''
  let index = 0
  while (index < bytes.length) {
    const first = bytes[index] as number
    if (first < 0x80) {
      out += String.fromCharCode(first)
      index += 1
      continue
    }
    let needed = 0
    let code = 0
    if ((first & 0xe0) === 0xc0) {
      needed = 1
      code = first & 0x1f
    } else if ((first & 0xf0) === 0xe0) {
      needed = 2
      code = first & 0x0f
    } else if ((first & 0xf8) === 0xf0) {
      needed = 3
      code = first & 0x07
    } else {
      if (fatal) {
        throw new TypeError('The encoded data was not valid UTF-8.')
      }
      out += '\ufffd'
      index += 1
      continue
    }
    if (index + needed >= bytes.length) {
      if (fatal) {
        throw new TypeError('The encoded data was not valid UTF-8.')
      }
      out += '\ufffd'
      break
    }
    let valid = true
    for (let offset = 1; offset <= needed; offset += 1) {
      const next = bytes[index + offset] as number
      if ((next & 0xc0) !== 0x80) {
        valid = false
        break
      }
      code = (code << 6) | (next & 0x3f)
    }
    if (!valid) {
      if (fatal) {
        throw new TypeError('The encoded data was not valid UTF-8.')
      }
      out += '\ufffd'
      index += 1
      continue
    }
    out += String.fromCodePoint(code)
    index += needed + 1
  }
  return out
}

function decodeUtf16(bytes: Uint8Array, bigEndian: boolean): string {
  let start = 0
  if (bytes.length >= 2) {
    const bom = ((bytes[0] as number) << 8) | (bytes[1] as number)
    if (bom === 0xfeff || bom === 0xfffe) {
      start = 2
    }
  }
  let out = ''
  for (let index = start; index + 1 < bytes.length; index += 2) {
    const high = bytes[index] as number
    const low = bytes[index + 1] as number
    out += String.fromCharCode(bigEndian ? (high << 8) | low : (low << 8) | high)
  }
  return out
}

/** 单字节编码按码位直通（latin1 / windows-1252 / pdfdoc 的绝大多数码位一致）。 */
function decodeSingleByte(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index] as number)
  }
  return out
}

const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8'])

class MiniTextDecoder {
  private readonly label: string
  private readonly fatal: boolean

  constructor(label = 'utf-8', options: { fatal?: boolean } = {}) {
    this.label = String(label).toLowerCase().replace(/[_\s]/g, '-')
    this.fatal = Boolean(options.fatal)
  }

  decode(input?: ArrayBufferView | ArrayBuffer | null): string {
    const bytes = toBytes(input)
    if (UTF8_LABELS.has(this.label)) {
      return decodeUtf8(bytes, this.fatal)
    }
    if (this.label === 'utf-16be') {
      return decodeUtf16(bytes, true)
    }
    if (this.label === 'utf-16le') {
      return decodeUtf16(bytes, false)
    }
    if (this.label === 'utf-16') {
      // 带 BOM 时由 decodeUtf16 自行识别，默认按小端
      return decodeUtf16(bytes, false)
    }
    return decodeSingleByte(bytes)
  }
}

class MiniTextEncoder {
  encode(input = ''): Uint8Array {
    const text = String(input)
    const bytes: number[] = []
    for (let index = 0; index < text.length; index += 1) {
      let code = text.codePointAt(index) as number
      if (code > 0xffff) {
        index += 1
      }
      if (code < 0x80) {
        bytes.push(code)
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        )
      }
    }
    return new Uint8Array(bytes)
  }
}

function installTextCodecs(): void {
  const target = globalThis as unknown as {
    TextDecoder?: unknown
    TextEncoder?: unknown
  }
  if (typeof target.TextDecoder !== 'function') {
    target.TextDecoder = MiniTextDecoder
  }
  if (typeof target.TextEncoder !== 'function') {
    target.TextEncoder = MiniTextEncoder
  }
}

let installed = false

/** 幂等：pdf.js 加载前调用一次即可。 */
export function installPdfCompat(): void {
  if (installed) {
    return
  }
  installed = true
  installPromiseWithResolvers()
  installStructuredClone()
  installTextCodecs()
}
