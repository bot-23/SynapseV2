/**
 * SynapseCore 单一入口（architecture.md §6）。
 * 组装 store/providers/application，导出 run（流式）、confirm、expandBlocks、
 * extractFiles、plan CRUD、conversations、settings。默认进程内直调。
 */

import type {
  Clock,
  FileExtractor,
  HttpTransport,
  IdGen,
  StreamTransport,
} from "../ports/index";
import { systemClock, systemIdGen } from "../ports/index";
import type {
  BlockPlan,
  DayBusySummary,
  ReviewItem,
  StudyPlanPayload,
  StudyPlanRequest,
  TimetableEntry,
  TimetableParseResult,
  TodayPlan,
} from "../protocol/study";
import {
  list_timetable_subjects,
  parse_timetable_text,
  summarize_day_busy,
} from "../domain/timetable";
import { REVIEW_ITEM_KEY_PREFIX, build_today_items } from "../domain/todayPlan";
import { complete_milestone } from "../domain/longPlan";
import { to_date } from "../domain/dateMath";
import {
  apply_sm2,
  create_review_item,
  daily_review_quota,
  due_review_items,
  review_key,
} from "../domain/review";
import { build_document_records } from "../domain/documentRetrieval";
import type {
  ApiResponse,
  FrontendAttachment,
  PlanProgressUpdateRequest,
  StudyPilotClarificationRequest,
  StudyPilotRunRequest,
  StudyPilotRunResponse,
} from "../protocol/frontend";
import type { CopilotStreamEvent } from "../protocol/sse";
import { apiFail, apiOk } from "../protocol/frontend";
import { KvStore, MemoryKvStore } from "../storage/kv";
import { RuntimeStore } from "../storage/runtimeStore";
import type { ProviderBundle } from "../providers/contracts";
import {
  buildProviderBundle,
  DEFAULT_PROVIDER_CONFIG,
  type ProviderConfig,
} from "../providers/build";
import { DeepSeekLlmProvider } from "../providers/deepseek";
import { ConversationService } from "./conversations";
import { extract_attachments, type IncomingFile } from "./fileExtract";
import { ProgressService } from "./progress";
import { SettingsService } from "./settings";
import { StudyPlanWorkflowService } from "./workflow";

export interface SynapseCoreOptions {
  kv?: KvStore;
  http?: HttpTransport;
  stream?: StreamTransport;
  fileExtractor?: FileExtractor;
  clock?: Clock;
  idGen?: IdGen;
  config?: Partial<ProviderConfig>;
}

export class SynapseCore {
  readonly store: RuntimeStore;
  readonly workflow: StudyPlanWorkflowService;
  readonly progress: ProgressService;
  readonly conversations: ConversationService;
  readonly settings: SettingsService;

  private readonly http?: HttpTransport;
  private readonly stream?: StreamTransport;
  private readonly fileExtractor?: FileExtractor;
  private readonly idGen: IdGen;
  private readonly clock: Clock;
  private readonly providerConfig: ProviderConfig;

  constructor(options: SynapseCoreOptions = {}) {
    const clock = options.clock ?? systemClock;
    this.idGen = options.idGen ?? systemIdGen;
    this.clock = clock;
    this.store = new RuntimeStore(options.kv ?? new MemoryKvStore(), clock);
    this.http = options.http;
    this.stream = options.stream;
    this.fileExtractor = options.fileExtractor;
    this.providerConfig = { ...DEFAULT_PROVIDER_CONFIG, ...options.config };

    this.workflow = new StudyPlanWorkflowService({
      providers: this._buildProviders(),
      store: this.store,
      idGen: this.idGen,
      clock,
    });
    this.progress = new ProgressService(this.store);
    this.conversations = new ConversationService(this.store);
    this.settings = new SettingsService(this.store);
  }

  private _buildProviders(): ProviderBundle {
    return buildProviderBundle(this.providerConfig, this.store, this.http, this.stream);
  }

  // ------------------------------------------------------------------
  // 健康 / 设置
  // ------------------------------------------------------------------

  async health(): Promise<Record<string, unknown>> {
    const deepseekEnabled =
      this.providerConfig.llmProvider === "deepseek" && Boolean(this.providerConfig.deepseekApiKey);
    let deepseekConnected = false;

    if (deepseekEnabled && this.http) {
      try {
        const provider = new DeepSeekLlmProvider(
          {
            apiKey: this.providerConfig.deepseekApiKey,
            baseUrl: this.providerConfig.deepseekBaseUrl,
            model: this.providerConfig.deepseekModel,
            maxTokens: 10,
          },
          this.http,
        );
        const resp = await provider.generateText("ping");
        deepseekConnected = Boolean(resp && resp.length > 0);
      } catch {
        deepseekConnected = false;
      }
    }

    return {
      status: "healthy",
      service: "education-agent-copilot-backend",
      llm_provider: deepseekEnabled ? "deepseek" : "mock",
      model_used: deepseekEnabled ? this.providerConfig.deepseekModel : "mock-llm",
      deepseek_enabled: deepseekEnabled,
      deepseek_connected: deepseekConnected,
    };
  }

  settingsStatus(): ApiResponse<Record<string, unknown>> {
    return apiOk(this.settings.status());
  }

  reloadProviders(): Record<string, unknown> {
    const oldInfo = this.workflow.providers.llm.describe();
    this.workflow.providers = this._buildProviders();
    const newInfo = this.workflow.providers.llm.describe();
    return {
      previous_provider: oldInfo["provider"],
      current_provider: newInfo["provider"],
      current_model: newInfo["model"],
    };
  }

  saveApiKey(apiKey: string): ApiResponse<unknown> {
    try {
      this.settings.save_api_key(apiKey);
      const info = this.reloadProviders();
      const provider = info["current_provider"];
      const model = info["current_model"];
      return apiOk(
        { provider },
        `API Key 已保存并生效（${String(provider)}/${String(model)}）`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("sk-")) {
        return apiFail(error.message);
      }
      return apiOk(null, "API Key 已保存，请重启后端服务以生效");
    }
  }

  /**
   * 校验 API Key 是否可用（引导页「即时校验」用）。
   * 用传入的 Key 直接向 DeepSeek 发一次极小请求，不改动已保存的 Key 与 provider。
   */
  async validateApiKey(apiKey: string): Promise<ApiResponse<Record<string, unknown>>> {
    const key = (apiKey || "").trim();
    if (!key) {
      return apiFail("请先填写 API Key");
    }
    if (!key.startsWith("sk-")) {
      return apiFail("API Key 格式不正确，应以 sk- 开头");
    }
    if (!this.http) {
      return apiFail("当前环境未注入网络通道，无法校验");
    }

    try {
      const provider = new DeepSeekLlmProvider(
        {
          apiKey: key,
          baseUrl: this.providerConfig.deepseekBaseUrl,
          model: this.providerConfig.deepseekModel,
          maxTokens: 8,
        },
        this.http,
      );
      const text = await provider.generateText("ping");
      return apiOk(
        { provider: "deepseek", model: this.providerConfig.deepseekModel, replied: text.length > 0 },
        "校验通过，Key 可用",
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return apiFail(`校验失败：${reason}`);
    }
  }

  getProfile(userId = "default"): ApiResponse<Record<string, unknown>> {
    return apiOk(this.settings.get_profile(userId));
  }

  saveProfile(
    userId: string,
    name: string | null,
    grade: string | null,
  ): ApiResponse<Record<string, unknown>> {
    try {
      const profile = this.settings.save_profile(userId, name, grade);
      return apiOk(profile, "用户画像已保存");
    } catch (error) {
      return apiFail(error instanceof Error ? error.message : String(error));
    }
  }

  deleteAllUserData(userId = "default"): ApiResponse<unknown> {
    try {
      this.settings.delete_all_user_data(userId);
      return apiOk(null, "所有数据已删除，请刷新页面。");
    } catch (error) {
      return apiFail(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------------
  // 会话 / 消息
  // ------------------------------------------------------------------

  listConversations(userId = "default"): ApiResponse<unknown> {
    return apiOk(this.conversations.list_conversations(userId));
  }

  saveConversation(
    conversationId: string,
    args: { title?: string; planning_mode?: string; user_id?: string },
  ): ApiResponse<unknown> {
    this.conversations.save_conversation(conversationId, {
      title: args.title ?? "新对话",
      planning_mode: args.planning_mode ?? "free",
      user_id: args.user_id ?? "default",
    });
    return apiOk(null, "对话已保存");
  }

  deleteConversation(conversationId: string): ApiResponse<unknown> {
    this.conversations.delete_conversation(conversationId);
    return apiOk(null, "对话已删除");
  }

  getMessages(conversationId: string): ApiResponse<unknown> {
    return apiOk(this.conversations.get_messages(conversationId));
  }

  saveMessage(
    conversationId: string,
    messageId: string,
    args: Parameters<ConversationService["save_message"]>[2],
  ): ApiResponse<unknown> {
    this.conversations.save_message(conversationId, messageId, args);
    return apiOk(null, "消息已保存");
  }

  // ------------------------------------------------------------------
  // Copilot 主流程
  // ------------------------------------------------------------------

  buildStudyPlan(payload: StudyPlanRequest): Promise<StudyPlanPayload> {
    return this.workflow.build_study_plan(payload);
  }

  run(payload: StudyPilotRunRequest): Promise<StudyPilotRunResponse> {
    return this.workflow.run_frontend_payload(payload);
  }

  /** 流式：事件序列与旧仓 graphs/service.py 一致（stage → stage(s) → done）。 */
  async *runStream(payload: StudyPilotRunRequest): AsyncIterable<CopilotStreamEvent> {
    yield { type: "stage", label: "正在整理你的需求……" };
    const result = await this.run(payload);
    if (result.status === "needs_clarification") {
      yield { type: "stage", label: "正在确认关键约束……" };
    } else {
      yield { type: "stage", label: "正在通过图工作流生成计划……" };
      yield { type: "stage", label: "正在整理回复与下一步动作……" };
    }
    yield { type: "done", result };
  }

  confirm(payload: StudyPilotClarificationRequest): Promise<StudyPilotRunResponse> {
    return this.workflow.submit_clarification(payload).then((response) => {
      this.workflow.persist_turn({
        conversationId: String(payload.conversationId || payload.conversation_id || "").trim(),
        inputText: this._describe_answers(payload),
        planningMode: "free",
        response,
      });
      return response;
    });
  }

  private _describe_answers(payload: StudyPilotClarificationRequest): string {
    const parts = payload.answers
      .filter((answer) => (answer.answer ?? "").trim())
      .map((answer) => `${answer.questionId}：${answer.answer.trim()}`);
    return parts.length ? `补充信息 —— ${parts.join("；")}` : "已确认澄清信息";
  }

  expandBlocks(
    normalized: StudyPlanRequest,
    blockPlan: BlockPlan,
    conversationId = "",
  ): Promise<StudyPilotRunResponse> {
    return this.workflow.expand_block_plan(normalized, blockPlan).then((response) => {
      this.workflow.persist_turn({
        conversationId,
        inputText: "确认这套积木，展开成一周计划",
        planningMode: "blocks",
        response,
      });
      return response;
    });
  }

  extractFiles(files: IncomingFile[]): Promise<FrontendAttachment[]> {
    return extract_attachments(files, this.fileExtractor ?? null, this.idGen);
  }

  getGraphSummary(): ApiResponse<Record<string, unknown>> {
    return apiOk(this.workflow.get_graph_summary(), "knowledge graph summary");
  }

  // ------------------------------------------------------------------
  // 计划存储 / 进度
  // ------------------------------------------------------------------

  savePlan(
    userId: string,
    plan: Record<string, unknown>,
    changeSummary = "",
  ): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const planDict = (plan ?? {}) as Record<string, unknown>;
      const planData = (planDict["plan"] as Record<string, unknown>) ?? {};
      const meta = this.store.save_plan(
        uid,
        String(planDict["message"] ?? ""),
        (planData["weekly_plan"] as Array<Record<string, unknown>>) ?? [],
        (planDict["blockPlan"] as Record<string, unknown>) ?? null,
        changeSummary,
      );
      return apiOk(
        { user_id: uid, version: meta.version, updated_at: meta.updated_at },
        "计划已保存",
      );
    } catch (error) {
      return apiFail(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getCurrentPlan(userId = "default"): ApiResponse<Record<string, unknown>> {
    try {
      const plan = this.store.get_plan(userId);
      if (plan) {
        return apiOk({
          plan: {
            message: plan.message ?? "",
            weekly_plan: plan.weekly_plan ?? [],
            block_plan: plan.block_plan ?? null,
            task_progress: this.progress.get_task_progress(userId),
          },
          version: plan.version,
          updated_at: plan.updated_at,
          change_summary: plan.change_summary,
          user_id: userId,
        });
      }
      return apiFail("暂无已保存的计划");
    } catch (error) {
      return apiFail(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------------
  // 已确认科目 / 计划历史版本（v2）
  // ------------------------------------------------------------------

  /** 已确认科目：记在用户身上、跨对话保留，是排程的权威来源。 */
  listSubjects(userId = "default"): ApiResponse<Record<string, unknown>> {
    try {
      const subjects = this.store.get_subjects(userId);
      return apiOk({ subjects, total: subjects.length }, `共 ${subjects.length} 个科目`);
    } catch (error) {
      return apiFail(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 移除一个已确认科目：科目表是排程的权威来源，识别错了必须能纠正。 */
  removeSubject(userId: string, name: string): ApiResponse<Record<string, unknown>> {
    try {
      const subjects = this.store.remove_subject(userId || "default", name);
      return apiOk({ subjects, total: subjects.length }, `已移除「${name}」`);
    } catch (error) {
      return apiFail(`移除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 计划历史版本（按时间正序，最新一版在最后）。 */
  listPlanVersions(userId = "default"): ApiResponse<Record<string, unknown>> {
    try {
      const versions = this.store.get_plan_versions(userId);
      return apiOk({
        versions: versions.map((item) => ({
          version: item.version,
          updated_at: item.updated_at,
          change_summary: item.change_summary,
          message: item.message,
        })),
        total: versions.length,
      });
    } catch (error) {
      return apiFail(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 回到某个历史版本：把那一版的周计划重新保存为当前计划（自增出一个新版本号）。
   * 打卡不受影响 —— 打卡按「天+科目+标题」记录，同一条目仍然对得上。
   */
  restorePlanVersion(userId: string, version: number): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const record = this.store
        .get_plan_versions(uid)
        .find((item) => item.version === version);
      if (!record) {
        return apiFail(`没有找到第 ${version} 版计划`);
      }
      const meta = this.store.save_plan(
        uid,
        record.message,
        record.weekly_plan,
        null,
        `回到第 ${version} 版`,
      );
      return apiOk(
        { user_id: uid, version: meta.version, updated_at: meta.updated_at },
        `已回到第 ${version} 版（当前为第 ${meta.version} 版）`,
      );
    } catch (error) {
      return apiFail(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------------
  // 长期计划 / 今日计划（v2 三层计划）
  // ------------------------------------------------------------------

  getLongTermPlan(userId = "default"): ApiResponse<Record<string, unknown>> {
    try {
      const plan = this.store.get_long_plan(userId);
      if (!plan) {
        return apiFail("还没有长期计划");
      }
      return apiOk({
        long_plan: plan,
        active: this.workflow.get_active_milestone(userId),
      });
    } catch (error) {
      return apiFail(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 划分长期阶段。
   * 跨度不足一周、或截止日期无法识别时**明确失败** —— 不会把一周的计划硬说成长期计划。
   */
  async buildLongTermPlan(
    userId: string,
    goal: string,
    deadline: string,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    try {
      const uid = userId || "default";
      const payload = this._plan_request_for(
        uid,
        (goal || "").trim() || "长期学习目标",
        (deadline || "").trim() || null,
      );
      const plan = await this.workflow.build_long_term_plan(
        payload,
        this.workflow.get_confirmed_subjects(uid),
        payload.learning_goal,
      );
      if (!plan) {
        return apiFail("这个目标的跨度不足一周，或截止日期无法识别；给一个更远的日期再试。");
      }
      return apiOk(
        { long_plan: plan, active: this.workflow.get_active_milestone(uid) },
        `已划分为 ${plan.milestones.length} 个阶段`,
      );
    } catch (error) {
      return apiFail(`生成失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  completeMilestone(userId: string, milestoneId: string): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const plan = this.store.get_long_plan(uid);
      if (!plan) {
        return apiFail("还没有长期计划");
      }
      const saved = this.store.save_long_plan(uid, {
        goal: plan.goal,
        deadline: plan.deadline,
        subjects: plan.subjects,
        milestones: complete_milestone(plan.milestones, milestoneId),
      });
      return apiOk(
        { long_plan: saved, active: this.workflow.get_active_milestone(uid) },
        "阶段已完成",
      );
    } catch (error) {
      return apiFail(`更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 按某个阶段排一版本周计划（显式动作，不会在对话里自动触发）。 */
  async planForMilestone(
    userId: string,
    milestoneId: string,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    try {
      const uid = userId || "default";
      const longPlan = this.store.get_long_plan(uid);
      const milestone = longPlan?.milestones.find((item) => item.id === milestoneId);
      if (!milestone) {
        return apiFail("没有找到这个阶段");
      }
      const plan = await this.workflow.build_study_plan(
        this._plan_request_for(uid, milestone.goal, milestone.due_date || null),
      );
      const meta = this.store.save_plan(
        uid,
        plan.final_message,
        plan.weekly_plan as unknown as Array<Record<string, unknown>>,
        null,
        `按阶段「${milestone.title}」重排本周`,
      );
      return apiOk(
        { version: meta.version, updated_at: meta.updated_at, weekly_plan: plan.weekly_plan },
        `已按「${milestone.title}」排好本周计划`,
      );
    } catch (error) {
      return apiFail(`生成失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 今日计划（待办列表）。
   * 同一天内幂等：反复打开不会重复顺延、也不会丢状态；跨天才重建一次。
   */
  getTodayPlan(userId = "default"): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const today = to_date(this.clock.nowIso());
      const savedPlan = this.store.get_plan(uid);
      const planVersion = savedPlan ? Math.max(0, Math.trunc(savedPlan.version ?? 0)) : 0;

      const record = this.store.get_today(uid);
      // 同一天内若计划版本变了（比如刚在对话里重新生成），缓存必须作废重建，
      // 否则「今日」会一直停在没有计划时算出来的那份空列表。
      if (record && record.date === today && record.plan_version === planVersion) {
        return apiOk(this._today_payload(uid, record), "今日计划已就绪");
      }

      const days = savedPlan ? this.workflow.normalize_saved_days(savedPlan.weekly_plan) : [];
      const lastDayIndex = days.length ? Math.max(...days.map((day) => day.day_index)) : 0;
      const dayIndex = savedPlan
        ? this.workflow.current_day_index(savedPlan.start_date, lastDayIndex)
        : 0;
      const saved = this.store.save_today(uid, {
        date: today,
        day_index: dayIndex,
        plan_version: planVersion,
        items: build_today_items({
          days,
          dayIndex,
          previousItems: record?.items ?? [],
          previousDate: record?.date ?? "",
          today,
          dueReviews: this._due_reviews_for_today(uid, today),
        }),
      });
      return apiOk(this._today_payload(uid, saved), "今日计划已更新");
    } catch (error) {
      return apiFail(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 勾选今日条目。进度写进统一存储，所以今日页与短期计划的勾选是同一份数据。 */
  toggleTodayItem(userId: string, key: string): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const record = this._ensure_today(uid);
      const target = record.items.find((item) => item.key === key);
      if (!target) {
        return apiFail("今日计划里没有这一条");
      }
      const done = !target.done;
      if (key.startsWith(REVIEW_ITEM_KEY_PREFIX)) {
        // 复习条目：勾选 = 记得（SM-2 评分 4）
        const reviewId = key.slice(REVIEW_ITEM_KEY_PREFIX.length);
        if (done) {
          this.reviewItem(uid, reviewId, 4);
        } else {
          this._reschedule_review_today(uid, reviewId, record.date);
        }
      } else {
        this.progress.update_task_progress({
          userId: uid,
          taskKey: key,
          done,
          taskTitle: target.title,
          taskType: target.task_type,
          actualMinutes: target.duration_minutes,
        });
        if (done) {
          this._enqueue_review(uid, target.subject, target.title, target.task_type);
        }
      }
      const saved = this.store.save_today(uid, {
        date: record.date,
        day_index: record.day_index,
        plan_version: record.plan_version,
        items: record.items.map((item) => (item.key === key ? { ...item, done } : item)),
      });
      return apiOk(this._today_payload(uid, saved), done ? "已标记完成" : "已取消完成");
    } catch (error) {
      return apiFail(`更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  addTodayItem(
    userId: string,
    item: { title: string; subject?: string; durationMinutes?: number },
  ): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const title = (item.title || "").trim();
      if (!title) {
        return apiFail("请填写今天要做的事");
      }
      const record = this._ensure_today(uid);
      const saved = this.store.save_today(uid, {
        date: record.date,
        day_index: record.day_index,
        plan_version: record.plan_version,
        items: [
          ...record.items,
          {
            key: `manual::${this.idGen.next()}`,
            title,
            subject: (item.subject || "").trim() || "未分类",
            task_type: "learn",
            duration_minutes: Math.max(5, Math.min(720, Math.trunc(item.durationMinutes || 30))),
            done: false,
            carried_from: "",
            manual: true,
          },
        ],
      });
      return apiOk(this._today_payload(uid, saved), "已加入今日");
    } catch (error) {
      return apiFail(`添加失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  removeTodayItem(userId: string, key: string): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const record = this._ensure_today(uid);
      const saved = this.store.save_today(uid, {
        date: record.date,
        day_index: record.day_index,
        plan_version: record.plan_version,
        items: record.items.filter((item) => item.key !== key),
      });
      return apiOk(this._today_payload(uid, saved), "已移出今日");
    } catch (error) {
      return apiFail(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------------
  // 复习队列（v2 间隔重复，完全本地）
  // ------------------------------------------------------------------

  listReviews(userId = "default"): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const today = to_date(this.clock.nowIso());
      const items = this.store.get_reviews(uid);
      const due = due_review_items(items, today);
      return apiOk({
        items,
        due,
        due_count: due.length,
        total: items.length,
        today,
      });
    } catch (error) {
      return apiFail(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 手动加一个要复习的知识点（不经过对话与计划）。 */
  addReviewTopic(
    userId: string,
    subject: string,
    topic: string,
  ): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const text = (topic || "").trim();
      if (!text) {
        return apiFail("请填写要复习的知识点");
      }
      const items = this.store.get_reviews(uid);
      if (items.some((item) => item.key === review_key(subject, text))) {
        return apiFail("这个知识点已经在复习队列里了");
      }
      const created = create_review_item({
        id: this.idGen.next(),
        subject,
        topic: text,
        today: to_date(this.clock.nowIso()),
      });
      const saved = this.store.save_reviews(uid, [...items, created]);
      return apiOk({ items: saved }, "已加入复习队列，明天首次复习");
    } catch (error) {
      return apiFail(`添加失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  removeReviewItem(userId: string, itemId: string): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const saved = this.store.save_reviews(
        uid,
        this.store.get_reviews(uid).filter((item) => item.id !== itemId),
      );
      return apiOk({ items: saved }, "已移出复习队列");
    } catch (error) {
      return apiFail(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 复习打卡：按 0..5 评分推进 SM-2（≥3 算记住）。 */
  reviewItem(userId: string, itemId: string, grade: number): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const items = this.store.get_reviews(uid);
      const target = items.find((item) => item.id === itemId);
      if (!target) {
        return apiFail("复习队列里没有这一条");
      }
      const updated = apply_sm2(target, grade, to_date(this.clock.nowIso()));
      const saved = this.store.save_reviews(
        uid,
        items.map((item) => (item.id === itemId ? updated : item)),
      );
      return apiOk(
        { items: saved, item: updated },
        `下次复习：${updated.due_date}（${updated.interval_days} 天后）`,
      );
    } catch (error) {
      return apiFail(`更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 今天该排的复习项：按到期日排序，并限制每天条数。
   * 上限很关键 —— 积压一次全堆上来，计划就一定做不完，整个系统就废了。
   */
  private _due_reviews_for_today(userId: string, today: string): ReviewItem[] {
    const due = due_review_items(this.store.get_reviews(userId), today);
    if (!due.length) {
      return [];
    }
    const minutes = Math.trunc(
      Number(this.store.get_profile(userId)["preferred_daily_minutes"] ?? 0),
    );
    const quota = daily_review_quota(due.length, minutes > 0 ? minutes : 60);
    return due.slice(0, quota).map((item) => ({ ...item }));
  }

  /**
   * 完成学习类任务 → 自动进入复习队列（间隔重复闭环）。
   * 已在队列里的不动 —— 否则每次打卡都会把间隔与难度重置，SM-2 就失效了。
   */
  private _enqueue_review(userId: string, subject: string, title: string, taskType: string): void {
    if (taskType !== "learn" && taskType !== "practice") {
      return;
    }
    const topic = (title || "").trim();
    if (!topic) {
      return;
    }
    const items = this.store.get_reviews(userId);
    if (items.some((item) => item.key === review_key(subject, topic))) {
      return;
    }
    this.store.save_reviews(userId, [
      ...items,
      create_review_item({
        id: this.idGen.next(),
        subject,
        topic,
        today: to_date(this.clock.nowIso()),
      }),
    ]);
  }

  /** 取消复习打卡：把到期日拉回今天让它还能再出现；不回退难度，避免反复横跳。 */
  private _reschedule_review_today(userId: string, itemId: string, today: string): void {
    const items = this.store.get_reviews(userId);
    if (!items.some((item) => item.id === itemId)) {
      return;
    }
    this.store.save_reviews(
      userId,
      items.map((item) => (item.id === itemId ? { ...item, due_date: today } : item)),
    );
  }

  // ------------------------------------------------------------------
  // 资料库（v2：粘贴导入 + BM25 本地检索）
  // ------------------------------------------------------------------

  /** 导入一份资料（粘贴文本）。切片与检索全在本地完成，不需要联网，也不需要额外服务。 */
  importDocument(userId: string, name: string, text: string): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const content = (text || "").trim();
      if (!content) {
        return apiFail("资料内容为空");
      }
      const records = build_document_records(uid, [
        {
          id: this.idGen.next(),
          name: (name || "").trim() || "未命名资料",
          extracted_text: content,
        },
      ]);
      if (!records.length) {
        return apiFail("没能从这段内容里切出可检索的片段");
      }
      const saved = this.store.save_documents(
        uid,
        records as unknown as Array<Record<string, unknown>>,
      );
      const first = records[0]!;
      return apiOk(
        { documents: saved },
        `已导入「${first.file_name}」，切出 ${first.chunks.length} 段`,
      );
    } catch (error) {
      return apiFail(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  listDocuments(userId = "default"): ApiResponse<Record<string, unknown>> {
    try {
      const documents = this.store.get_documents(userId).map((doc) => ({
        doc_id: String(doc["doc_id"] ?? ""),
        file_name: String(doc["file_name"] ?? "未命名资料"),
        excerpt: String(doc["excerpt"] ?? ""),
        chunk_count: Array.isArray(doc["chunks"]) ? (doc["chunks"] as unknown[]).length : 0,
      }));
      return apiOk({ documents, total: documents.length });
    } catch (error) {
      return apiFail(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  removeDocument(userId: string, docId: string): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const remaining = this.store.delete_document(uid, docId);
      return apiOk({ total: remaining.length }, "资料已删除");
    } catch (error) {
      return apiFail(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private _ensure_today(userId: string): TodayPlan {
    const result = this.getTodayPlan(userId);
    const data = (result.data ?? {}) as Record<string, unknown>;
    return data["today"] as TodayPlan;
  }

  /** 今日计划的数据体：done 以统一的进度存储为准，保证与短期计划一致。 */
  private _today_payload(userId: string, record: TodayPlan): Record<string, unknown> {
    const progress = this.progress.get_task_progress(userId);
    const items = record.items.map((item) => ({
      ...item,
      done: progress[item.key] ?? item.done,
    }));
    return {
      today: { ...record, items },
      total: items.length,
      done_count: items.filter((item) => item.done).length,
    };
  }

  /** 组装一个计划请求（长期阶段排课、今日切片复用画像里的时长偏好）。 */
  private _plan_request_for(
    userId: string,
    learningGoal: string,
    deadline: string | null,
  ): StudyPlanRequest {
    const profile = this.store.get_profile(userId);
    const minutes = Math.trunc(Number(profile["preferred_daily_minutes"] ?? 0));
    const weakPoints = Array.isArray(profile["weak_points"])
      ? (profile["weak_points"] as unknown[]).map((item) => String(item)).filter((item) => item)
      : [];
    return {
      user_id: userId,
      current_level: String(profile["current_level"] ?? "未填写"),
      learning_goal: learningGoal,
      available_days_per_week: 5,
      available_minutes_per_day: minutes > 0 ? minutes : 60,
      deadline,
      weak_points: weakPoints.slice(0, 4),
      preferences: [],
      need_user_confirmation: false,
    };
  }

  // ------------------------------------------------------------------
  // 课程表（v2）
  // ------------------------------------------------------------------

  /** 解析粘贴的课表文本（纯解析，不落库），返回结构化条目与未识别行供手动校正。 */
  parseTimetable(text: string): ApiResponse<TimetableParseResult> {
    try {
      const result = parse_timetable_text(text, { idGen: this.idGen });
      return apiOk(result, `识别出 ${result.entries.length} 节课`);
    } catch (error) {
      return apiFail(`解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getTimetable(userId = "default"): ApiResponse<Record<string, unknown>> {
    try {
      const entries = this.store.get_timetable(userId);
      const days: DayBusySummary[] = [];
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        days.push(summarize_day_busy(entries, weekday));
      }
      return apiOk({
        entries,
        days,
        subjects: list_timetable_subjects(entries),
        total: entries.length,
      });
    } catch (error) {
      return apiFail(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 覆盖保存整份课程表（手动录入/校正后调用）。 */
  saveTimetable(
    userId: string,
    entries: TimetableEntry[],
  ): ApiResponse<Record<string, unknown>> {
    try {
      const uid = userId || "default";
      const normalized = entries
        .map((entry) => ({
          ...entry,
          id: entry.id || this.idGen.next(),
          name: (entry.name || "").trim(),
          subject: (entry.subject || entry.name || "").trim(),
          weekday: Math.max(1, Math.min(7, Math.trunc(entry.weekday || 1))),
          startMinute: Math.max(0, Math.min(24 * 60, Math.trunc(entry.startMinute || 0))),
          endMinute: Math.max(0, Math.min(24 * 60, Math.trunc(entry.endMinute || 0))),
        }))
        .filter((entry) => entry.name && entry.endMinute > entry.startMinute);
      const saved = this.store.save_timetable(uid, normalized);
      return apiOk({ entries: saved, total: saved.length }, `已保存 ${saved.length} 节课`);
    } catch (error) {
      return apiFail(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  addTimetableEntry(
    userId: string,
    entry: Omit<TimetableEntry, "id"> & { id?: string },
  ): ApiResponse<Record<string, unknown>> {
    const current = this.store.get_timetable(userId || "default");
    return this.saveTimetable(userId, [...current, { ...entry, id: entry.id ?? "" }]);
  }

  removeTimetableEntry(
    userId: string,
    entryId: string,
  ): ApiResponse<Record<string, unknown>> {
    const current = this.store.get_timetable(userId || "default");
    return this.saveTimetable(
      userId,
      current.filter((entry) => entry.id !== entryId),
    );
  }

  updatePlanProgress(body: PlanProgressUpdateRequest): ApiResponse<Record<string, unknown>> {
    try {
      const data = {
        task_progress: this.progress.update_task_progress({
          userId: body.user_id,
          conversationId: body.conversation_id,
          planId: body.plan_id,
          planVersion: body.plan_version,
          taskKey: body.task_key,
          done: body.done,
          taskTitle: body.task_title,
          taskType: body.task_type,
          actualMinutes: body.actual_minutes,
          planMessage: body.plan_message,
        }),
      };
      if (body.done) {
        // 完成学习类任务 → 进入复习队列（间隔重复闭环）
        this._enqueue_review(
          body.user_id || "default",
          body.subject ?? "",
          body.task_title,
          body.task_type,
        );
      }
      return apiOk(data, "进度已更新");
    } catch (error) {
      return apiFail(`进度更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function createSynapseCore(options: SynapseCoreOptions = {}): SynapseCore {
  return new SynapseCore(options);
}
