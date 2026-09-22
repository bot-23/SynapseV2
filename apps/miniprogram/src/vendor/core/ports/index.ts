/**
 * 壳注入端口：core 通过这些接口访问平台能力，自身不引用 Node/DOM/wx/Tauri API。
 */

/** HTTP 传输（壳注入：WebView/Node 用 fetch，小程序包 wx.request）。 */
export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** JSON 请求体（由传输层序列化）。 */
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  /** 已按 JSON 解析的响应体（非 JSON 响应给字符串）。 */
  body: unknown;
}

export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** 流式传输（SSE）：逐条 yield `data:` 之后的负载文本，"[DONE]" 结束。 */
export interface StreamTransport {
  stream(req: HttpRequest): AsyncIterable<string>;
}

/** PDF 等二进制文件的文本提取（壳注入 pdf.js）；txt 解码在 core 内完成。 */
export interface FileExtractor {
  extract(fileName: string, data: Uint8Array): Promise<string>;
}

/** 时钟（测试可注入固定值；默认真实时间）。 */
export interface Clock {
  nowIso(): string;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
};

/** 随机 ID（测试可注入序列；默认 crypto.randomUUID）。 */
export interface IdGen {
  next(): string;
}

export const systemIdGen: IdGen = {
  next: () => crypto.randomUUID(),
};
