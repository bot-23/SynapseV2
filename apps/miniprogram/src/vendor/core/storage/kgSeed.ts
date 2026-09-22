/**
 * 知识图谱种子数据（移植自 Synapse/db/retrieval.py _bootstrap_if_empty，9 节点 10 边）。
 * 插入顺序即旧库 rowid 顺序，影响同名分数排序稳定性，不得调整。
 */

export interface KnowledgeNode {
  id: string;
  name: string;
  category: string;
  subject: string;
  grade: string;
  aliases: string;
  description: string;
}

export interface KnowledgeEdge {
  source_id: string;
  target_id: string;
  relation: string;
}

export const SEED_KG_NODES: KnowledgeNode[] = [
  {
    id: "course_math_hs", name: "高中数学", category: "course",
    subject: "数学", grade: "高中",
    aliases: "数学,高中数学", description: "",
  },
  {
    id: "topic_functions", name: "函数专题", category: "topic",
    subject: "数学", grade: "高一到高二",
    aliases: "函数,函数复习", description: "高中函数专题总复习",
  },
  {
    id: "topic_quadratic", name: "二次函数", category: "topic",
    subject: "数学", grade: "高一",
    aliases: "二次函数,抛物线", description: "图像、性质与最值",
  },
  {
    id: "topic_monotonicity", name: "函数单调性", category: "topic",
    subject: "数学", grade: "高一",
    aliases: "单调性,函数单调性", description: "区间判断与综合题",
  },
  {
    id: "topic_domain", name: "定义域和值域", category: "topic",
    subject: "数学", grade: "高一",
    aliases: "定义域,值域", description: "函数基础概念",
  },
  {
    id: "topic_exam_strategy", name: "期末复习策略", category: "strategy",
    subject: "通用", grade: "",
    aliases: "期末复习,复习策略", description: "先诊断、再推进、最后回顾",
  },
  {
    id: "task_sort_notes", name: "整理错题与笔记", category: "task",
    subject: "通用", grade: "",
    aliases: "错题整理,笔记整理", description: "先把已有资料归拢，减少无效重复",
  },
  {
    id: "task_topic_drill", name: "专题题组训练", category: "task",
    subject: "数学", grade: "",
    aliases: "题组训练,专题练习", description: "按弱项做小批量针对训练",
  },
  {
    id: "task_review_loop", name: "回顾与小测", category: "task",
    subject: "通用", grade: "",
    aliases: "回顾,小测", description: "学习后 24 小时内完成一次回顾",
  },
];

export const SEED_KG_EDGES: KnowledgeEdge[] = [
  { source_id: "course_math_hs", target_id: "topic_functions", relation: "contains" },
  { source_id: "topic_functions", target_id: "topic_domain", relation: "starts_from" },
  { source_id: "topic_functions", target_id: "topic_quadratic", relation: "contains" },
  { source_id: "topic_functions", target_id: "topic_monotonicity", relation: "contains" },
  { source_id: "topic_domain", target_id: "topic_quadratic", relation: "prerequisite_of" },
  { source_id: "topic_quadratic", target_id: "topic_monotonicity", relation: "supports" },
  { source_id: "topic_exam_strategy", target_id: "task_sort_notes", relation: "recommends" },
  { source_id: "topic_exam_strategy", target_id: "task_topic_drill", relation: "recommends" },
  { source_id: "task_topic_drill", target_id: "task_review_loop", relation: "followed_by" },
  { source_id: "topic_functions", target_id: "task_topic_drill", relation: "practice_for" },
];
