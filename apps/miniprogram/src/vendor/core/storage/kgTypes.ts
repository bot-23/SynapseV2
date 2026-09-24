/**
 * 知识图谱的数据结构定义。
 *
 * 图谱不再有内置种子：新装的用户图谱为空，节点与边全部由用户自己的资料、
 * 计划与复习记录构建（见 application/kgBuilder.ts 与 loadDemoData）。
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
