/**
 * 会话服务（翻译自 Synapse/backend/app/application/conversations.py）。
 */

import type { ConversationRecord, MessageRecord, RuntimeStore } from "../storage/runtimeStore";

export class ConversationService {
  constructor(private readonly store: RuntimeStore) {}

  list_conversations(userId = "default"): ConversationRecord[] {
    return this.store.list_conversations(userId);
  }

  save_conversation(
    conversationId: string,
    args: { title: string; planning_mode: string; user_id?: string },
  ): void {
    this.store.save_conversation(
      conversationId,
      args.user_id ?? "default",
      args.title,
      "通用",
      args.planning_mode,
    );
  }

  delete_conversation(conversationId: string): void {
    this.store.delete_conversation(conversationId);
  }

  get_messages(conversationId: string): MessageRecord[] {
    return this.store.get_messages(conversationId);
  }

  save_message(
    conversationId: string,
    messageId: string,
    args: {
      role: string;
      content?: string;
      attachments_json?: string | null;
      plan_data_json?: string | null;
      request_context_json?: string | null;
      response_mode?: string | null;
      reason?: string | null;
      next_steps_json?: string | null;
      plan_confirmed?: boolean;
      expanded_to_week?: boolean;
    },
  ): void {
    this.store.save_message(messageId, conversationId, args.role, args.content ?? "", {
      attachments_json: args.attachments_json ?? null,
      plan_data_json: args.plan_data_json ?? null,
      request_context_json: args.request_context_json ?? null,
      response_mode: args.response_mode ?? null,
      reason: args.reason ?? null,
      next_steps_json: args.next_steps_json ?? null,
      plan_confirmed: args.plan_confirmed ?? false,
      expanded_to_week: args.expanded_to_week ?? false,
    });
  }
}
