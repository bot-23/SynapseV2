/**
 * DeepSeek 直连 LLM Provider（重写自旧仓 LangChain 版 deepseek.py + httpx 直连版 deepseek_direct.py）。
 * DeepSeek 为 OpenAI 兼容协议：POST {base_url}/chat/completions，Bearer 认证。
 * 网络只经 ports/HttpTransport（壳注入），core 不直接引用 fetch/wx.request。
 */

import type { HttpRequest, HttpTransport, StreamTransport } from "../ports/index.js";
import type {
  GenerateWithToolsResult,
  LlmProvider,
  ToolCall,
} from "./contracts.js";

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

interface ChatMessage {
  content?: unknown;
  tool_calls?: Array<{
    function?: { name?: string; arguments?: string };
  }>;
}

interface ChatCompletion {
  choices?: Array<{ message?: ChatMessage; delta?: { content?: unknown } }>;
}

function messageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}

export class DeepSeekLlmProvider implements LlmProvider {
  private readonly modelName: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(
    private readonly options: DeepSeekOptions,
    private readonly http: HttpTransport,
    private readonly streamHttp?: StreamTransport,
  ) {
    this.modelName = options.model;
    this.temperature = options.temperature ?? 0.3;
    this.maxTokens = options.maxTokens ?? 1024;
  }

  private buildRequest(body: Record<string, unknown>): HttpRequest {
    return {
      method: "POST",
      url: `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body,
    };
  }

  private basePayload(): Record<string, unknown> {
    return {
      model: this.modelName,
      // 官方文档：思考开关默认 enabled。开启后强制 tool_choice 会 400
      // （Thinking mode does not support this tool_choice），且 temperature 会被静默忽略。
      // 本应用要的是确定性的结构化输出，所以显式关掉。
      thinking: { type: "disabled" },
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
  }

  private async chat(payload: Record<string, unknown>): Promise<ChatCompletion> {
    const response = await this.http.request(this.buildRequest(payload));
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`DeepSeek 请求失败：HTTP ${response.status}`);
    }
    return response.body as ChatCompletion;
  }

  async generateText(prompt: string): Promise<string> {
    const data = await this.chat({
      ...this.basePayload(),
      messages: [{ role: "user", content: prompt }],
    });
    return messageContent(data.choices?.[0]?.message?.content ?? "");
  }

  async generateWithTools(
    prompt: string,
    tools: unknown[],
    forceTool = "",
  ): Promise<GenerateWithToolsResult> {
    const toolChoice: unknown = forceTool
      ? { type: "function", function: { name: forceTool } }
      : "auto";
    const data = await this.chat({
      ...this.basePayload(),
      messages: [{ role: "user", content: prompt }],
      tools,
      tool_choice: toolChoice,
    });
    const message = data.choices?.[0]?.message ?? {};
    if (message.tool_calls && message.tool_calls.length) {
      const toolCalls: ToolCall[] = message.tool_calls.map((tc) => ({
        name: tc.function?.name ?? "",
        args: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
      }));
      return { tool_calls: toolCalls };
    }
    return { content: messageContent(message.content ?? "") };
  }

  async generateJson(prompt: string): Promise<Record<string, unknown>> {
    const jsonPrompt = `${prompt}\n请只返回JSON对象，不要包含markdown代码块。`;
    const data = await this.chat({
      ...this.basePayload(),
      messages: [{ role: "user", content: jsonPrompt }],
      response_format: { type: "json_object" },
    });
    let content = messageContent(data.choices?.[0]?.message?.content ?? "").trim();
    if (content.startsWith("```")) {
      const firstNewline = content.indexOf("\n");
      if (firstNewline >= 0) {
        content = content.slice(firstNewline + 1);
      }
      const fenceEnd = content.lastIndexOf("```");
      content = fenceEnd >= 0 ? content.slice(0, fenceEnd) : content;
    }
    return JSON.parse(content);
  }

  async *streamText(prompt: string): AsyncIterable<string> {
    if (!this.streamHttp) {
      throw new Error("未注入 StreamTransport，无法流式调用 DeepSeek。");
    }
    const request = this.buildRequest({
      ...this.basePayload(),
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });
    for await (const payload of this.streamHttp.stream(request)) {
      if (payload.trim() === "[DONE]") {
        return;
      }
      const data = JSON.parse(payload) as ChatCompletion;
      const delta = data.choices?.[0]?.delta?.content;
      const text = messageContent(delta ?? "");
      if (text) {
        yield text;
      }
    }
  }

  describe(): Record<string, unknown> {
    return {
      provider: "deepseek",
      model: this.modelName,
      status: "ready",
    };
  }
}
