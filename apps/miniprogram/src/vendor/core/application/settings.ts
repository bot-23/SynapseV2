/**
 * 设置服务（翻译自 Synapse/backend/app/application/settings.py，语义逐字保留）。
 */

import type { RuntimeStore } from "../storage/runtimeStore";

export class SettingsService {
  constructor(private readonly store: RuntimeStore) {}

  status(): Record<string, unknown> {
    const apiKey = this.store.get_api_key("default");
    return { deepseek_configured: Boolean(apiKey) };
  }

  save_api_key(apiKey: string): Record<string, unknown> {
    const key = (apiKey || "").trim();
    if (!key.startsWith("sk-")) {
      throw new Error("API Key 格式错误，应以 sk- 开头");
    }
    this.store.save_api_key("default", key);
    return { provider: "deepseek" };
  }

  get_profile(userId = "default"): Record<string, unknown> {
    return this.store.get_profile(userId);
  }

  save_profile(
    userId: string,
    name: string | null,
    grade: string | null,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (name) {
      const existing = this.store.get_profile(userId);
      if (existing["display_name"]) {
        throw new Error("用户名已设定，不可修改");
      }
      data["display_name"] = name;
    }
    if (grade) {
      data["current_level"] = grade;
    }
    return this.store.save_profile(userId, data);
  }

  delete_all_user_data(userId = "default"): void {
    this.store.delete_all_user_data(userId);
  }
}
