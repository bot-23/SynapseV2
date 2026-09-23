/**
 * 苏格拉底提示（纯函数，零依赖，离线可用）。
 *
 * 产品立场：**AI 克制地不直接给答案**。学生卡住时，最好的帮助不是把答案念一遍，
 * 而是把他往前推一步：先指方向，再给思路，最后才点关键步骤。三级都用完了，
 * 才轮到翻答案。
 *
 * 这里放两件事：
 * - `build_offline_hints`：没配 Key / 模型失败时的规则化三级提示，保证离线也有提示可用；
 * - `hints_leak_answer`：检测提示有没有把答案原文抖出去。模型很爱「提示」着就把答案说了，
 *   所以这条校验不是装饰，是产品立场的守门员。
 */

/** 泄露判定窗口：连续这么多个字与答案原文重合，就认定是「把答案说了」。 */
export const LEAK_WINDOW = 6;

/** 三级提示的档位名，UI 与提示词共用一套说法。 */
export const HINT_TIERS: readonly string[] = ["知识点方向", "解题思路", "关键步骤"];

/**
 * 离线三级提示。
 * 措辞刻意通用（不假装知道具体知识点），但每一档都给出可执行的动作，而不是「再想想」。
 */
export function build_offline_hints(subject: string, topic: string): string[] {
  const subjectPart = (subject || "").trim();
  const topicPart = (topic || "").trim() || "这个知识点";
  const head = subjectPart ? `${subjectPart}·${topicPart}` : topicPart;
  return [
    `先指方向：${head} 属于哪个模块？它和哪两三个概念是连着的？先把关系说出来，不用写细节。`,
    "再给思路：把它拆成「已知条件 → 要得到什么 → 中间要用哪条定理或公式」三段，先把这三段列出来。",
    "最后给步骤：只写下第一步该做什么、第二步该做什么，先别算结果，更别急着对答案。",
  ];
}

/** 去掉空白与标点，只留内容字，避免「标点不同」被当成没泄露。 */
function normalize(text: string): string {
  return String(text ?? "")
    .replace(/[\s，。、；：！？…—～·"'（）()【】《》,.;:!?"'[\]<>/-]+/g, "")
    .toLowerCase();
}

/**
 * 找出一段提示里与答案原文重合的连续片段（找不到返回 null）。
 *
 * 用滑动窗口而不是「整段包含」：模型很少原样照抄，它会把答案揉碎了说，
 * 而连续 6 个字的原文重合已经足以把答案交代清楚。
 */
export function find_leaked_span(hint: string, answer: string): string | null {
  const answerBody = normalize(answer);
  const hintBody = normalize(hint);
  if (answerBody.length < LEAK_WINDOW || !hintBody) {
    return null;
  }
  for (let index = 0; index + LEAK_WINDOW <= answerBody.length; index += 1) {
    // 变量名不能叫 window：core 的边界测试会把它当成浏览器全局对象
    const segment = answerBody.slice(index, index + LEAK_WINDOW);
    if (hintBody.includes(segment)) {
      return segment;
    }
  }
  return null;
}

/** 三级提示里有没有任何一条泄露了答案。 */
export function hints_leak_answer(hints: readonly string[], answer: string): boolean {
  return hints.some((hint) => find_leaked_span(hint, answer) !== null);
}
