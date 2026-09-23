/**
 * 科目推断（纯函数，零依赖，离线可用）。
 *
 * 两个用途：
 * - `infer_subject_from_text`：从学习目标句里取科目。提取自 progress.ts 的私有
 *   `_infer_subject`，语义逐字保留，原调用点改为引用这里，行为不变。
 * - `detect_document_subject`：从资料文件名与正文里用关键词表判断科目，
 *   供导入资料时自动填 `subject`。不依赖任何模型，没配 Key 也能用。
 */

/**
 * 从文本推断科目（旧行为：先看「复习/学习/准备」等前缀后的内容，再退回计划 focus）。
 */
export function infer_subject_from_text(text: string, fallbackFocus = ""): string {
  let subject = "通用";
  for (const prefix of ["我要复习", "复习", "学习", "准备"]) {
    if (text.includes(prefix)) {
      subject =
        text
          .slice(text.indexOf(prefix) + prefix.length)
          .replace(/^[。，. ]+|[。，. ]+$/g, "")
          .slice(0, 20) || "通用";
      break;
    }
  }
  if (subject !== "通用") {
    return subject;
  }
  if (fallbackFocus) {
    return fallbackFocus.split("入门")[0]!.split("专项")[0]!.split("综合")[0]!.trim() || "通用";
  }
  return "通用";
}

/**
 * 学科关键词表。
 * 表内顺序即同分时的优先级（前面的优先），保证结果稳定可复现。
 */
const SUBJECT_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "数学",
    [
      "数学", "函数", "导数", "积分", "极限", "数列", "圆锥曲线", "三角函数",
      "方程", "几何", "概率", "向量", "不等式", "单调性", "错题",
    ],
  ],
  ["物理", ["物理", "力学", "受力", "动量", "电磁", "光学", "热学", "牛顿", "加速度", "电路"]],
  ["化学", ["化学", "元素", "化学键", "摩尔", "酸碱", "氧化", "有机", "无机"]],
  ["生物", ["生物", "细胞", "遗传", "基因", "光合", "生态", "酶"]],
  [
    "英语",
    ["英语", "单词", "词汇", "语法", "听力", "写作", "四级", "六级", "雅思", "托福", "english", "unit"],
  ],
  ["语文", ["语文", "作文", "文言文", "古诗", "修辞", "阅读理解"]],
  ["历史", ["历史", "朝代", "史实", "近代史", "改革"]],
  ["地理", ["地理", "气候", "地形", "洋流", "经纬"]],
  ["政治", ["政治", "哲学", "经济学", "政治学", "唯物"]],
  [
    "计算机",
    ["计算机", "算法", "数据结构", "操作系统", "网络", "编程", "数据库", "代码", "进程", "指针"],
  ],
];

/**
 * 从一句话里判断科目（只看正文，没有文件名加权）。
 * 作业句（「数学第三章习题1-20明天交」）用它填科目；判不出返回空串，不硬猜。
 *
 * 平分时的兜底：先被提到的那个科目优先。「化学方程式默写20个」里「数学」命中
 * 「方程」、「化学」命中「化学」，各 1 分；只看表序会把化学作业塞进数学。
 */
export function detect_subject_from_text(text: string): string {
  const body = String(text ?? "").toLowerCase();
  if (!body) {
    return "";
  }
  let best = "";
  let bestScore = 0;
  let bestIndex = Number.MAX_SAFE_INTEGER;
  for (const [subject, keywords] of SUBJECT_KEYWORDS) {
    let score = 0;
    let firstIndex = Number.MAX_SAFE_INTEGER;
    for (const keyword of keywords) {
      const at = body.indexOf(keyword.toLowerCase());
      if (at >= 0) {
        score += 1;
        if (at < firstIndex) {
          firstIndex = at;
        }
      }
    }
    if (score > bestScore || (score > 0 && score === bestScore && firstIndex < bestIndex)) {
      bestScore = score;
      bestIndex = firstIndex;
      best = subject;
    }
  }
  return best;
}

/**
 * 从资料的文件名与正文判断科目。
 *
 * 文件名命中权重更高（3 分 vs 1 分）——「高三数学错题笔记.txt」这类命名本身就带科目，
 * 比正文里偶然出现的词更可靠。都不命中时返回空串，不硬猜。
 */
export function detect_document_subject(fileName: string, text: string): string {
  const name = String(fileName ?? "").toLowerCase();
  const body = String(text ?? "").slice(0, 4000).toLowerCase();
  if (!name && !body) {
    return "";
  }
  let best = "";
  let bestScore = 0;
  for (const [subject, keywords] of SUBJECT_KEYWORDS) {
    let score = 0;
    for (const keyword of keywords) {
      const needle = keyword.toLowerCase();
      if (name.includes(needle)) {
        score += 3;
      }
      if (body.includes(needle)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = subject;
    }
  }
  return best;
}
