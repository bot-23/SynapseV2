/**
 * Mock providers（移植自 Synapse/backend/app/services/providers/base.py，文案逐字保留）。
 */

import type {
  CalendarProvider,
  GenerateWithToolsResult,
  LlmProvider,
  NotifierProvider,
  ProviderBundle,
  RetrievalProvider,
} from "./contracts";

export class MockLlmProvider implements LlmProvider {
  constructor(private readonly reason = "") {}

  async generateText(prompt: string): Promise<string> {
    return `[mock-llm] ${prompt}`;
  }

  async generateWithTools(
    _prompt: string,
    _tools: unknown[],
  ): Promise<GenerateWithToolsResult> {
    return {
      content:
        "你好，我是 Synapse。后端当前未配置 DeepSeek，使用本地规则模式。你可以告诉我学习目标，我来帮你制定计划。",
    };
  }

  async generateJson(_prompt: string): Promise<Record<string, unknown>> {
    return {};
  }

  async *streamText(prompt: string): AsyncIterable<string> {
    yield `[mock-llm] ${prompt}`;
  }

  describe(): Record<string, unknown> {
    return {
      provider: "mock",
      model: "mock-llm",
      status: "fallback",
      message: this.reason || "当前仍在使用 mock LLM provider。",
    };
  }
}

/**
 * 离线规划模式的 LLM 占位（未配置任何模型 Key 时使用）。
 *
 * 与 `MockLlmProvider` 的关键区别：Mock 会给出一句固定话术，意图分类会把它当成
 * 「闲聊回复」，于是用户明明要计划也只拿到一句话。这里直接抛错，让上层走既有的
 * 「模型不可达 → 规则计划」通道，离线也能拿到真正可执行的计划。
 *
 * 默认不启用：默认行为是 Mock 的一句固定话术；由壳显式开启后离线才真正可用。
 */
export class OfflinePlanLlmProvider implements LlmProvider {
  constructor(
    private readonly reason = "当前未配置模型 Key，本轮改用本地规则引擎",
  ) {}

  async generateText(prompt: string): Promise<string> {
    return `[offline-llm] ${prompt}`;
  }

  async generateWithTools(): Promise<GenerateWithToolsResult> {
    throw new Error(this.reason);
  }

  async generateJson(): Promise<Record<string, unknown>> {
    throw new Error(this.reason);
  }

  async *streamText(prompt: string): AsyncIterable<string> {
    yield `[offline-llm] ${prompt}`;
  }

  describe(): Record<string, unknown> {
    return {
      provider: "offline-rule",
      model: "offline-rule",
      status: "fallback",
      message: this.reason,
    };
  }
}

export class MockRetrievalProvider implements RetrievalProvider {
  search(query: string): string[] {
    return [
      `已检索标准大纲片段: ${query}`,
      "已检索题型建议: 先知识点梳理，再做针对性练习",
      "已检索学习法建议: 每周至少安排一次回顾和一次小测",
    ];
  }

  describe(): Record<string, unknown> {
    return {
      provider: "mock",
      status: "fallback",
      message: "当前仍在使用 mock retrieval provider。",
    };
  }
}

export class MockCalendarProvider implements CalendarProvider {
  checkDeadline(deadline: string | null): string {
    if (deadline) {
      return `检测到目标截止时间 ${deadline}，计划已自动向前压缩。`;
    }
    return "未提供明确截止时间，暂按稳态推进。";
  }
}

export class MockNotifierProvider implements NotifierProvider {
  buildReminder(summary: string): string {
    return `提醒建议：${summary}`;
  }
}

export function buildMockProviderBundle(): ProviderBundle {
  return {
    llm: new MockLlmProvider(),
    retrieval: new MockRetrievalProvider(),
    calendar: new MockCalendarProvider(),
    notifier: new MockNotifierProvider(),
  };
}
