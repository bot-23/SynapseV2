/**
 * 提示词拼装（翻译自 Synapse/backend/app/services/workflow.py，文案逐字保留）。
 */

import type { StudyPlanRequest } from "../protocol/study.js";

export function buildPlanPrompt(
  payload: StudyPlanRequest,
  retrievedContext: string[],
): string {
  const context =
    retrievedContext
      .slice(0, 5)
      .map((item) => `- ${item}`)
      .join("\n") || "- 暂无检索资料";
  const weakPoints = payload.weak_points.length ? payload.weak_points.join("、") : "未明确";
  const preferences = payload.preferences.length ? payload.preferences.join("、") : "未明确";
  const deadline = payload.deadline || "未明确";
  const days = Math.min(payload.available_days_per_week, 5);

  return `
你是一个学习规划后端节点。请只输出 JSON，不要输出 Markdown，不要展示推理过程。

用户画像：
- 年级：${payload.current_level}
- 学习目标：${payload.learning_goal}
- 每周可学习天数：${payload.available_days_per_week}
- 每天可用分钟数：${payload.available_minutes_per_day}
- 截止时间：${deadline}
- 薄弱点：${weakPoints}
- 偏好：${preferences}

可用资料摘要：
${context}

请生成最多 ${days} 天的学习计划。focus 用简短词组（如"极限与连续"），不要用完整句子。JSON 格式必须为：
{
  "weekly_plan": [
    {
      "day_index": 1,
      "focus": "当天重点",
      "tasks": [
        {
          "title": "具体任务",
          "subject": "科目名",
          "task_type": "learn",
          "duration_minutes": 40,
          "reason": "为什么这样安排"
        }
      ]
    }
  ],
  "final_message": "给用户看的详细鼓励语和计划说明，像知心朋友一样亲切、温暖、详细。字数可以多一些，充分表达关心，不要太机械呆板",
  "next_actions": ["下一步建议 1", "下一步建议 2"]
}

task_type 只能使用 learn、practice、review、mock_exam。
每天的每个任务都必须填 subject：如果这轮只涉及一个科目，就统一填该科目名；如果涉及多个科目，每天应同时包含多个科目的任务，各自用对应科目名。
每天任务总时长不要超过每天可用分钟数。
任务标题必须贴合用户输入的具体目标，不要使用泛泛的固定模板。
`.trim();
}

export function buildIntentPrompt(
  profileText: string,
  history: string,
  message: string,
): string {
  return (
    "你是 Synapse，一个学习陪伴 AI。每收到用户消息，必须按以下步骤思考，然后调用工具：\n\n" +
    "第1步 分析：用户想要什么？（制定计划/闲聊/教学/切换学科）\n" +
    "第2步 检查：信息够吗？（缺少学科？薄弱点？截止时间？每天可用时间？）\n" +
    "第3步 调用工具：\n" +
    "  - 信息不足 → ask(question, options) 列出3-5个点击选项，不要自己回答\n" +
    '  - 用户说"给我计划/制定计划/安排学习/直接做计划" → create_plan(goal, subject)\n' +
    "  - 用户透露个人信息 → remember(about, value)，可以同时调其他工具\n" +
    "  - 用户想改当前计划强度/时长/难度/练习量 → tweak_plan(changes, subject)\n" +
    "  - 用户对上一轮计划不满 → restart_plan(subject, reason)\n" +
    "  - 用户要求出题/解释/教方法 → teach(subject, action, topic)\n" +
    "  - 闲聊/共情 → reply(message)\n\n" +
    "绝对禁止：用 reply 写计划文本。只要用户要计划，必须调 create_plan。\n" +
    "一次可以调多个工具（如先 remember 记住信息 + ask 追问更多）。\n\n" +
    profileText +
    (history ? "对话记录：\n" + history + "\n" : "") +
    "用户：" +
    message
  );
}

export function buildConversationalReplyPrompt(
  profileText: string,
  history: string,
  userMessage: string,
): string {
  return (
    "你是 Synapse，一个温暖、聪明、像真人一样的学习陪伴朋友。\n" +
    profileText +
    (history ? "对话历史：\n" + history + "\n" : "") +
    "用户：" +
    userMessage +
    "\n\n" +
    "请用中文自然回复（2-5句）。不要用模板。如果用户表达情绪，请真诚共情。如果用户信息不足，友好追问。"
  );
}

export function buildTeachPrompt(subject: string, action: string, topic: string): string {
  return `用户需要教学帮助。学科：${subject}，动作：${action}，知识点：${topic}。请给出具体、可操作的教学内容（2-5句）。`;
}

export function buildRememberRetryPrompt(userInput: string): string {
  return "已记住用户信息。请继续处理用户最后一条消息。\n用户：" + userInput;
}

/**
 * v2：长期计划（里程碑）提示词。
 * 只切阶段，不排每日任务 —— 每日任务由短期计划落地。
 */
export function buildLongTermPlanPrompt(args: {
  goal: string;
  subjects: string[];
  today: string;
  deadline: string;
  totalDays: number;
  stageCount: number;
}): string {
  const subjectText = args.subjects.length ? args.subjects.join("、") : "未明确";
  return `
你是一个长期学习规划的编排节点。请只输出 JSON，不要输出 Markdown，不要展示推理过程。

总目标：${args.goal}
涉及科目：${subjectText}
今天：${args.today}
截止日期：${args.deadline}（共 ${args.totalDays} 天）
需要划分的阶段数：${args.stageCount} 个

请把整个周期切成 ${args.stageCount} 个阶段（里程碑），体现"先打基础、再强化、最后冲刺验收"的推进顺序。
不要排每日任务，只给阶段层面的目标。

JSON 格式必须为：
{
  "milestones": [
    {
      "title": "阶段名（4-8 个字，如 打基础、真题实战）",
      "goal": "这一阶段要达成什么（一句话，会作为该阶段每周计划的学习目标）",
      "start_date": "YYYY-MM-DD",
      "due_date": "YYYY-MM-DD",
      "acceptance": "怎么算这一阶段完成（一句话，可验证）"
    }
  ]
}

约束：
- 阶段必须首尾相接：第一个阶段从 ${args.today} 开始，最后一个阶段在 ${args.deadline} 结束。
- start_date / due_date 必须是 YYYY-MM-DD 格式的真实日期，且 due_date 不早于 start_date。
- 阶段数必须正好是 ${args.stageCount} 个。
`.trim();
}

/** v2：多科目拆分时的单科计划提示词（每科独立生成后再合并，保证每天各科都有安排）。 */
export function buildMultiSubjectIntroPrompt(
  subjects: string[],
  shortGoal: string,
  dailyMinutes: number,
  days: number,
): string {
  return (
    `你是学习陪伴AI。用户的目标是「${shortGoal}」，涉及多个科目：${subjects.join("、")}。` +
    `我已按科目分别排好计划，每天在约 ${dailyMinutes} 分钟内混合安排 ${subjects.join("、")} 的任务，共 ${days} 天。` +
    "请用1-2句话自然、温暖、简洁地介绍这份计划，并说明每天会同时兼顾这些科目。"
  );
}

export function buildRulePlanMessagePrompt(
  shortGoal: string,
  focus: string,
  weeklyPlanSummary: string,
  planCount: number,
  deadlineNote: string,
): string {
  return (
    `你是学习陪伴AI。用户的目标是「${shortGoal}」，重点围绕${focus}。` +
    `现已生成${planCount}天计划：${weeklyPlanSummary}。` +
    deadlineNote +
    "请用1-2句话自然、温暖、简洁地介绍这份计划给用户。"
  );
}
