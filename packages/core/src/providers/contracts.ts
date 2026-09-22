/**
 * Provider 契约（重写自 Synapse/backend/app/services/providers/base.py）。
 * LLM 调用为异步（HTTP 经 ports/HttpTransport，由壳注入）。
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type GenerateWithToolsResult =
  | { tool_calls: ToolCall[] }
  | { content: string };

export interface LlmProvider {
  generateText(prompt: string): Promise<string>;
  generateWithTools(
    prompt: string,
    tools: unknown[],
    forceTool?: string,
  ): Promise<GenerateWithToolsResult>;
  generateJson(prompt: string): Promise<Record<string, unknown>>;
  streamText(prompt: string): AsyncIterable<string>;
  describe(): Record<string, unknown>;
}

export interface RetrievalProvider {
  search(query: string): string[];
  describe(): Record<string, unknown>;
}

export interface CalendarProvider {
  checkDeadline(deadline: string | null): string;
}

export interface NotifierProvider {
  buildReminder(summary: string): string;
}

export interface ProviderBundle {
  llm: LlmProvider;
  retrieval: RetrievalProvider;
  calendar: CalendarProvider;
  notifier: NotifierProvider;
}
