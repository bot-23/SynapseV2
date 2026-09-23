/**
 * Synapse 工具定义 —— DeepSeek 可调用的 8 个函数。
 * 翻译自 Synapse/backend/app/services/tools.py（名称/描述/schema 逐字保留）。
 * ToolSpec 只携带 schema 信息，由 provider 完成协议转换。
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function spec(
  name: string,
  description: string,
  title: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolSpec {
  return {
    name,
    description,
    parameters: { properties, required, title, type: "object" },
  };
}

function stringField(description: string, title: string, hasDefault = false): Record<string, unknown> {
  return hasDefault
    ? { default: "", description, title, type: "string" }
    : { description, title, type: "string" };
}

export const replyTool = spec(
  "reply",
  "直接回复用户。用于闲聊、共情、反馈、追问、打招呼等不需要执行操作的场景。\n\n    Args:\n        message: 给用户的回复内容",
  "ReplyInput",
  { message: stringField("给用户的自然语言回复（2-5句）", "Message") },
  ["message"],
);

export const createPlanTool = spec(
  "create_plan",
  "为用户制定新的学习计划。当用户请求生成/制定/安排学习计划时调用。\n\n    Args:\n        subject: 学科名\n        goal: 学习目标\n        requirements: 额外要求",
  "CreatePlanInput",
  {
    subject: stringField("学科名，如'经济学'、'高数'", "Subject"),
    goal: stringField("学习目标，如'复习经济学通过补考'", "Goal"),
    requirements: stringField("额外要求，如'加入错题分类整理'", "Requirements", true),
  },
  ["subject", "goal"],
);

export const restartPlanTool = spec(
  "restart_plan",
  "重新制定上一轮计划。当用户表达不满或要求重做时调用。\n\n    注意：subject 必须从对话上下文推断，不要把用户的抱怨当成学科名。\n\n    Args:\n        subject: 学科名\n        reason: 重新制定的原因\n        extra: 新增要求",
  "RestartPlanInput",
  {
    subject: stringField("学科名，从对话上下文推断", "Subject"),
    reason: stringField("重新制定的原因", "Reason", true),
    extra: stringField("新增要求", "Extra", true),
  },
  ["subject"],
);

export const tweakPlanTool = spec(
  "tweak_plan",
  "微调当前计划，不重新生成整个计划。当用户说'太难了'、'太简单了'、'没时间做'时调用。\n\n    Args:\n        subject: 学科名\n        changes: 调整内容",
  "TweakPlanInput",
  {
    subject: stringField("学科名；如果用户没说清楚，可以留空并从当前计划推断", "Subject", true),
    changes: stringField("要调整的内容，如'太难了，降低难度'、'太简单了，加大练习量'", "Changes"),
  },
  ["changes"],
);

export const rememberTool = spec(
  "remember",
  "记住用户说的话。当用户透露个人信息、弱项、截止时间、偏好、情绪时调用。\n\n    Args:\n        about: 类型（弱项/截止时间/情绪/偏好/约束/年级）\n        value: 具体内容",
  "RememberInput",
  {
    about: stringField("要记住的事情的类型，如'弱项'、'截止时间'、'情绪'、'偏好'", "About"),
    value: stringField("要记住的具体内容", "Value"),
  },
  ["about", "value"],
);

export const teachTool = spec(
  "teach",
  "教学：出题、解释概念、推荐学习方法。当用户要求'出几道题'、'解释一下'、'怎么学'时调用。\n\n    Args:\n        subject: 学科名\n        action: quiz/explain/tip\n        topic: 知识点",
  "TeachInput",
  {
    subject: stringField("学科名", "Subject"),
    action: stringField("教学动作：quiz(出题)/explain(解释)/tip(教方法)", "Action"),
    topic: stringField("具体知识点，如'积分'、'特征值'", "Topic"),
  },
  ["subject", "action", "topic"],
);

export const switchSubjectTool = spec(
  "switch_subject",
  "切换当前会话的学科。当用户说'顺便看看线代'、'切换到大物'时调用。\n\n    Args:\n        subject: 学科名",
  "SwitchSubjectInput",
  { subject: stringField("要切换到的学科名", "Subject") },
  ["subject"],
);

export const askTool = spec(
  "ask",
  "向用户追问关键信息。输出可点击的选项让用户选择。\n\n    Args:\n        question: 问题\n        options: 选项，用|分隔",
  "AskInput",
  {
    question: stringField("要问用户的问题，如'电化学你最头疼什么？'", "Question"),
    options: stringField("可点击的选项，用|分隔。如'公式记混|综合题不会|两者都有'", "Options", true),
  },
  ["question"],
);

export const submitAssignmentTool = spec(
  "submit_assignment",
  "用户把老师布置的作业/习题清单交给你，需要排进日程并盯着截止时间。当用户说「明天交」「周五前」「习题1-20」这类作业句式时调用。\n\n    Args:\n        text: 用户描述的作业原文",
  "SubmitAssignmentInput",
  { text: stringField("作业原文，如'数学第三章习题1-20明天交'", "Text") },
  ["text"],
);

export const ALL_TOOLS: ToolSpec[] = [
  replyTool,
  createPlanTool,
  restartPlanTool,
  tweakPlanTool,
  rememberTool,
  teachTool,
  switchSubjectTool,
  askTool,
  submitAssignmentTool,
];

/** 转成 OpenAI function-calling 工具格式（DeepSeek 兼容）。 */
export function toOpenaiTools(tools: Array<ToolSpec | Record<string, unknown>>): Record<string, unknown>[] {
  return tools.map((tool) => {
    if ("parameters" in tool && "description" in tool && "name" in tool) {
      const t = tool as ToolSpec;
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      };
    }
    return tool as Record<string, unknown>;
  });
}
