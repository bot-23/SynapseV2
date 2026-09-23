/**
 * 苏格拉底提示服务（v2）。
 *
 * 职责边界：
 * - 题面与答案**只从本地已有材料里取**（图谱节点说明、资料原文），模型不许编答案；
 * - 提示由模型生成（有 Key 时），生成后缓存到卡片上，重复点击不再花调用；
 * - 没 Key / 调用失败 / 模型把答案说了，一律回落到离线规则提示，并标 `degraded`，
 *   绝不静默失败 —— 学生点了「提示我」就必须拿到东西。
 */

import type { ReviewHintResult, ReviewItem } from "../protocol/study.js";
import { HINT_TIERS, build_offline_hints, find_leaked_span } from "../domain/reviewHints.js";
import { review_key } from "../domain/review.js";
import type { LlmProvider } from "../providers/contracts.js";
import type { RuntimeStore } from "../storage/runtimeStore.js";
import { buildHintPrompt } from "./prompts.js";

/** 图谱节点说明短于这个长度就不当作答案——「离线规则抽取」这类占位说明没有信息量。 */
const MIN_ANSWER_CHARS = 8;
/** 资料原文当答案时的截断长度。 */
const ANSWER_MAX_CHARS = 200;

export class HintService {
  constructor(
    private readonly store: RuntimeStore,
    private readonly llm: LlmProvider,
  ) {}

  /**
   * 取一张复习卡的三级提示。
   *
   * 缓存策略：只缓存**模型产出且没有泄露答案**的提示。
   * - 离线提示是纯函数，重算不要钱，缓存反而会让 `degraded` 标记失真；
   * - 被过滤过的结果不缓存，下次点击相当于让模型重试一次。
   */
  async reveal(userId: string, reviewId: string): Promise<ReviewHintResult> {
    const uid = userId || "default";
    const cards = this.store.get_reviews(uid);
    const card = cards.find((item) => item.id === reviewId);
    if (!card) {
      throw new Error("复习队列里没有这一条");
    }

    const question = card.subject ? `${card.subject} · ${card.topic}` : card.topic;
    const evidence = this.answer_for(uid, card);
    const base = {
      review_id: card.id,
      question,
      ...evidence,
    };

    const cached = this.cached_hints(card);
    if (cached.length >= HINT_TIERS.length) {
      return { ...base, hints: cached, degraded: false, cached: true, filtered: 0 };
    }

    if (this.llm.describe()["provider"] === "deepseek") {
      try {
        const raw = await this.llm.generateJson(
          buildHintPrompt(question, evidence.answer, HINT_TIERS.length),
        );
        const produced = this.coerce_hints(raw["hints"]);
        if (produced.length >= HINT_TIERS.length) {
          const filtered = this.filter_leaks(produced, evidence.answer, card);
          if (filtered.leaked === 0) {
            this.persist(uid, cards, card.id, filtered.hints);
            return {
              ...base,
              hints: filtered.hints,
              degraded: false,
              cached: false,
              filtered: 0,
            };
          }
          return {
            ...base,
            hints: filtered.hints,
            degraded: false,
            cached: false,
            filtered: filtered.leaked,
          };
        }
      } catch {
        // 模型调用失败：静默回落到离线提示，学生依然拿得到东西
      }
    }

    return {
      ...base,
      hints: build_offline_hints(card.subject, card.topic),
      degraded: true,
      cached: false,
      filtered: 0,
    };
  }

  /** 卡片上缓存的提示；旧数据没有这个字段，按空数组处理。 */
  private cached_hints(card: ReviewItem): string[] {
    const raw = (card as Partial<ReviewItem>).hint_texts;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, HINT_TIERS.length);
  }

  /**
   * 找这道题的「标准答案」——只认用户自己的材料，取不到宁可留空。
   *
   * 顺序：图谱节点说明 → 资料里讲到这个知识点的那段原文。
   */
  private answer_for(
    userId: string,
    card: ReviewItem,
  ): { answer: string; answer_source: string } {
    const node = this.store.kgNodes().find((candidate) => {
      if (review_key(candidate.subject, candidate.name) === card.key) {
        return true;
      }
      return String(candidate.aliases ?? "")
        .split(/[,，、;；]/)
        .some((alias) => alias.trim() && review_key(candidate.subject, alias.trim()) === card.key);
    });
    const description = String(node?.description ?? "").trim();
    if (description.length >= MIN_ANSWER_CHARS) {
      return { answer: description, answer_source: "你图谱里这个知识点的说明" };
    }

    const topic = String(card.topic ?? "").trim();
    if (topic) {
      for (const record of this.store.get_documents(userId)) {
        const chunks = Array.isArray(record["chunks"]) ? record["chunks"] : [];
        for (const chunk of chunks) {
          const text =
            chunk && typeof chunk === "object"
              ? String((chunk as Record<string, unknown>)["text"] ?? "")
              : "";
          const at = text.indexOf(topic);
          if (at < 0) {
            continue;
          }
          const start = Math.max(0, at - 20);
          return {
            answer: text.slice(start, start + ANSWER_MAX_CHARS).trim(),
            answer_source: `你的资料《${String(record["file_name"] ?? "未命名资料")}》`,
          };
        }
      }
    }

    return {
      answer: "",
      answer_source: "这道题还没有对应的资料或图谱说明，翻回你自己的笔记复述一遍最有效",
    };
  }

  /** 模型返回的 hints 做形状校验：非数组、空串、超长都挡掉。 */
  private coerce_hints(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item) => String(item ?? "").trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, HINT_TIERS.length);
  }

  /**
   * 提示泄露答案的兜底：逐条检查，把泄露的那条换成同档位的离线提示。
   * 宁可提示变通用，也不能把答案提前抖出去。
   */
  private filter_leaks(
    hints: readonly string[],
    answer: string,
    card: ReviewItem,
  ): { hints: string[]; leaked: number } {
    if (!answer) {
      return { hints: [...hints], leaked: 0 };
    }
    const offline = build_offline_hints(card.subject, card.topic);
    let leaked = 0;
    const cleaned = hints.map((hint, index) => {
      if (find_leaked_span(hint, answer) === null) {
        return hint;
      }
      leaked += 1;
      return offline[index] ?? offline[0]!;
    });
    return { hints: cleaned, leaked };
  }

  private persist(userId: string, cards: ReviewItem[], reviewId: string, hints: string[]): void {
    this.store.save_reviews(
      userId,
      cards.map((item) => (item.id === reviewId ? { ...item, hint_texts: hints } : item)),
    );
  }
}
