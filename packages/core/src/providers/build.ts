/**
 * ProviderBundle 组装（对齐旧仓 build_provider_bundle + workflow._build_providers 的 Key 回退逻辑）。
 */

import type { HttpTransport, StreamTransport } from "../ports/index.js";
import type { RuntimeStore } from "../storage/runtimeStore.js";
import type { ProviderBundle } from "./contracts.js";
import { DeepSeekLlmProvider } from "./deepseek.js";
import { KgRetrievalProvider } from "./kgRetrieval.js";
import {
  MockCalendarProvider,
  MockLlmProvider,
  MockNotifierProvider,
  OfflinePlanLlmProvider,
} from "./mock.js";

export interface ProviderConfig {
  llmProvider: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekTemperature: number;
  deepseekMaxTokens: number;
  /**
   * 未配置 Key 时是否直接走规则引擎排计划（而不是回一句固定话术）。
   * 默认 false：golden 基线冻结的是 MockLlmProvider 的行为；壳显式开启后离线才真正可用。
   */
  offlinePlanFallback: boolean;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  llmProvider: "mock",
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-flash",
  deepseekTemperature: 0.3,
  deepseekMaxTokens: 4096,
  offlinePlanFallback: false,
};

export function buildProviderBundle(
  config: ProviderConfig,
  store: RuntimeStore,
  http?: HttpTransport,
  stream?: StreamTransport,
): ProviderBundle {
  // 与旧仓一致：环境未配置 Key 时回退到存储中的 Key，并自动切到 deepseek
  let llmProviderName = config.llmProvider;
  let apiKey = config.deepseekApiKey;
  if (!apiKey) {
    apiKey = store.get_api_key("default") || "";
    if (apiKey) {
      llmProviderName = "deepseek";
    }
  }

  let llm: ProviderBundle["llm"] = config.offlinePlanFallback
    ? new OfflinePlanLlmProvider()
    : new MockLlmProvider("LLM_PROVIDER 未配置为 deepseek。");
  if (llmProviderName === "deepseek" && apiKey) {
    if (http) {
      llm = new DeepSeekLlmProvider(
        {
          apiKey,
          baseUrl: config.deepseekBaseUrl,
          model: config.deepseekModel,
          temperature: config.deepseekTemperature,
          maxTokens: config.deepseekMaxTokens,
        },
        http,
        stream,
      );
    } else {
      llm = new MockLlmProvider("DeepSeek 初始化失败：未注入 HttpTransport。");
    }
  } else if (llmProviderName === "deepseek") {
    llm = new MockLlmProvider("LLM_PROVIDER=deepseek，但 DEEPSEEK_API_KEY 为空。");
  }

  return {
    llm,
    retrieval: new KgRetrievalProvider(store),
    calendar: new MockCalendarProvider(),
    notifier: new MockNotifierProvider(),
  };
}
