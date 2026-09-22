/**
 * DeepSeek 直连 provider 测试：假 transport 断言 URL/认证/消息体，无真实模型调用。
 */

import { describe, expect, it } from "vitest";

import { DeepSeekLlmProvider } from "../src/providers/deepseek.js";
import type { HttpRequest, HttpResponse, StreamTransport } from "../src/ports/index.js";

const OPTIONS = {
  apiKey: "sk-test-key",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  temperature: 0.3,
  maxTokens: 4096,
};

class FakeTransport {
  requests: HttpRequest[] = [];
  constructor(private readonly responder: (req: HttpRequest) => HttpResponse) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return this.responder(req);
  }
}

function chatResponse(message: unknown): HttpResponse {
  return { status: 200, body: { choices: [{ message }] } };
}

describe("DeepSeekLlmProvider", () => {
  it("generateText：URL/认证/消息体正确，返回 content", async () => {
    const transport = new FakeTransport(() => chatResponse({ content: "你好" }));
    const llm = new DeepSeekLlmProvider(OPTIONS, transport);

    const text = await llm.generateText("打招呼");

    expect(transport.requests).toHaveLength(1);
    const req = transport.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.deepseek.com/chat/completions");
    expect(req.headers?.["Authorization"]).toBe("Bearer sk-test-key");
    expect(req.headers?.["Content-Type"]).toBe("application/json");
    expect(req.body).toEqual({
      model: "deepseek-v4-flash",
      // 思考开关默认 enabled：必须显式关掉，否则强制 tool_choice 会 400
      thinking: { type: "disabled" },
      temperature: 0.3,
      max_tokens: 4096,
      messages: [{ role: "user", content: "打招呼" }],
    });
    expect(text).toBe("你好");
  });

  it("generateWithTools：tools/tool_choice 消息体正确，解析 tool_calls", async () => {
    const transport = new FakeTransport(() =>
      chatResponse({
        tool_calls: [
          {
            function: {
              name: "create_plan",
              arguments: JSON.stringify({ goal: "复习高数", subject: "高数" }),
            },
          },
        ],
      }),
    );
    const llm = new DeepSeekLlmProvider(OPTIONS, transport);

    const tools = [
      {
        type: "function",
        function: { name: "create_plan", description: "制定计划", parameters: { type: "object" } },
      },
    ];
    const result = await llm.generateWithTools("给我计划", tools, "create_plan");

    const req = transport.requests[0]!;
    expect((req.body as Record<string, unknown>)["tools"]).toEqual(tools);
    expect((req.body as Record<string, unknown>)["tool_choice"]).toEqual({
      type: "function",
      function: { name: "create_plan" },
    });
    expect(result).toEqual({
      tool_calls: [{ name: "create_plan", args: { goal: "复习高数", subject: "高数" } }],
    });
  });

  it("generateWithTools：无 tool_calls 时返回 content；默认 tool_choice=auto", async () => {
    const transport = new FakeTransport(() => chatResponse({ content: "直接回复" }));
    const llm = new DeepSeekLlmProvider(OPTIONS, transport);

    const result = await llm.generateWithTools("你好", [], "");

    expect((transport.requests[0]!.body as Record<string, unknown>)["tool_choice"]).toBe("auto");
    expect(result).toEqual({ content: "直接回复" });
  });

  it("generateJson：追加 JSON 指令、JSON mode、剥离围栏", async () => {
    const transport = new FakeTransport(() =>
      chatResponse({ content: "```json\n{\"a\": 1}\n```" }),
    );
    const llm = new DeepSeekLlmProvider(OPTIONS, transport);

    const result = await llm.generateJson("给我 JSON");

    const body = transport.requests[0]!.body as Record<string, unknown>;
    expect(body["messages"]).toEqual([
      { role: "user", content: "给我 JSON\n请只返回JSON对象，不要包含markdown代码块。" },
    ]);
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(result).toEqual({ a: 1 });
  });

  it("streamText：stream:true，逐条产出 delta.content", async () => {
    const streamTransport: StreamTransport = {
      async *stream(_req: HttpRequest) {
        yield JSON.stringify({ choices: [{ delta: { content: "你好" } }] });
        yield JSON.stringify({ choices: [{ delta: { content: "，同学" } }] });
        yield "[DONE]";
      },
    };
    const requests: HttpRequest[] = [];
    const recordingStream: StreamTransport = {
      async *stream(req: HttpRequest) {
        requests.push(req);
        yield* streamTransport.stream(req);
      },
    };
    const transport = new FakeTransport(() => chatResponse({ content: "" }));
    const llm = new DeepSeekLlmProvider(OPTIONS, transport, recordingStream);

    const chunks: string[] = [];
    for await (const chunk of llm.streamText("打招呼")) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["你好", "，同学"]);
    expect((requests[0]!.body as Record<string, unknown>)["stream"]).toBe(true);
  });

  it("describe 自报 deepseek/ready", () => {
    const transport = new FakeTransport(() => chatResponse({}));
    const llm = new DeepSeekLlmProvider(OPTIONS, transport);
    expect(llm.describe()).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      status: "ready",
    });
  });
});
