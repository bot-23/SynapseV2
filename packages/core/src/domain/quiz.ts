/**
 * 结构化测验：出题（解析模型 JSON）与判分（确定性、离线可复现）。
 *
 * 判分刻意不依赖模型 —— 只有确定性判分，错题才有资格进错题本；
 * 让模型「顺便判一下」会让同一份答案时对时错，错题本立刻失去可信度。
 */

export interface QuizQuestion {
  id: string;
  subject: string;
  topic: string;
  stem: string;
  options: string[];
  answer_index: number;
}

export interface QuizGrade {
  total: number;
  correct: number;
  /** 百分制得分（整数）。 */
  score: number;
  /** 错题的序号（与传入 questions 的下标一致）。 */
  wrong_indexes: number[];
}

/** 一次最多几题（模型偶尔会超量输出）。 */
export const QUIZ_MAX_QUESTIONS = 20;
/** 每题最多几个选项。 */
export const QUIZ_MAX_OPTIONS = 6;
/** 单个文本字段的长度上限。 */
export const QUIZ_MAX_CHARS = 400;

function truncate(value: unknown, max = QUIZ_MAX_CHARS): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 解析模型返回的测验 JSON。
 * 接受 `{ "questions": [...] }` 或裸数组；任何一项不合法就整条丢弃，
 * 绝不把「选项不足 / 答案越界」的题混进来 —— 那种题判分必然出错。
 */
export function parse_quiz_json(raw: unknown, subject: string, topic: string): QuizQuestion[] {
  let list: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    list = (raw as Record<string, unknown>)["questions"];
  }
  if (!Array.isArray(list)) {
    return [];
  }

  const questions: QuizQuestion[] = [];
  list.slice(0, QUIZ_MAX_QUESTIONS).forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const row = item as Record<string, unknown>;
    const stem = truncate(row["stem"] ?? row["question"]);
    const options = Array.isArray(row["options"])
      ? (row["options"] as unknown[])
          .map((option) => truncate(option))
          .filter(Boolean)
          .slice(0, QUIZ_MAX_OPTIONS)
      : [];
    if (!stem || options.length < 2) {
      return;
    }
    const answerIndex = Math.trunc(Number(row["answer_index"] ?? row["answer"] ?? Number.NaN));
    if (!Number.isFinite(answerIndex) || answerIndex < 0 || answerIndex >= options.length) {
      return;
    }
    questions.push({
      id: truncate(row["id"], 64) || `q${index + 1}`,
      subject: truncate(row["subject"], 100) || subject,
      topic: truncate(row["topic"], 200) || topic,
      stem,
      options,
      answer_index: answerIndex,
    });
  });
  return questions;
}

/** 判分：answers[i] 是第 i 题选择的选项下标；未作答 / 越界都算错。 */
export function grade_quiz(
  questions: readonly QuizQuestion[],
  answers: readonly number[],
): QuizGrade {
  const wrong: number[] = [];
  let correct = 0;
  questions.forEach((question, index) => {
    const picked = Number(answers[index]);
    if (Number.isFinite(picked) && Math.trunc(picked) === question.answer_index) {
      correct += 1;
    } else {
      wrong.push(index);
    }
  });
  const total = questions.length;
  return {
    total,
    correct,
    score: total ? Math.round((correct / total) * 100) : 0,
    wrong_indexes: wrong,
  };
}
