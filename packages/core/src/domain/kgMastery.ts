/**
 * 图谱节点掌握度（纯函数，零依赖，完全离线）。
 *
 * 为什么值得做：原来的图谱是「结构图」——节点之间什么关系一目了然，但看不出
 * 「我到底学没学会」。把复习卡的 SM-2 状态聚合回节点，同一张图立刻变成学情诊断图：
 * 红=薄弱、黄=在学、绿=掌握、灰=未学。图谱从「好看的资产」变成「能指导下一步的东西」。
 *
 * 关联方式：复习卡的 `key` 就是 `review_key(科目, 知识点)`，而节点也有科目与名称，
 * 所以 `review_key(node.subject, node.name)`（含 aliases）能精确对上最近一次构图时
 * 生成的那批卡。对不上的卡片直接忽略——用户手动加的复习卡本来就不一定在图谱里。
 */

import type {
  KnowledgeMasteryEntry,
  MasteryLevel,
  ReviewItem,
} from "../protocol/study.js";
import { DEFAULT_EASE, review_key } from "./review.js";

/** 掌握度判定阈值。写死成常量，保证「为什么是红的」永远可解释、可复现。 */
export const WEAK_EASE = 1.8;
export const MASTERED_EASE = 2.2;
export const MASTERED_REPETITIONS = 3;
/** 忘记两次以上，就算难度系数还行也认定是薄弱点。 */
export const WEAK_LAPSES = 2;

/**
 * 判定只需要节点的这几个字段。
 * 不直接依赖 storage 的 `KnowledgeNode`，让 domain 保持「只依赖 protocol」的层次。
 */
export interface MasteryNodeInput {
  id: string;
  name: string;
  subject: string;
  aliases?: string;
}

/** KV 里可能存着旧版本写的卡片，数值字段缺失时按默认值兜底，不让诊断页崩掉。 */
function num(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function judge(nodeId: string, cards: readonly ReviewItem[]): KnowledgeMasteryEntry {
  if (!cards.length) {
    return {
      node_id: nodeId,
      level: "untouched",
      card_count: 0,
      avg_ease: 0,
      max_repetitions: 0,
      reason: "还没有学过这个知识点",
    };
  }

  const eases = cards.map((card) => num(card.ease, DEFAULT_EASE));
  const repetitions = cards.map((card) => num(card.repetitions, 0));
  const avgEase = Number((eases.reduce((sum, value) => sum + value, 0) / eases.length).toFixed(2));
  const maxRepetitions = Math.max(...repetitions);
  const base = {
    node_id: nodeId,
    card_count: cards.length,
    avg_ease: avgEase,
    max_repetitions: maxRepetitions,
  };

  // 先判薄弱：只要有一张卡在「难度掉下去」或「反复忘记」，这个知识点就不该显示成绿的。
  const weakIndex = cards.findIndex(
    (card, index) => eases[index]! < WEAK_EASE || num(card.lapses, 0) >= WEAK_LAPSES,
  );
  if (weakIndex >= 0) {
    const reason =
      eases[weakIndex]! < WEAK_EASE
        ? `难度系数已掉到 ${eases[weakIndex]}，需要回炉`
        : `已经忘记 ${num(cards[weakIndex]!.lapses, 0)} 次，是薄弱点`;
    return { ...base, level: "weak", reason };
  }

  if (maxRepetitions >= MASTERED_REPETITIONS && avgEase >= MASTERED_EASE) {
    return {
      ...base,
      level: "mastered",
      reason: `连续记住 ${maxRepetitions} 次，难度系数 ${avgEase}`,
    };
  }

  return {
    ...base,
    level: "learning",
    reason: `复习中：已连续记住 ${maxRepetitions} 次，难度系数 ${avgEase}`,
  };
}

/**
 * 给每个节点算一档掌握度。
 *
 * 传入顺序即返回顺序（壳侧按 node_id 上色，顺序不影响渲染，但保持稳定便于比对）。
 */
export function compute_mastery(
  nodes: readonly MasteryNodeInput[],
  reviewCards: readonly ReviewItem[],
): KnowledgeMasteryEntry[] {
  const nodeIdByKey = new Map<string, string>();
  for (const node of nodes) {
    if (!node?.id) {
      continue;
    }
    const keys = [review_key(node.subject, node.name)];
    for (const alias of String(node.aliases ?? "").split(/[,，、;；]/)) {
      const trimmed = alias.trim();
      if (trimmed) {
        keys.push(review_key(node.subject, trimmed));
      }
    }
    for (const key of keys) {
      // 先到先得：种子节点排在前面，别名撞车时不要让后来的节点抢走卡片
      if (!nodeIdByKey.has(key)) {
        nodeIdByKey.set(key, node.id);
      }
    }
  }

  const cardsByNode = new Map<string, ReviewItem[]>();
  for (const card of reviewCards) {
    const nodeId = nodeIdByKey.get(String(card?.key ?? ""));
    if (!nodeId) {
      continue;
    }
    const bucket = cardsByNode.get(nodeId);
    if (bucket) {
      bucket.push(card);
    } else {
      cardsByNode.set(nodeId, [card]);
    }
  }

  return nodes
    .filter((node) => Boolean(node?.id))
    .map((node) => judge(node.id, cardsByNode.get(node.id) ?? []));
}

/** 四档数量统计：给壳侧画图例用。 */
export function summarize_mastery(
  entries: readonly KnowledgeMasteryEntry[],
): Record<MasteryLevel, number> {
  const counts: Record<MasteryLevel, number> = {
    weak: 0,
    learning: 0,
    mastered: 0,
    untouched: 0,
  };
  for (const entry of entries) {
    counts[entry.level] += 1;
  }
  return counts;
}
