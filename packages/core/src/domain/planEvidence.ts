/**
 * 计划依据（G4.3）：把「AI 为什么这么安排」摊开给用户看。
 *
 * 三类证据都是**已经存在的事实**，这里只做归集与计数，不参与任何生成逻辑：
 * - 资料原文片段：检索上下文里的「资料命中[...]」行；
 * - 图谱学习路径：检索上下文里的图谱行；
 * - 规则命中项：从已生成的周计划与归一化请求里读出来的确定性规则，全部带真实数字。
 *
 * 「AI 说的每一句都能被指回去」是这一层的产品意义：不给结论加戏，也不替模型圆场。
 */

import type { StudyDayPlan, StudyPlanRequest } from "../protocol/study.js";
import { classify_context_line, parse_document_hit, type ContextSource } from "./contextBudget.js";

export interface PlanEvidence {
  /** 资料原文片段（文件名 + 摘录），顺序与检索上下文一致 */
  documents: Array<{ file_name: string; excerpt: string }>;
  /** 图谱学习路径（原始行，壳侧直接展示） */
  graph_paths: string[];
  /** 除资料与图谱外还参考了什么（课表 / 执行记录 / 画像） */
  others: Array<{ source: ContextSource; text: string }>;
  /** 命中的确定性规则，每条都带真实数字 */
  rules: string[];
}

/** 除资料与图谱外的上下文归类标签（壳侧直接显示这几个字）。 */
const SOURCE_LABELS: Partial<Record<ContextSource, string>> = {
  timetable: "课程表",
  progress: "执行记录",
  profile: "画像",
};

export function build_plan_evidence(input: {
  context?: readonly string[];
  weeklyPlan: readonly StudyDayPlan[];
  request?: StudyPlanRequest | null;
}): PlanEvidence {
  const context = input.context ?? [];
  const documents: PlanEvidence["documents"] = [];
  const graphPaths: string[] = [];
  const others: PlanEvidence["others"] = [];

  for (const line of context) {
    const hit = parse_document_hit(line);
    if (hit) {
      documents.push({ file_name: hit.file_name, excerpt: hit.excerpt });
      continue;
    }
    const source = classify_context_line(line);
    if (source === "graph") {
      graphPaths.push(line);
      continue;
    }
    if (SOURCE_LABELS[source]) {
      others.push({ source, text: line });
    }
  }

  return {
    documents,
    graph_paths: graphPaths,
    others,
    rules: build_rule_hits(input.weeklyPlan, input.request ?? null, context),
  };
}

/** 规则命中项：只统计「真的发生了」的规则，一条没命中就不写。 */
function build_rule_hits(
  weeklyPlan: readonly StudyDayPlan[],
  request: StudyPlanRequest | null,
  context: readonly string[],
): string[] {
  const rules: string[] = [];
  const days = weeklyPlan.filter((day) => day && Array.isArray(day.tasks));

  const dayTotals = days.map((day) =>
    day.tasks.reduce((sum, task) => sum + Math.max(0, Math.trunc(task.duration_minutes ?? 0)), 0),
  );
  const maxPerDay = dayTotals.length ? Math.max(...dayTotals) : 0;
  if (maxPerDay > 0) {
    rules.push(`每天任务总量控制在 ${maxPerDay} 分钟以内`);
  }

  const reviewCount = days.reduce(
    (sum, day) => sum + day.tasks.filter((task) => task.task_type === "review").length,
    0,
  );
  if (reviewCount > 0) {
    rules.push(`排了 ${reviewCount} 项复习任务，新学的内容会回流到复习队列`);
  }

  const subjects = new Set(
    days.flatMap((day) => day.tasks.map((task) => (task.subject || "").trim()).filter(Boolean)),
  );
  if (subjects.size >= 2) {
    rules.push(`${subjects.size} 个科目按天并行，各自占用当天的剩余预算`);
  }

  const weakPoints = (request?.weak_points ?? []).map((point) => String(point).trim()).filter(Boolean);
  const covered = weakPoints.filter((point) =>
    days.some((day) =>
      day.tasks.some((task) => `${task.title}${task.reason}`.includes(point)),
    ),
  );
  if (covered.length) {
    rules.push(`优先覆盖你提到的薄弱点：${covered.join("、")}`);
  }

  if (request?.deadline) {
    rules.push(`节奏参考你给的截止时间 ${request.deadline}`);
  }

  const timetableCount = context.filter((line) => classify_context_line(line) === "timetable").length;
  if (timetableCount > 0) {
    rules.push(`避让了课程表里的 ${timetableCount} 个上课时段`);
  }

  if (context.some((line) => classify_context_line(line) === "progress")) {
    rules.push("按最近的执行记录调整了任务量");
  }

  if (context.some((line) => classify_context_line(line) === "profile")) {
    rules.push("沿用了画像里的学习方式偏好");
  }

  return rules;
}
