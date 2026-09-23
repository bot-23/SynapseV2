/**
 * 学情周报服务（G3）。
 *
 * 职责边界：
 * - 数字：全部交给 `domain/weeklyReport.ts` 的纯函数离线算，模型一个数字都不许碰。
 * - 叙述：有模型 Key 时让模型把统计写成一段人话；没 Key 或调用失败就用模板拼真实数字。
 * - 落库：`reports:{userId}`，只保留最近 8 期。
 */

import type { WeeklyReport, WeeklyReportStats } from "../protocol/study";
import {
  REPORT_HISTORY_LIMIT,
  build_offline_narrative,
  summarize_weekly_report,
  truncate_narrative,
} from "../domain/weeklyReport";
import { to_date } from "../domain/dateMath";
import type { Clock, IdGen } from "../ports/index";
import { systemClock, systemIdGen } from "../ports/index";
import type { LlmProvider } from "../providers/contracts";
import type { RuntimeStore } from "../storage/runtimeStore";
import { buildWeeklyReportPrompt } from "./prompts";

export class ReportService {
  constructor(
    private readonly store: RuntimeStore,
    private readonly llm: LlmProvider,
    private readonly clock: Clock = systemClock,
    private readonly idGen: IdGen = systemIdGen,
  ) {}

  today(): string {
    return to_date(this.clock.nowIso());
  }

  /**
   * 汇总本周统计。
   *
   * 只读：逾期数由 `due_date < 今天` 现算，不落库 —— 生成一份周报不该改变任何业务数据。
   */
  collect_stats(userId: string): WeeklyReportStats {
    const uid = userId || "default";
    const today = this.today();
    return summarize_weekly_report({
      progress: this.store.get_progress(uid),
      assessments: this.store.get_assessments(),
      reviews: this.store.get_reviews(uid),
      assignments: this.store.get_assignments(uid),
      today,
    });
  }

  /** 生成本周周报并入库。模型只写叙述，写不出来就降级成模板。 */
  async generate(userId: string): Promise<WeeklyReport> {
    const uid = userId || "default";
    const stats = this.collect_stats(uid);

    let narrative = "";
    const llmInfo = this.llm.describe();
    if (llmInfo["provider"] === "deepseek") {
      try {
        const raw = await this.llm.generateText(buildWeeklyReportPrompt(stats));
        narrative = truncate_narrative(raw);
      } catch {
        // 模型调用失败：静默落到离线模板，用户依然拿得到这份周报
      }
    }
    const degraded = !narrative;
    if (degraded) {
      narrative = build_offline_narrative(stats);
    }

    const report: WeeklyReport = {
      id: this.idGen.next(),
      user_id: uid,
      created_at: this.clock.nowIso(),
      stats,
      narrative,
      degraded,
    };
    this._append(uid, report);
    return report;
  }

  /** 周报历史（最新一期在最后）。 */
  list(userId: string): WeeklyReport[] {
    return this.store.get_reports(userId || "default");
  }

  /** 最新一期；没生成过返回 null。 */
  latest(userId: string): WeeklyReport | null {
    const rows = this.list(userId);
    return rows.length ? rows[rows.length - 1]! : null;
  }

  /** 追加并裁剪到最近 8 期 —— 周报是「当下有用」的东西，不需要留档一年。 */
  private _append(userId: string, report: WeeklyReport): void {
    const rows = [...this.store.get_reports(userId), report];
    this.store.save_reports(userId, rows.slice(-REPORT_HISTORY_LIMIT));
  }
}
