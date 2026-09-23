/**
 * 学习计划工作流服务（用例编排）。
 * 翻译自 Synapse/backend/app/services/workflow.py（约 1900 行），
 * 意图判断/工具分发/澄清状态机/计划生成与微调，语义逐字保留。
 * 差异：LLM 调用异步化（HTTP 经壳注入 transport）；debug_log 调用不移植。
 */

import {
  build_document_records,
  search_document_records,
} from "../domain/documentRetrieval.js";
import { build_plan_adjustment } from "../domain/planAdjuster.js";
import { fit_tasks_to_minutes } from "../domain/planFit.js";
import { add_days, days_between, to_date } from "../domain/dateMath.js";
import {
  LONG_TERM_THRESHOLD_DAYS,
  build_rule_milestones,
  pick_active_milestone,
} from "../domain/longPlan.js";
import {
  append_subjects_to_days,
  detect_subject_candidates,
  detect_subjects,
  merge_subject_plans,
  sanitize_subject_candidate,
} from "../domain/multiSubject.js";
import { apply_timetable_to_payload, build_timetable_context } from "../domain/timetable.js";
import { assignment_countdown, looks_like_assignment } from "../domain/assignment.js";
import {
  allocate_context_budget,
  collect_document_hits,
  type ParsedDocumentHit,
} from "../domain/contextBudget.js";
import { BlockPlanService } from "../domain/blockPlans.js";
import { RulePlanService } from "../domain/rulePlans.js";
import { pyInt, pyTruncInt } from "../domain/pyCompat.js";
import type { Clock, IdGen } from "../ports/index.js";
import { systemClock, systemIdGen } from "../ports/index.js";
import type {
  BlockPlan,
  LongTermPlan,
  Milestone,
  StudyDayPlan,
  StudyPlanPayload,
  StudyPlanRequest,
  StudyTask,
  TaskType,
  WorkflowStageResult,
} from "../protocol/study.js";
import type {
  ClarificationAnswer,
  ClarificationPrompt,
  ClarificationQuestion,
  FrontendAttachment,
  FrontendMemory,
  FrontendUserProfile,
  StudyPilotClarificationRequest,
  StudyPilotRunRequest,
  StudyPilotRunResponse,
} from "../protocol/frontend.js";
import type { ProviderBundle } from "../providers/contracts.js";
import type { RuntimeStore } from "../storage/runtimeStore.js";
import { ALL_TOOLS, toOpenaiTools } from "./tools.js";
import { AssignmentService } from "./assignmentService.js";
import { HintService } from "./hintService.js";
import { ReportService } from "./reportService.js";
import {
  buildConversationalReplyPrompt,
  buildIntentPrompt,
  buildLongTermPlanPrompt,
  buildMultiSubjectIntroPrompt,
  buildPlanPrompt,
  buildRememberRetryPrompt,
  buildRulePlanMessagePrompt,
  buildTeachPrompt,
} from "./prompts.js";

export interface PendingClarificationSession {
  normalized_payload: StudyPlanRequest;
  request_echo: Record<string, unknown>;
  memories: FrontendMemory[];
  planning_mode: string;
  /**
   * v2：作业式计划的澄清会话。
   * 非空表示这轮 pending 的是「作业没解析出来」，用户在澄清卡里补的信息
   * 会拼回原文重新解析，而不是走学习计划的生成链路。
   */
  assignment_text?: string;
}

type LlmIntentResult = { function: string; params: Record<string, unknown> } & Record<
  string,
  unknown
>;

const EMOTION_KEYWORDS = [
  "焦虑", "烦躁", "挫败", "崩溃", "好难", "不想学", "学不进去", "学不明白",
  "累了", "没救了", "完蛋了", "害怕", "紧张", "难受", "压力大", "迷茫", "想哭",
];

export interface WorkflowDeps {
  providers: ProviderBundle;
  store: RuntimeStore;
  idGen?: IdGen;
  clock?: Clock;
}

interface PlanGeneration {
  weekly_plan: StudyDayPlan[];
  final_message: string;
  next_actions: string[];
  status: "done" | "fallback";
  summary: string;
}

export class StudyPlanWorkflowService {
  providers: ProviderBundle;
  readonly runtime_store: RuntimeStore;
  private readonly idGen: IdGen;
  private readonly clock: Clock;
  private readonly pending_sessions = new Map<string, PendingClarificationSession>();
  private readonly rule_plan_service = new RulePlanService();
  private readonly block_plan_service: BlockPlanService;
  /**
   * 本轮请求中模型不可达的原因（网络被拦截、超时等）。
   * 非空时本轮跳过模型调用直接用规则计划，避免用户连吃两次超时。
   */
  private _llmUnreachableReason = "";

  constructor(deps: WorkflowDeps) {
    this.providers = deps.providers;
    this.runtime_store = deps.store;
    this.idGen = deps.idGen ?? systemIdGen;
    this.clock = deps.clock ?? systemClock;
    this.block_plan_service = new BlockPlanService({
      infer_topic: (goal, weakPoints) => this.rule_plan_service.infer_topic(goal, weakPoints),
      short_goal: (text, limit) => this.rule_plan_service.short_goal(text, limit),
      duration: (daily, ratio) => this.rule_plan_service.duration(daily, ratio),
    });
  }

  /**
   * v2：作业式计划服务。
   * 每次取用时新建（服务本身无状态），这样 `providers` 被替换后（测试或运行中换 Key）
   * 拿到的一定是当前生效的模型，不会抓着构造时的旧引用。
   */
  get assignment_service(): AssignmentService {
    return new AssignmentService(this.runtime_store, this.providers.llm, this.clock, this.idGen);
  }

  /**
   * G2：苏格拉底提示服务。
   * 同样每次取用时新建，理由与 `assignment_service` 一致：绝不能抓着构造时的旧模型引用。
   */
  get hint_service(): HintService {
    return new HintService(this.runtime_store, this.providers.llm);
  }

  /** G3：学情周报服务。同样每次取用新建，保证拿到的一定是当前生效的模型。 */
  get report_service(): ReportService {
    return new ReportService(this.runtime_store, this.providers.llm, this.clock, this.idGen);
  }

  async build_study_plan(
    payload: StudyPlanRequest,
    retrievedContext: string[] | null = null,
  ): Promise<StudyPlanPayload> {
    const learnerProfile = this._analyze_request(payload);
    const stages: WorkflowStageResult[] = [
      {
        stage: "analyze",
        status: "done",
        summary: "已完成输入标准化和学习目标解析。",
      },
      {
        stage: "confirm",
        status: payload.need_user_confirmation ? "needs_user_confirmation" : "done",
        summary: "建议把解析结果回显给用户，允许用户修改重点、节奏和目标优先级。",
      },
    ];

    const context = retrievedContext ?? this._build_hybrid_context(payload);
    stages.push({
      stage: "retrieve",
      status: "done",
      summary:
        "已完成混合检索，包含知识图谱、用户资料、历史偏好与执行记录。" +
        ` 当前检索源：${String(this.providers.retrieval.describe()["provider"] ?? "unknown")}。`,
    });

    const orderingHint = this.providers.calendar.checkDeadline(payload.deadline);
    stages.push({
      stage: "decompose_and_rank",
      status: "done",
      summary: `已按先知识梳理、再练习、最后回顾的顺序拆解任务。${orderingHint}`,
    });

    const generation = await this._generate_plan_result(payload, context);
    stages.push({
      stage: "generate_plan",
      status: generation.status,
      summary: generation.summary,
    });

    stages.push({
      stage: "self_reflect",
      status: "done",
      summary: "已做一轮规则校验：每天时长受限、包含复习闭环、弱项优先覆盖。",
    });

    const reminder = this.providers.notifier.buildReminder("建议在每次学习开始前 10 分钟提醒。");
    stages.push({
      stage: "report",
      status: "done",
      summary: "已封装最终输出，语气偏鼓励型，适合直接展示给前端。",
    });

    const finalMessage =
      generation.final_message ||
      `我已根据你的目标「${this._short_goal(payload.learning_goal)}」整理了一版计划。${reminder}`;

    const nextActions = generation.next_actions.length
      ? generation.next_actions
      : ["允许用户确认或修改解析结果", "接入真实课程资料检索", "把计划同步到日历或提醒系统"];

    return {
      learner_profile: learnerProfile,
      retrieved_context: context,
      stages,
      weekly_plan: generation.weekly_plan,
      final_message: finalMessage,
      next_actions: nextActions,
    };
  }

  get_graph_summary(): Record<string, unknown> {
    return this.providers.retrieval.describe();
  }

  /**
   * 主流程入口（v2）。
   * 若传入 conversationId：按该会话读取多轮历史，并在本轮结束后把问答写入会话消息，
   * 保证「模型看到的历史」与「界面显示的历史」一致。
   * 不传 conversationId：保持旧行为（既不读也不写会话），旧黄金样本不受影响。
   */
  async run_frontend_payload(payload: StudyPilotRunRequest): Promise<StudyPilotRunResponse> {
    this._llmUnreachableReason = "";
    const response = await this._run_frontend_payload_inner(payload);
    this.persist_turn({
      conversationId: this._conversation_id_of(payload),
      inputText: this._payload_input(payload),
      attachments: payload.files,
      planningMode: this._payload_mode(payload),
      response,
    });
    return response;
  }

  private _conversation_id_of(payload: StudyPilotRunRequest): string {
    return String(payload.conversationId || payload.conversation_id || "").trim();
  }

  /**
   * 把一轮问答写入会话（run / confirm / expand 三条路径共用）。
   * conversationId 为空时不写，保持「未接会话」的旧行为。
   */
  persist_turn(params: {
    conversationId: string;
    inputText: string;
    attachments?: FrontendAttachment[];
    planningMode?: string;
    response: StudyPilotRunResponse;
  }): void {
    const { conversationId, inputText, attachments = [], response } = params;
    if (!conversationId) {
      return;
    }

    try {
      const existing = this.runtime_store
        .list_conversations("default")
        .find((item) => item.id === conversationId);
      if (!existing) {
        const title = this._short_goal(inputText || "新对话", 16);
        this.runtime_store.save_conversation(
          conversationId,
          "default",
          title,
          "通用",
          params.planningMode ?? "free",
        );
      }

      this.runtime_store.save_message(this.idGen.next(), conversationId, "user", inputText, {
        attachments_json: attachments.length
          ? JSON.stringify(attachments.map((file) => file.name))
          : null,
      });

      this.runtime_store.save_message(
        this.idGen.next(),
        conversationId,
        "assistant",
        response.message,
        {
          plan_data_json: response.plan
            ? JSON.stringify({
                weekly_plan: response.plan.weekly_plan,
                retrieved_context: response.plan.retrieved_context,
              })
            : null,
          request_context_json: JSON.stringify({
            mode: response.mode,
            status: response.status,
            blockPlan: response.blockPlan,
            // 完整保存澄清会话，界面重建时可直接继续作答
            clarification: response.clarification,
            // 保存归一化后的请求，界面重建后仍可对积木计划执行「展开成一周」
            normalized:
              ((response.request as Record<string, unknown>)?.["normalized"] as unknown) ?? null,
          }),
          response_mode: response.mode,
          reason: response.reason || null,
          next_steps_json: response.next_steps.length
            ? JSON.stringify(response.next_steps)
            : null,
        },
      );
    } catch (error) {
      console.error("[Synapse] 会话落库失败", error);
    }
  }

  private async _run_frontend_payload_inner(
    payload: StudyPilotRunRequest,
  ): Promise<StudyPilotRunResponse> {
    const normalizedPayload = this._normalize_frontend_payload(payload);
    const requestEcho = this._build_request_echo(payload, normalizedPayload);

    const planningMode = this._payload_mode(payload);
    const memories = this._active_memories(payload.memories);

    const userProfile = this.runtime_store.get_profile(normalizedPayload.user_id);
    const conversationId = this._conversation_id_of(payload);

    let history = "";
    const saved = this.runtime_store.get_plan(normalizedPayload.user_id);
    if (saved && saved.message) {
      history = `上一轮计划：${saved.message.slice(0, 300)}\n`;
    }

    try {
      const conversations = this.runtime_store.list_conversations("default");
      // v2：指定会话时只看该会话，避免多会话之间互相串味
      const targetConversation = conversationId
        ? conversations.find((item) => item.id === conversationId)
        : conversations[0];
      if (targetConversation) {
        const msgs = this.runtime_store.get_messages(targetConversation.id);
        const recentMsgs = msgs.slice(-60);
        const lines: string[] = [];
        for (const m of recentMsgs) {
          const role = m.role === "user" ? "用户" : "Synapse";
          lines.push(`${role}：${m.content.slice(0, 300)}`);
        }
        if (lines.length) {
          history = "对话记录：\n" + lines.join("\n") + "\n\n" + history;
        }
      }
    } catch {
      // 忽略历史读取异常
    }

    let [intent, llmResult] = await this._detect_intent(
      this._payload_input(payload),
      payload.files,
      userProfile,
      history,
    );
    const retrievedContext = this._build_hybrid_context(normalizedPayload);

    // v2 护栏：本轮输入本身就是一句回答时（例如追问「英语还算数吗」时回答「当然算数」），
    // 不能拿它当学习目标 —— 计划提示词会把目标名直接当科目名，科目表里于是出现了「当然算数」。
    if (!this._accept_llm_goal(normalizedPayload.learning_goal)) {
      const previousGoal = String(userProfile["last_goal"] ?? "").trim();
      if (previousGoal) {
        normalizedPayload.learning_goal = previousGoal;
        console.warn("[Synapse] 本轮输入疑似回答短句，沿用上一轮目标", previousGoal);
      }
    }

    if (intent === "restart") {
      let subject = String(llmResult?.["subject"] ?? "");
      const savedPlan = this.runtime_store.get_plan(normalizedPayload.user_id);
      if (!subject && savedPlan) {
        const weekly = savedPlan.weekly_plan ?? [];
        const focus = weekly.length ? String(weekly[0]!["focus"] ?? "") : "";
        for (const suffix of ["入门", "专项", "综合", "练习", "基础", "检查", "梳理", "训练"]) {
          if (focus.includes(suffix)) {
            subject = focus.split(suffix)[0]!.trim();
            break;
          }
        }
        if (!subject) {
          subject = focus;
        }
      }
      if (!subject && savedPlan) {
        const msg = savedPlan.message ?? "";
        for (const prefix of ["我要复习", "复习"]) {
          if (msg.includes(prefix)) {
            subject = msg
              .slice(msg.indexOf(prefix) + prefix.length)
              .split("。")[0]!
              .split("，")[0]!
              .trim()
              .slice(0, 12);
            break;
          }
        }
      }
      if (subject) {
        const lastGoal = `我要复习${subject}`;
        normalizedPayload.learning_goal = lastGoal;
        payload.input = lastGoal;
        const extra = String(llmResult?.["extra"] ?? "");
        if (extra) {
          normalizedPayload.preferences.push(`用户额外要求：${extra}`);
        }
        intent = "learning_request";
      } else {
        const profile = this.runtime_store.get_profile(normalizedPayload.user_id);
        const lastGoal = String(profile["last_goal"] ?? "");
        if (lastGoal && lastGoal.length < 50) {
          normalizedPayload.learning_goal = lastGoal;
          payload.input = lastGoal;
          intent = "learning_request";
        } else {
          return this._makeResponse({
            mode: "intent-gate",
            request: { ...requestEcho, intent },
            message: "我没有找到你上一轮的学习目标。请告诉我你想学什么？",
            followUp: "",
            reason: "restart intent but no previous goal found",
            next_steps: [],
            memory_used: [],
          });
        }
      }
    }

    if (intent === "emotion") {
      const msg = await this._generate_conversational_reply(
        "emotion",
        this._payload_input(payload),
        userProfile,
        history,
      );
      return this._makeResponse({
        mode: "intent-gate",
        request: { ...requestEcho, intent },
        message: msg,
        followUp: "",
        reason: llmResult ? String(llmResult["reason"] ?? "") : "",
        next_steps: [],
        memory_used: [],
      });
    }

    if (intent === "tweak") {
      return this._handle_tweak_plan({
        normalizedPayload,
        requestEcho,
        memories,
        params: llmResult?.params ?? {},
        userMessage: this._payload_input(payload),
        retrievedContext,
      });
    }

    // v2 作业式计划：与「目标式计划」并列的第二条入口，整条链路独立，不影响下面任何一行。
    if (intent === "assignment") {
      const params = llmResult?.params ?? {};
      const rawText = String(params["text"] ?? "").trim() || this._payload_input(payload);
      return this._handle_assignment({
        userId: normalizedPayload.user_id,
        requestEcho,
        memories,
        text: rawText,
        retrievedContext,
      });
    }

    if (intent !== "learning_request" && intent !== "restart") {
      let func = llmResult?.function ?? "";
      let params: Record<string, unknown> = llmResult?.params ?? {};
      let msg = "";

      if (func === "reply") {
        msg = String(params["message"] ?? "");
      } else if (func === "remember") {
        const about = String(params["about"] ?? "");
        const value = String(params["value"] ?? "");
        if (about && value) {
          try {
            const data: Record<string, unknown> = {};
            if (about === "弱项" || about === "weak_points") {
              data["weak_points"] = [value];
            } else if (about === "截止时间" || about === "deadline") {
              data["last_deadline"] = value;
            } else if (about === "情绪" || about === "mood") {
              data["mood"] = value;
            } else if (about === "偏好" || about === "preference") {
              data["focus_preference"] = value;
            } else if (about === "约束" || about === "constraint") {
              data["constraint_note"] = value;
            } else if (about === "年级" || about === "grade") {
              data["grade"] = value;
            }
            if (Object.keys(data).length) {
              this.runtime_store.save_profile(normalizedPayload.user_id, data);
            }
          } catch {
            // 忽略画像写入异常
          }
        }
        // remember 是副作用——重新调用 DeepSeek 继续处理
        try {
          const llmInfo = this.providers.llm.describe();
          if (llmInfo["provider"] === "deepseek") {
            const retryResult = await this.providers.llm.generateWithTools(
              buildRememberRetryPrompt(this._payload_input(payload)),
              toOpenaiTools(ALL_TOOLS),
            );
            if ("tool_calls" in retryResult && retryResult.tool_calls.length) {
              const tc2 = retryResult.tool_calls[0]!;
              func = tc2.name;
              params = tc2.args;
              llmResult = { function: func, params };
              if (func === "create_plan") {
                intent = "learning_request";
              } else if (func === "restart_plan") {
                intent = "restart";
              } else if (func === "reply") {
                msg = String(params["message"] ?? "");
              }
              // ask / teach 落入下方统一分发
            } else if ("content" in retryResult && retryResult.content) {
              msg = retryResult.content;
            }
          }
        } catch {
          // 忽略重试异常
        }
        if (!msg && !["ask", "teach", "create_plan", "restart_plan"].includes(func)) {
          msg = "已记住。";
        }
      } else if (func === "teach") {
        const subject = String(params["subject"] ?? "");
        const action = String(params["action"] ?? "");
        const topic = String(params["topic"] ?? "");
        const teachContext = this._retrieve_for_query(
          [topic, subject, this._payload_input(payload)].filter(Boolean).join(" "),
          normalizedPayload,
        );
        try {
          msg = await this.providers.llm.generateText(
            buildTeachPrompt(subject, action, topic, teachContext),
          );
        } catch {
          msg = `关于${topic}，我建议你先从基础概念开始，然后做几道针对性练习。`;
        }
      } else if (func === "ask") {
        const question = String(params["question"] ?? "");
        const optionsStr = String(params["options"] ?? "");
        const options = optionsStr
          .split("|")
          .map((o) => o.trim())
          .filter((o) => o);
        const clarification: ClarificationPrompt = {
          sessionId: this.idGen.next(),
          title: "确认一下",
          description: question,
          questions: [
            {
              id: "q1",
              label: question,
              description: "选择一个选项",
              placeholder: "",
              suggestedAnswers: options.length ? options : ["是", "否"],
            },
          ],
        };
        this._save_pending_session(clarification.sessionId, {
          normalized_payload: normalizedPayload,
          request_echo: requestEcho,
          memories,
          planning_mode: planningMode,
        });
        return this._makeResponse({
          status: "needs_clarification",
          mode: "clarify-first",
          request: requestEcho,
          message: question,
          followUp: "",
          reason: "",
          next_steps: [],
          clarification,
          memory_used: memories,
        });
      } else {
        msg = await this._generate_conversational_reply(
          intent,
          this._payload_input(payload),
          userProfile,
          history,
        );
      }

      return this._makeResponse({
        mode: "intent-gate",
        request: { ...requestEcho, intent: func },
        message: msg,
        followUp: "",
        reason: "",
        next_steps: [],
        memory_used: [],
      });
    }

    this._persist_learning_goal(normalizedPayload);

    if (planningMode === "blocks") {
      const clarification = this._create_clarification_prompt(normalizedPayload, planningMode, null, 4);
      this._save_pending_session(clarification.sessionId, {
        normalized_payload: normalizedPayload,
        request_echo: requestEcho,
        memories,
        planning_mode: planningMode,
      });
      const nextSteps = [
        "先一起确认 Day 1 的节奏、排序和限制条件。",
        "确认后我先搭出可替换的积木块，你可以逐块替换，不用整版重做。",
      ];
      return this._makeResponse({
        status: "needs_clarification",
        mode: "blocks-intake",
        request: requestEcho,
        message: "积木计划会先和你一起搭 Day 1，不会直接丢一整版周计划给你。",
        followUp: nextSteps[0]!,
        reason: this._build_reason_summary(normalizedPayload, retrievedContext),
        next_steps: nextSteps,
        clarification,
        memory_used: memories,
      });
    }

    const readiness = this._assess_plan_readiness(normalizedPayload, planningMode);
    if (!readiness.ready) {
      const clarification = this._create_clarification_prompt(
        normalizedPayload,
        planningMode,
        readiness.missing_fields,
        readiness.ask_count,
      );
      this._save_pending_session(clarification.sessionId, {
        normalized_payload: normalizedPayload,
        request_echo: requestEcho,
        memories,
        planning_mode: planningMode,
      });
      const nextSteps = [
        "先补充最影响计划质量的几个约束，我再正式生成计划。",
        "这次只问必要信息，补完后我会直接进入排程。",
      ];
      return this._makeResponse({
        status: "needs_clarification",
        mode: "clarify-first",
        request: requestEcho,
        message: "我先不急着给你一版大而空的计划，先把会影响安排质量的关键信息补齐。",
        followUp: nextSteps[0]!,
        reason: this._build_reason_summary(normalizedPayload, retrievedContext),
        next_steps: nextSteps,
        clarification,
        memory_used: memories,
      });
    }

    // v2：把本轮提到的科目**并入**「已确认科目」（记在用户身上、跨对话保留）。
    // 这样「我要学英语 → 我还要学计网」是累加，而不是让模型从对话记录里重新猜目标。
    const subjectCandidates = this._collect_subject_candidates(
      normalizedPayload,
      String(llmResult?.["subject"] ?? ""),
    );
    const addedSubjects = this._merge_confirmed_subjects(
      normalizedPayload.user_id,
      subjectCandidates,
    );

    // 中途追加科目：在现有计划上增量补排，保留已有条目与打卡，不整版重生成
    if (addedSubjects.length) {
      const appended = this._handle_append_subjects({
        payload: normalizedPayload,
        requestEcho,
        memories,
        retrievedContext,
        addedSubjects,
      });
      if (appended) {
        return appended;
      }
    }

    // v2 三层计划：目标跨度超过一周时，额外产出「长期阶段计划」并附在响应上。
    // 刻意不改短期计划的生成方式（mode / message / 学习目标都不动），
    // 所以「一周内的目标」行为与旧版逐字一致；阶段与本周的绑定由用户显式触发。
    const longPlan = await this.build_long_term_plan(
      normalizedPayload,
      this.get_confirmed_subjects(normalizedPayload.user_id),
      this._payload_input(payload),
    );
    const activeMilestone = longPlan ? pick_active_milestone(longPlan.milestones) : null;

    const plan = await this.build_study_plan(normalizedPayload, retrievedContext);
    const nextSteps = plan.next_actions.slice(0, 3);
    return this._makeResponse({
      request: requestEcho,
      message: activeMilestone
        ? `${plan.final_message}\n\n这个目标横跨 ${longPlan!.milestones.length} 个阶段，` +
          `我先按今天开始的第一个阶段「${activeMilestone.title}」` +
          `（${activeMilestone.start_date} ~ ${activeMilestone.due_date}）来排这一周。` +
          "阶段划分在「计划 → 长期」里可以看。"
        : plan.final_message,
      followUp: nextSteps.length ? nextSteps[0]! : "先从今天最容易完成的一步开始。",
      reason: this._build_reason_summary(normalizedPayload, retrievedContext),
      next_steps: nextSteps,
      plan,
      memory_used: memories,
      ...(longPlan ? { longPlan } : {}),
    });
  }

  async submit_clarification(
    payload: StudyPilotClarificationRequest,
  ): Promise<StudyPilotRunResponse> {
    // 每轮独立判定：上一轮模型不可达不代表这一轮仍然不可达（域名白名单修好后应立刻恢复）
    this._llmUnreachableReason = "";
    const session = this._pop_pending_session(payload.sessionId);
    if (!session) {
      return this._makeResponse({
        status: "maintenance",
        mode: "session-missing",
        request: { sessionId: payload.sessionId },
        message: "这轮积木计划的确认上下文已经失效了。",
        followUp: "请重新发起一次积木计划模式，我会重新向你确认关键偏好。",
        reason: "这次确认信息对应的会话没有取到，可能是会话已完成或被清理。",
        next_steps: ["重新发起一次学习计划请求，我会重新建立确认会话。"],
        is_fallback: true,
        error_message: "clarification session missing",
        includeModelMeta: false,
      });
    }

    // v2 作业式计划：这轮 pending 的是「作业没解析出来」时，
    // 把用户在澄清卡里补的信息拼回原文重新解析，而不是去生成学习计划。
    if (session.assignment_text) {
      const extra = payload.answers
        .map((answer) => (answer.answer ?? "").trim())
        .filter(Boolean)
        .join("，");
      return this._handle_assignment({
        userId: session.normalized_payload.user_id,
        requestEcho: session.request_echo,
        memories: session.memories,
        text: extra ? `${session.assignment_text}，${extra}` : session.assignment_text,
        retrievedContext: [],
      });
    }

    const enrichedPayload = this._apply_clarification_answers(
      session.normalized_payload,
      payload.answers,
    );
    this._update_user_profile_from_answers(enrichedPayload.user_id, payload.answers);
    const refreshedPayload = this._hydrate_payload_from_state(
      enrichedPayload,
      enrichedPayload.learning_goal,
    );
    this._persist_learning_goal(refreshedPayload);
    // 澄清路径同样要把本轮提到的科目并入「已确认科目」，
    // 否则「我要学高等数学和大学物理」走澄清后，我的科目列表仍是空的。
    // 这里不触发中途追加分支：澄清后是本轮正式生成，而非在已有计划上增量补排。
    this._merge_confirmed_subjects(refreshedPayload.user_id, this._collect_subject_candidates(refreshedPayload));
    const retrievedContext = this._build_hybrid_context(refreshedPayload);
    if (session.planning_mode === "blocks") {
      const blockPlan = this._build_block_plan(refreshedPayload, retrievedContext);
      const reason = this._build_reason_summary(refreshedPayload, retrievedContext);
      const nextSteps = [
        "先看 Day 1 这 4 个积木块顺不顺手。",
        "如果某一块不合适，可以直接点“替换此块”继续和我一起调。",
        "确认这套积木后，再决定要不要把它展开成后续几天安排。",
      ];
      return this._makeResponse({
        mode: "blocks-co-create",
        request: {
          ...session.request_echo,
          clarificationAnswers: payload.answers.map((answer) => ({ ...answer })),
          normalized: refreshedPayload,
        },
        message: "我先把 Day 1 搭成一版可替换的积木计划，你可以逐块替换，我们一起把今天的安排调顺。",
        followUp: nextSteps[0]!,
        reason,
        next_steps: nextSteps,
        blockPlan,
        plan: null,
        memory_used: session.memories,
      });
    }

    // v2 三层计划：澄清回答走的是另一条路径，长期计划要在这里同样产出，
    // 否则「6 个月后考研」这类目标经过澄清后只会拿到一份 5 天的短期计划。
    const longPlan = await this.build_long_term_plan(
      refreshedPayload,
      this.get_confirmed_subjects(refreshedPayload.user_id),
      refreshedPayload.learning_goal,
    );
    const activeMilestone = longPlan ? pick_active_milestone(longPlan.milestones) : null;

    const plan = await this.build_study_plan(refreshedPayload, retrievedContext);
    const reason = this._build_reason_summary(refreshedPayload, plan.retrieved_context);
    const nextSteps = plan.next_actions.slice(0, 3);

    return this._makeResponse({
      request: {
        ...session.request_echo,
        clarificationAnswers: payload.answers.map((answer) => ({ ...answer })),
        normalized: refreshedPayload,
      },
      message: activeMilestone
        ? `${plan.final_message}\n\n这个目标横跨 ${longPlan!.milestones.length} 个阶段，` +
          `我先按今天开始的第一个阶段「${activeMilestone.title}」` +
          `（${activeMilestone.start_date} ~ ${activeMilestone.due_date}）来排这一周。` +
          "阶段划分在「计划 → 长期」里可以看。"
        : plan.final_message,
      followUp: nextSteps.length ? nextSteps[0]! : "先从今天最轻的一项任务开始。",
      reason,
      next_steps: nextSteps,
      blockPlan: null,
      plan,
      memory_used: session.memories,
      ...(longPlan ? { longPlan } : {}),
    });
  }

  async expand_block_plan(
    normalizedPayload: StudyPlanRequest,
    blockPlan: BlockPlan,
  ): Promise<StudyPilotRunResponse> {
    this._llmUnreachableReason = "";
    const refreshedPayload = this._hydrate_payload_from_state(
      normalizedPayload,
      normalizedPayload.learning_goal,
    );
    const retrievedContext = this._build_hybrid_context(refreshedPayload);
    const plan = await this.build_study_plan(refreshedPayload, retrievedContext);
    const expandedWeeklyPlan = this._expand_block_plan_to_weekly_plan(blockPlan, refreshedPayload);
    const expandedPlan: StudyPlanPayload = {
      ...plan,
      weekly_plan: expandedWeeklyPlan,
      final_message: "我先保留你刚刚一起搭好的 Day 1，再沿着你这次选中的积木节奏，把后续几天顺着排开。",
      next_actions: [
        "先看 Day 1 和后续几天的衔接是不是顺手，尤其是节奏有没有沿着你刚才选的块往后走。",
        "如果 Day 1 还想继续换块，可以回到上一条积木计划继续调整。",
        "确认没问题后，就按这版一周安排开始执行。",
      ],
    };
    return this._makeResponse({
      mode: "blocks-expanded-week",
      request: { normalized: refreshedPayload, blockPlan },
      message: expandedPlan.final_message,
      followUp: expandedPlan.next_actions[0]!,
      reason:
        this._build_reason_summary(refreshedPayload, expandedPlan.retrieved_context) +
        " 我把你确认过的 Day 1 积木保留成一周计划的起点，后续几天也优先沿着当前选中的学习风格展开。",
      next_steps: expandedPlan.next_actions,
      plan: expandedPlan,
      blockPlan: null,
    });
  }

  // ------------------------------------------------------------------
  // 内部：响应构造
  // ------------------------------------------------------------------

  private _model_response_meta(): {
    model_provider: string;
    model_used: string;
    is_fallback: boolean;
  } {
    const llmInfo = this.providers.llm.describe();
    return {
      model_provider: String(llmInfo["provider"] ?? ""),
      model_used: String(llmInfo["model"] ?? ""),
      is_fallback: llmInfo["provider"] !== "deepseek",
    };
  }

  private _makeResponse(
    partial: Partial<StudyPilotRunResponse> & { includeModelMeta?: boolean },
  ): StudyPilotRunResponse {
    const { includeModelMeta = true, ...rest } = partial;
    const base: StudyPilotRunResponse = {
      status: "ready",
      mode: "backend-live",
      request: {},
      message: "",
      followUp: "",
      reason: "",
      next_steps: [],
      clarification: null,
      blockPlan: null,
      plan: null,
      memory_used: [],
      memory_candidates: [],
      model_provider: "",
      model_used: "",
      is_fallback: false,
      error_message: "",
    };
    const withMeta = includeModelMeta ? { ...base, ...this._model_response_meta() } : base;
    return { ...withMeta, ...rest };
  }

  // ------------------------------------------------------------------
  // 内部：payload 归一化与水合
  // ------------------------------------------------------------------

  private _analyze_request(payload: StudyPlanRequest): Record<string, unknown> {
    return {
      user_id: payload.user_id,
      current_level: payload.current_level,
      learning_goal: payload.learning_goal,
      time_budget: {
        available_days_per_week: payload.available_days_per_week,
        available_minutes_per_day: payload.available_minutes_per_day,
      },
      weak_points: payload.weak_points,
      preferences: payload.preferences,
    };
  }

  private _build_request_echo(
    payload: StudyPilotRunRequest,
    normalizedPayload: StudyPlanRequest,
  ): Record<string, unknown> {
    const profile = this._payload_profile(payload);
    return {
      input: this._payload_input(payload),
      files: payload.files.map((file) => ({ ...file })),
      userProfile: profile ? { ...profile } : null,
      planningMode: this._payload_mode(payload),
      memories: this._active_memories(payload.memories).map((memory) => ({ ...memory })),
      normalized: normalizedPayload,
    };
  }

  private _save_pending_session(sessionId: string, session: PendingClarificationSession): void {
    this.pending_sessions.set(sessionId, session);
    this.runtime_store.save_session(sessionId, {
      normalized_payload: session.normalized_payload,
      request_echo: session.request_echo,
      memories: session.memories.map((memory) => ({ ...memory })),
      planning_mode: session.planning_mode,
      ...(session.assignment_text ? { assignment_text: session.assignment_text } : {}),
    });
  }

  private _pop_pending_session(sessionId: string): PendingClarificationSession | null {
    const cached = this.pending_sessions.get(sessionId);
    this.pending_sessions.delete(sessionId);
    const stored = this.runtime_store.pop_session(sessionId);
    if (cached) {
      return cached;
    }
    if (!stored) {
      return null;
    }
    return {
      normalized_payload: stored["normalized_payload"] as StudyPlanRequest,
      request_echo: (stored["request_echo"] as Record<string, unknown>) ?? {},
      memories: ((stored["memories"] as FrontendMemory[]) ?? []).map((item) => ({ ...item })),
      planning_mode: String(stored["planning_mode"] || "free"),
      ...(stored["assignment_text"]
        ? { assignment_text: String(stored["assignment_text"]) }
        : {}),
    };
  }

  private _normalize_frontend_payload(payload: StudyPilotRunRequest): StudyPlanRequest {
    const rawInput = this._payload_input(payload).trim();
    const profile = this._payload_profile(payload);
    const attachments = payload.files;
    const fileNames = attachments.filter((file) => file.name).map((file) => file.name);
    const learningGoal = rawInput || this._build_file_goal(fileNames);
    const userId = this._build_user_id(profile ? profile.name : null);
    this._persist_documents_from_attachments(userId, attachments);

    const normalized: StudyPlanRequest = {
      user_id: userId,
      current_level: profile && profile.grade ? profile.grade : "未填写",
      learning_goal: learningGoal,
      available_days_per_week: this._extract_available_days(rawInput),
      available_minutes_per_day: this._extract_available_minutes(rawInput),
      deadline: this._extract_deadline(rawInput),
      weak_points: this._extract_weak_points(rawInput),
      preferences: this._build_preferences(
        this._payload_mode(payload),
        attachments,
        this._active_memories(payload.memories),
        rawInput,
      ),
      need_user_confirmation: true,
    };
    this._save_user_profile_snapshot(normalized, rawInput);
    return this._hydrate_payload_from_state(normalized, rawInput);
  }

  private _hydrate_payload_from_state(
    payload: StudyPlanRequest,
    rawInput = "",
  ): StudyPlanRequest {
    const storedProfile = this.runtime_store.get_profile(payload.user_id);
    const progressMap = this.runtime_store.get_progress(payload.user_id);
    const adjustment = build_plan_adjustment(progressMap, payload.available_minutes_per_day);
    const preferences = [...payload.preferences];

    if (storedProfile["preferred_pacing"]) {
      preferences.push(`长期节奏偏好：${storedProfile["preferred_pacing"]}`);
    }
    if (storedProfile["focus_preference"]) {
      preferences.push(`长期学习方式偏好：${storedProfile["focus_preference"]}`);
    }
    if (storedProfile["constraint_note"]) {
      preferences.push(`长期时间约束：${storedProfile["constraint_note"]}`);
    }
    const weakPoints = [...payload.weak_points];
    const storedWeakPoints = ((storedProfile["weak_points"] as string[]) ?? [])
      .map((item) => String(item).trim())
      .filter((item) => item);
    if (!weakPoints.length && storedWeakPoints.length) {
      weakPoints.push(...storedWeakPoints.slice(0, 4));
    }
    for (const preference of adjustment.preferences) {
      if (preference) {
        preferences.push(preference);
      }
    }
    if (adjustment.reason) {
      preferences.push(`历史执行调整：${adjustment.reason}`);
    }

    const explicitMinutes = this._has_explicit_minutes(rawInput);
    const explicitDays = this._has_explicit_days(rawInput);
    const explicitDeadline = this._has_explicit_deadline(rawInput);

    let availableMinutes = payload.available_minutes_per_day;
    if (!explicitMinutes && storedProfile["preferred_daily_minutes"]) {
      availableMinutes = pyInt(storedProfile["preferred_daily_minutes"]);
    }
    availableMinutes = pyInt(adjustment.daily_minutes || availableMinutes);

    let availableDays = payload.available_days_per_week;
    if (!explicitDays && storedProfile["preferred_days_per_week"]) {
      availableDays = pyInt(storedProfile["preferred_days_per_week"]);
    }

    let deadline = payload.deadline;
    if (!explicitDeadline && storedProfile["last_deadline"]) {
      deadline = String(storedProfile["last_deadline"]);
    }

    const hydrated: StudyPlanRequest = {
      ...payload,
      available_days_per_week: Math.max(1, Math.min(7, availableDays)),
      available_minutes_per_day: Math.max(15, Math.min(720, availableMinutes)),
      deadline,
      weak_points: weakPoints,
      preferences: this._dedupe_preferences(preferences),
    };

    // v2：导入课程表后，把上课时段约束注入计划请求（未导入课表时原样返回，旧行为不变）
    const timetable = this.runtime_store.get_timetable(payload.user_id);
    return apply_timetable_to_payload(hydrated, timetable);
  }

  private _persist_documents_from_attachments(
    userId: string,
    attachments: FrontendAttachment[],
  ): void {
    const records = build_document_records(userId, attachments);
    if (records.length) {
      this.runtime_store.save_documents(
        userId,
        records as unknown as Array<Record<string, unknown>>,
      );
    }
  }

  private _save_user_profile_snapshot(payload: StudyPlanRequest, rawInput = ""): void {
    const profileData: Record<string, unknown> = {
      current_level: payload.current_level,
    };
    if (this._has_explicit_minutes(rawInput)) {
      profileData["preferred_daily_minutes"] = payload.available_minutes_per_day;
    }
    if (this._has_explicit_days(rawInput)) {
      profileData["preferred_days_per_week"] = payload.available_days_per_week;
    }
    if (this._has_explicit_deadline(rawInput) && payload.deadline) {
      profileData["last_deadline"] = payload.deadline;
    }
    if (payload.weak_points.length) {
      profileData["weak_points"] = payload.weak_points.slice(0, 4);
    }
    this.runtime_store.save_profile(payload.user_id, profileData);
  }

  private _persist_learning_goal(payload: StudyPlanRequest): void {
    const data: Record<string, unknown> = { last_goal: payload.learning_goal };
    if (payload.weak_points.length) {
      data["weak_points"] = payload.weak_points.slice(0, 4);
    }
    try {
      this.runtime_store.save_profile(payload.user_id, data);
    } catch {
      // 忽略画像写入异常
    }
  }

  private _update_user_profile_from_answers(userId: string, answers: ClarificationAnswer[]): void {
    const answerMap: Record<string, string> = {};
    for (const answer of answers) {
      if ((answer.answer ?? "").trim()) {
        answerMap[answer.questionId] = answer.answer.trim();
      }
    }
    const profileUpdate: Record<string, unknown> = {};
    if (answerMap["daily_minutes"]) {
      const raw = answerMap["daily_minutes"];
      profileUpdate["preferred_daily_minutes"] = this._extract_available_minutes(
        raw.includes("每天") ? raw : `每天 ${raw}`,
      );
    }
    if (answerMap["pacing_style"]) {
      profileUpdate["preferred_pacing"] = answerMap["pacing_style"];
    }
    if (answerMap["focus_preference"]) {
      profileUpdate["focus_preference"] = answerMap["focus_preference"];
    }
    if (answerMap["constraint_note"] && answerMap["constraint_note"] !== "没有额外约束") {
      profileUpdate["constraint_note"] = answerMap["constraint_note"];
    }
    if (answerMap["weak_points"]) {
      const rawItems = answerMap["weak_points"].split(/[、,，/ ]+/);
      profileUpdate["weak_points"] = rawItems.filter((item) => item).slice(0, 4);
    }
    if (Object.keys(profileUpdate).length) {
      this.runtime_store.save_profile(userId, profileUpdate);
    }
  }

  private _build_hybrid_context(payload: StudyPlanRequest): string[] {
    const context: string[] = [];
    context.push(...this.providers.retrieval.search(payload.learning_goal));

    const storedProfile = this.runtime_store.get_profile(payload.user_id);
    if (storedProfile["focus_preference"]) {
      context.push(`长期偏好：你更适合 ${storedProfile["focus_preference"]}。`);
    }
    if (storedProfile["constraint_note"]) {
      context.push(`长期约束：${storedProfile["constraint_note"]}。`);
    }

    const progressMap = this.runtime_store.get_progress(payload.user_id);
    if (Object.keys(progressMap).length) {
      let doneCount = 0;
      let total = 0;
      for (const item of Object.values(progressMap)) {
        if (item && typeof item === "object") {
          total += 1;
          if (item.done) {
            doneCount += 1;
          }
        }
      }
      context.push(`最近执行情况：已完成 ${doneCount}/${Math.max(1, total)} 个记录任务。`);
      const adjustment = build_plan_adjustment(progressMap, payload.available_minutes_per_day);
      if (adjustment.reason) {
        context.push(`执行调整建议：${adjustment.reason}`);
      }
    }

    const documents = this.runtime_store.get_documents(payload.user_id);
    context.push(
      ...search_document_records(
        documents as never,
        payload.learning_goal,
        payload.weak_points,
        3,
      ),
    );

    // v2：课程表上下文（未导入课表时为空数组，不改变旧行为）
    context.push(...build_timetable_context(this.runtime_store.get_timetable(payload.user_id)));

    const deduped = this._dedupe_preferences(context);
    return collect_document_hits(deduped).length
      ? allocate_context_budget(deduped)
      : deduped.slice(0, 8);
  }

  private _retrieve_for_query(query: string, payload: StudyPlanRequest, limit = 3): string[] {
    const trimmed = String(query ?? "").trim();
    if (!trimmed) {
      return [];
    }
    const documents = this.runtime_store.get_documents(payload.user_id);
    if (!documents.length) {
      return [];
    }
    return search_document_records(documents as never, trimmed, null, limit);
  }

  private _assess_plan_readiness(
    payload: StudyPlanRequest,
    planningMode: string,
  ): { ready: boolean; missing_fields: string[]; confidence: number; ask_count: number } {
    const storedProfile = this.runtime_store.get_profile(payload.user_id);
    const documents = this.runtime_store.get_documents(payload.user_id);
    const hasDocs = documents.length > 0;
    let score = 0.0;
    if (payload.learning_goal.trim()) {
      score += 0.35;
    }
    if (payload.available_minutes_per_day > 0) {
      score += 0.2;
    }
    if (payload.deadline) {
      score += 0.15;
    }
    if (payload.weak_points.length) {
      score += 0.15;
    }
    if (hasDocs) {
      score += 0.1;
    }
    if (storedProfile["focus_preference"] || storedProfile["preferred_pacing"]) {
      score += 0.1;
    }

    const missingFields: string[] = [];
    if (!payload.deadline && !hasDocs) {
      missingFields.push("deadline");
    }
    if (!payload.weak_points.length && !hasDocs) {
      missingFields.push("weak_points");
    }
    if (!storedProfile["focus_preference"]) {
      missingFields.push("focus_preference");
    }
    if (!storedProfile["preferred_pacing"] && planningMode === "blocks") {
      missingFields.push("pacing_style");
    }
    if (payload.available_minutes_per_day === 90 && !storedProfile["preferred_daily_minutes"]) {
      missingFields.push("daily_minutes");
    }

    if (planningMode === "blocks" && !missingFields.includes("constraint_note")) {
      missingFields.push("constraint_note");
    }

    let ready =
      score >= 0.65 && Boolean(payload.deadline || payload.weak_points.length || hasDocs);
    if (planningMode === "blocks") {
      ready = false;
    }

    const askCount = score >= 0.55 ? 2 : 3;
    return {
      ready,
      missing_fields: missingFields.slice(0, askCount),
      confidence: Math.round(score * 100) / 100,
      ask_count: askCount,
    };
  }

  private _dedupe_preferences(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
      const normalized = this._clean_text(item);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }

  private _has_explicit_minutes(text: string): boolean {
    return /每天\s*(\d{2,3})\s*分钟|每天\s*(\d(?:\.\d)?)\s*小时/.test(text);
  }

  private _has_explicit_days(text: string): boolean {
    return /每周\s*\d\s*天|一周\s*\d\s*天|\d\s*天\/周/.test(text);
  }

  private _has_explicit_deadline(text: string): boolean {
    return this._extract_deadline(text) !== null;
  }

  private _payload_input(payload: StudyPilotRunRequest): string {
    return payload.input || payload.message || "";
  }

  private _payload_profile(payload: StudyPilotRunRequest): FrontendUserProfile | null {
    return payload.userProfile || payload.user_profile;
  }

  private _payload_mode(payload: StudyPilotRunRequest): string {
    return payload.mode !== "free" ? payload.mode : payload.planningMode || "free";
  }

  private _active_memories(memories: FrontendMemory[]): FrontendMemory[] {
    return memories.filter((memory) => memory.id && memory.title && memory.content);
  }

  // ------------------------------------------------------------------
  // 内部：意图判断
  // ------------------------------------------------------------------

  private async _detect_intent(
    message: string,
    files: FrontendAttachment[],
    userProfile: Record<string, unknown> | null = null,
    history = "",
  ): Promise<[string, LlmIntentResult | null]> {
    const text = (message || "").trim().toLowerCase().replace(/\s+/g, "");
    if (!text && !files.length) {
      return ["empty", null];
    }
    if (files.length && !text) {
      return ["learning_request", null];
    }

    const llmResult = await this._llm_classify_intent(message, userProfile, history);
    if (llmResult) {
      const func = llmResult.function;
      // 模型不可达（网络被平台拦截、超时等）：直接按学习请求处理，由规则计划兜底，
      // 否则用户只会收到一句无用的闲聊回复。
      if (func === "__llm_unreachable__") {
        return ["learning_request", null];
      }
      const params = llmResult.params;
      if (func === "create_plan") {
        return ["learning_request", { function: func, params }];
      }
      if (func === "restart_plan") {
        return ["restart", { function: func, params }];
      }
      if (func === "tweak_plan") {
        return ["tweak", { function: func, params }];
      }
      if (func === "submit_assignment") {
        return ["assignment", { function: func, params }];
      }
      if (["reply", "teach", "remember", "switch_subject", "ask"].includes(func)) {
        return ["chat", { function: func, params }];
      }
    }

    if (
      ["嗯", "啊", "哦", "噢", "?", "？", ".", "。", "...", "……", "123", "好的", "谢谢", "ok"].includes(
        text,
      )
    ) {
      return ["meaningless", null];
    }
    if (/^[?.？。!！….\d]+$/.test(text)) {
      return ["meaningless", null];
    }

    // v2 作业句式兜底：模型没给出工具调用（或压根没配 Key）时，靠规则把作业认出来，
    // 否则「数学第三章习题1-20明天交」会被当成闲聊或学习目标。
    // 只认强信号（截止词 + 作业词/数量），普通学习请求不受影响。
    if (looks_like_assignment(message)) {
      return ["assignment", null];
    }

    // 离线规划模式（未配置任何模型 Key）：没有模型能做意图分类，规则引擎却能排计划。
    // 与其回一句「你想聊学习计划还是有什么需要帮助的」，不如直接按学习请求处理；
    // 同时记下原因，让这版计划在回复里标明是本地规则生成的。
    if (this.providers.llm.describe()["provider"] === "offline-rule") {
      this._llmUnreachableReason = "当前未配置模型 Key";
      return ["learning_request", null];
    }

    return ["unclear", null];
  }

  private async _llm_classify_intent(
    message: string,
    userProfile: Record<string, unknown> | null = null,
    history = "",
  ): Promise<LlmIntentResult | null> {
    const llmInfo = this.providers.llm.describe();
    if (llmInfo["provider"] !== "deepseek") {
      return null;
    }

    let profileText = "";
    if (userProfile) {
      const p = userProfile;
      const parts: string[] = [];
      if (p["grade"]) {
        parts.push(`年级：${p["grade"]}`);
      }
      const ab = String(p["abilities_json"] ?? "{}");
      if (ab && ab !== "{}") {
        parts.push(`能力：${ab.slice(0, 300)}`);
      }
      if (p["preferred_pacing"]) {
        parts.push(`偏好：${p["preferred_pacing"]}`);
      }
      if (p["focus_preference"]) {
        parts.push(`学习方式：${p["focus_preference"]}`);
      }
      if (p["mood"]) {
        parts.push(`情绪：${p["mood"]}`);
      }
      if (parts.length) {
        profileText = "用户画像：\n" + parts.join("\n") + "\n";
      }
    }

    const prompt = buildIntentPrompt(profileText, history, message);
    try {
      let force = "";
      if (
        ["给我计划", "制定计划", "安排学习", "直接做计划", "给我做计划", "给我安排"].some((t) =>
          message.includes(t),
        )
      ) {
        force = "create_plan";
      } else if (
        ["太难", "太简单", "没时间", "来不及", "缩短", "减少", "轻一点", "多练习", "多刷题", "压缩到"].some(
          (t) => message.includes(t),
        )
      ) {
        force = "tweak_plan";
      } else if (["重来", "重新", "换一版", "再来一版"].some((t) => message.includes(t))) {
        force = "restart_plan";
      } else if (looks_like_assignment(message)) {
        // 作业句式放在最后：明确要计划/微调/重做的说法优先，避免抢走 create_plan。
        force = "submit_assignment";
      }
      const result = await this.providers.llm.generateWithTools(
        prompt,
        toOpenaiTools(ALL_TOOLS),
        force,
      );
      if ("tool_calls" in result && result.tool_calls.length) {
        const tcList = result.tool_calls;
        let mainTc = tcList[0]!;
        for (const tc of tcList) {
          if (tc.name !== "remember") {
            mainTc = tc;
            break;
          }
        }
        return { function: mainTc.name, params: mainTc.args };
      }
      if ("content" in result && result.content) {
        return { function: "reply", params: { message: result.content } };
      }
    } catch (error) {
      // 意图分类失败：记录「模型不可达」，本轮改由规则计划兜底
      this._llmUnreachableReason = error instanceof Error ? error.message : String(error);
      console.error("[Synapse] 模型不可达，本轮改用规则计划", this._llmUnreachableReason);
      return { function: "__llm_unreachable__", params: {} };
    }
    return null;
  }

  private async _generate_conversational_reply(
    intent: string,
    userMessage: string,
    userProfile: Record<string, unknown> | null = null,
    history = "",
  ): Promise<string> {
    void intent;
    try {
      const llmInfo = this.providers.llm.describe();
      if (llmInfo["provider"] !== "deepseek") {
        throw new Error("no deepseek");
      }
      let profileText = "";
      if (userProfile) {
        const p = userProfile;
        const parts: string[] = [];
        if (p["grade"]) {
          parts.push(`年级：${p["grade"]}`);
        }
        if (p["abilities_json"]) {
          parts.push(`能力：${String(p["abilities_json"]).slice(0, 300)}`);
        }
        if (p["focus_preference"]) {
          parts.push(`学习方式：${p["focus_preference"]}`);
        }
        if (parts.length) {
          profileText = "用户画像：\n" + parts.join("\n") + "\n";
        }
      }
      return await this.providers.llm.generateText(
        buildConversationalReplyPrompt(profileText, history, userMessage),
      );
    } catch {
      // 落入兜底话术
    }
    return "我在，你想聊学习计划还是有什么需要帮助的？";
  }

  private _build_user_id(name: string | null): string {
    void name;
    return "default";
  }

  private _build_file_goal(fileNames: string[]): string {
    if (!fileNames.length) {
      return "生成一版可执行的个性化学习计划";
    }
    const joinedNames = fileNames.slice(0, 2).join("、");
    return `结合资料 ${joinedNames} 生成一版学习计划`;
  }

  private _extract_available_days(text: string): number {
    const dayPatterns = [/每周\s*(\d)\s*天/, /一周\s*(\d)\s*天/, /(\d)\s*天\/周/];
    for (const pattern of dayPatterns) {
      const matched = pattern.exec(text);
      if (matched) {
        return Math.max(1, Math.min(7, Number.parseInt(matched[1]!, 10)));
      }
    }
    return 5;
  }

  private _extract_available_minutes(text: string): number {
    const minuteMatch = /每天\s*(\d{2,3})\s*分钟/.exec(text);
    if (minuteMatch) {
      return Math.max(15, Math.min(720, Number.parseInt(minuteMatch[1]!, 10)));
    }

    const hourMatch = /每天\s*(\d(?:\.\d)?)\s*小时/.exec(text);
    if (hourMatch) {
      return Math.max(15, Math.min(720, pyTruncInt(Number.parseFloat(hourMatch[1]!) * 60)));
    }

    return 90;
  }

  private _extract_deadline(text: string): string | null {
    for (const pattern of [/\d{4}-\d{1,2}-\d{1,2}/, /\d{1,2}月\d{1,2}日/]) {
      const matched = pattern.exec(text);
      if (matched) {
        return matched[0];
      }
    }
    return null;
  }

  private _extract_weak_points(text: string): string[] {
    const keywordMatch = /(薄弱点|弱项)[:：]\s*([^\n。]+)/.exec(text);
    if (!keywordMatch) {
      return [];
    }

    const rawItems = keywordMatch[2]!.trim().split(/[、,，/ ]+/);
    return rawItems.filter((item) => item).slice(0, 4);
  }

  private _build_preferences(
    planningMode: string,
    attachments: FrontendAttachment[],
    memories: FrontendMemory[],
    rawInput = "",
  ): string[] {
    const fileNames = attachments.filter((file) => file.name).map((file) => file.name);
    const preferences = ["允许用户确认解析结果"];
    preferences.push(planningMode === "blocks" ? "使用积木计划模式" : "使用自由计划模式");
    if (fileNames.length) {
      preferences.push("已上传学习资料，优先结合资料安排");
    }
    for (const attachment of attachments.slice(0, 3)) {
      if (attachment.text_excerpt) {
        preferences.push(`资料摘要[${attachment.name}]：${attachment.text_excerpt.slice(0, 280)}`);
      } else if (attachment.extraction_status === "unsupported") {
        preferences.push(`资料[${attachment.name}] 当前只拿到了文件名，未提取正文。`);
      } else {
        preferences.push(
          `资料[${attachment.name}] 文本提取失败（${attachment.extraction_error}），请用户确认是否重新上传。`,
        );
      }
    }
    for (const memory of memories.slice(0, 8)) {
      preferences.push(`长期记忆[${memory.type}] ${memory.title}：${memory.content}`);
    }

    if (EMOTION_KEYWORDS.some((keyword) => rawInput.includes(keyword))) {
      preferences.push(
        "用户当前情绪焦虑或受挫，最终回复必须包含强烈的共情和鼓励，安抚情绪。回复要像知心朋友一样，多说一些温暖的话。",
      );
    }

    return preferences;
  }

  private _create_clarification_prompt(
    payload: StudyPlanRequest,
    planningMode = "free",
    missingFields: string[] | null = null,
    askCount = 3,
  ): ClarificationPrompt {
    const isBlocks = planningMode === "blocks";
    const questionBank: Record<string, ClarificationQuestion> = {
      daily_minutes: {
        id: "daily_minutes",
        label: "每天你真正常驻可投入多久？",
        description: `我当前先按 ${payload.available_minutes_per_day} 分钟理解，你可以直接改。`,
        placeholder: "例如：每天 75 分钟",
        suggestedAnswers: [
          "每天 45 分钟",
          "每天 60 分钟",
          `每天 ${payload.available_minutes_per_day} 分钟`,
        ],
      },
      pacing_style: {
        id: "pacing_style",
        label: "这轮更想稳扎稳打，还是冲刺推进？",
        description: "这会影响计划强度和节奏。",
        placeholder: "例如：稳扎稳打一点",
        suggestedAnswers: ["稳扎稳打", "考前冲刺", "先轻后重"],
      },
      focus_preference: {
        id: "focus_preference",
        label: "这轮更想先梳理知识，还是先刷题找问题？",
        description: "我会用它决定这版计划的任务排序。",
        placeholder: "例如：先做题再回补",
        suggestedAnswers: ["先听讲梳理", "先做题找问题", "题练结合"],
      },
      constraint_note: {
        id: "constraint_note",
        label: "有没有必须避开的时间或额外约束？",
        description: "比如晚自习、社团、周末不想排太满。",
        placeholder: "例如：周三晚上要上社团，周日尽量轻一点",
        suggestedAnswers: ["周末轻一点", "晚自习后别排太满", "没有额外约束"],
      },
      deadline: {
        id: "deadline",
        label: "这轮目标最晚希望什么时候完成？",
        description: "如果没有明确考试日，也可以给我一个大概时间点。",
        placeholder: "例如：7月5日之前",
        suggestedAnswers: ["这周内", "两周内", "本月内"],
      },
      weak_points: {
        id: "weak_points",
        label: "你最担心的薄弱点是什么？",
        description: "哪怕只说 1 到 2 个关键词，我也能据此调整重点。",
        placeholder: "例如：极限定义、导数应用",
        suggestedAnswers: ["基础概念不稳", "做题速度慢", "综合题不会下手"],
      },
    };
    const selectedIds =
      missingFields ??
      (isBlocks
        ? ["daily_minutes", "pacing_style", "focus_preference", "constraint_note"]
        : ["daily_minutes", "focus_preference", "deadline"]);
    const questions = selectedIds
      .filter((item) => item in questionBank)
      .map((item) => questionBank[item]!)
      .slice(0, Math.max(1, askCount));
    return {
      sessionId: this.idGen.next(),
      title: "先确认这版计划的关键约束",
      description: !isBlocks
        ? "我会先补齐关键约束，再正式给出计划。"
        : "积木模式会先和你一起确认 Day 1 的节奏与排序，再共同搭出可替换的计划块。",
      questions: questions.length ? questions : [questionBank["daily_minutes"]!],
    };
  }

  private _apply_clarification_answers(
    payload: StudyPlanRequest,
    answers: ClarificationAnswer[],
  ): StudyPlanRequest {
    const answerMap: Record<string, string> = {};
    for (const answer of answers) {
      if (answer.answer.trim()) {
        answerMap[answer.questionId] = answer.answer.trim();
      }
    }
    const preferences = [...payload.preferences];

    const dailyMinutesText = answerMap["daily_minutes"];
    let availableMinutesPerDay = payload.available_minutes_per_day;
    if (dailyMinutesText) {
      availableMinutesPerDay = this._extract_available_minutes(
        dailyMinutesText.includes("每天") ? dailyMinutesText : `每天 ${dailyMinutesText}`,
      );
    }

    const pacingStyle = answerMap["pacing_style"];
    if (pacingStyle) {
      preferences.push(`计划节奏偏好：${pacingStyle}`);
    }

    const focusPreference = answerMap["focus_preference"];
    if (focusPreference) {
      preferences.push(`学习方式偏好：${focusPreference}`);
    }

    let deadline = payload.deadline;
    if (answerMap["deadline"]) {
      deadline = answerMap["deadline"];
    }

    const constraintNote = answerMap["constraint_note"];
    if (constraintNote && constraintNote !== "没有额外约束") {
      preferences.push(`时间约束：${constraintNote}`);
    }

    let weakPoints = [...payload.weak_points];
    if (answerMap["weak_points"]) {
      const rawItems = answerMap["weak_points"].trim().split(/[、,，/ ]+/).filter((item) => item);
      if (rawItems.length) {
        weakPoints = rawItems.slice(0, 4);
      }
    }

    return {
      ...payload,
      available_minutes_per_day: availableMinutesPerDay,
      deadline,
      weak_points: weakPoints,
      preferences,
      need_user_confirmation: false,
    };
  }

  private _build_reason_summary(payload: StudyPlanRequest, retrievedContext: string[]): string {
    const reasons = [`我先按你现在这轮目标「${this._short_goal(payload.learning_goal)}」来定主线。`];
    reasons.push(`每天先按 ${payload.available_minutes_per_day} 分钟控量，避免计划虚高。`);
    if (payload.deadline) {
      reasons.push(`节奏会参考你给出的截止时间 ${payload.deadline}。`);
    }
    if (payload.weak_points.length) {
      reasons.push(`我会优先覆盖你提到的薄弱点：${payload.weak_points.slice(0, 3).join("、")}。`);
    }
    const historyAdjustment =
      payload.preferences
        .find((item) => item.startsWith("历史执行调整："))
        ?.replaceAll("历史执行调整：", "") ?? "";
    if (historyAdjustment) {
      reasons.push(historyAdjustment);
    }
    const focusHint =
      payload.preferences
        .find((item) => item.startsWith("长期学习方式偏好："))
        ?.replaceAll("长期学习方式偏好：", "") ?? "";
    if (focusHint) {
      reasons.push(`我会沿用你更适应的节奏：${focusHint}。`);
    }
    const fileHint = payload.preferences.find((item) => item.startsWith("资料摘要[")) ?? "";
    if (fileHint) {
      reasons.push("这版安排会尽量结合你上传资料里的正文信息，而不是只看文件名。");
    }
    const evidenceReasons: string[] = [];
    const docHits = collect_document_hits(retrievedContext);
    if (docHits.length) {
      evidenceReasons.push(
        `我检索到你资料库里《${this._material_names(docHits)}》的相关片段，并按它调整了内容。`,
      );
    }
    if (!docHits.length && retrievedContext.length) {
      reasons.push("我还参考了现有知识图谱里的相关内容来补全计划顺序。");
    }
    const budget = Math.max(0, 4 - evidenceReasons.length);
    return [...reasons.slice(0, budget), ...evidenceReasons].join("");
  }

  // ------------------------------------------------------------------
  // 内部：作业式计划（v2）
  // ------------------------------------------------------------------

  /**
   * 作业式计划主流程：解析原话 → 落库 → 按截止日排期 → 返回作业看板。
   *
   * 与目标式计划的区别：这里不生成学习目标，也不覆盖用户的短期计划，
   * 只把「老师布置的事」变成一条条有截止日、可打卡、会催办的条目。
   */
  private async _handle_assignment(args: {
    userId: string;
    requestEcho: Record<string, unknown>;
    memories: FrontendMemory[];
    text: string;
    retrievedContext: string[];
  }): Promise<StudyPilotRunResponse> {
    const result = await this.assignment_service.ingest({
      userId: args.userId,
      text: args.text,
      context: args.retrievedContext,
    });
    const snapshot = result.snapshot;

    // 一句都没解析出来、清单里也没有存量：走澄清链路追问，绝不静默丢弃。
    if (!result.added && !snapshot.total) {
      const clarification: ClarificationPrompt = {
        sessionId: this.idGen.next(),
        title: "这份作业我还差一点信息",
        description: "我没能认出作业内容和截止时间，帮我补一句就行。",
        questions: [
          {
            id: "q1",
            label: "这份作业是什么、什么时候交？",
            description: "例如：数学第三章习题1-20，明天交",
            placeholder: "数学第三章习题1-20，明天交",
            suggestedAnswers: ["明天交", "本周五交", "下周一交"],
          },
        ],
      };
      this._save_pending_session(clarification.sessionId, {
        normalized_payload: this._request_from_user(args.userId),
        request_echo: args.requestEcho,
        memories: args.memories,
        planning_mode: "free",
        assignment_text: args.text,
      });
      return this._makeResponse({
        status: "needs_clarification",
        mode: "assignment-intake",
        request: { ...args.requestEcho, intent: "assignment", assignmentText: args.text },
        message: "这句我还没听出是作业 —— 补一句我就帮你排进日程、盯着截止日。",
        followUp: "比如「数学第三章习题1-20，明天交」。",
        reason: "作业式计划需要作业内容与截止时间两样信息，缺了就问，不猜。",
        next_steps: ["补一句作业内容和截止时间，我立刻排进日程并开始盯截止。"],
        clarification,
        memory_used: args.memories,
      });
    }

    const today = this.assignment_service.today();
    const created = result.items;
    const heads = created
      .slice(0, 3)
      .map((item) => {
        const subject = item.subject ? `${item.subject}·` : "";
        return `${subject}${item.title}（${assignment_countdown(item.due_date, today)}）`;
      })
      .join("；");
    const firstDay = snapshot.schedule[0];
    const sourceNote = result.extractor === "offline" ? "（本地规则解析，没占用模型）" : "";
    const duplicateNote = !created.length ? "这条作业清单里已经有了，我没重复添加。" : "";
    const missingNote = result.missing_due
      ? `其中 ${result.missing_due} 条没听出截止时间，我先排在今天，你可以直接改。`
      : "";
    const planNote = firstDay
      ? `今天先安排 ${firstDay.total_minutes} 分钟，共 ${firstDay.tasks.length} 项。`
      : "";

    return this._makeResponse({
      mode: "assignment-intake",
      request: { ...args.requestEcho, intent: "assignment", assignmentText: args.text },
      message: duplicateNote
        ? duplicateNote
        : `收到，${created.length} 条作业已排进日程${sourceNote}：${heads}。${planNote}${missingNote}`,
      followUp: planNote
        ? "先按日程里的第一条开始做，截止日我会盯着。"
        : "作业清单已就绪，先看「作业」页的排期。",
      reason:
        "作业式计划：按截止日倒排，把每条作业摊到截止前的每一天，" +
        "并复用你的每日时长与课表避让；逾期未完成会在清单里标红。",
      next_steps: [
        `共 ${snapshot.total} 条作业，${snapshot.pending_count} 条待办、${snapshot.overdue_count} 条逾期。`,
        "做完一项就打卡，系统会顺手把它排进复习队列。",
        "逾期的可以一键重新排期，把剩余量摊到后面几天。",
      ],
      assignment: snapshot,
      memory_used: args.memories,
    });
  }

  /** 作业澄清会话需要挂在某个用户身上；作业路径不读学习目标，给个空壳即可。 */
  private _request_from_user(userId: string): StudyPlanRequest {
    const profile = this.runtime_store.get_profile(userId);
    const minutes = Math.trunc(Number(profile["preferred_daily_minutes"] ?? 0));
    return {
      user_id: userId,
      current_level: String(profile["current_level"] ?? ""),
      learning_goal: "",
      available_days_per_week: 5,
      available_minutes_per_day: minutes > 0 ? minutes : 60,
      deadline: null,
      weak_points: [],
      preferences: [],
      need_user_confirmation: false,
    };
  }

  // ------------------------------------------------------------------
  // 内部：计划微调
  // ------------------------------------------------------------------

  private _handle_tweak_plan(args: {
    normalizedPayload: StudyPlanRequest;
    requestEcho: Record<string, unknown>;
    memories: FrontendMemory[];
    params: Record<string, unknown>;
    userMessage: string;
    retrievedContext: string[];
  }): StudyPilotRunResponse {
    const { normalizedPayload, requestEcho, memories, params, userMessage, retrievedContext } = args;
    const changes = this._clean_text(params["changes"]) || userMessage;
    const [rawPlan, source] = this._load_latest_weekly_plan(normalizedPayload.user_id);
    if (!rawPlan.length) {
      return this._makeResponse({
        mode: "tweak-plan-missing",
        request: { ...requestEcho, intent: "tweak_plan", changes },
        message:
          "我还没找到可以微调的当前计划。你先让我生成一版计划，之后说“太难了”“压缩到 30 分钟”“多加练习”，我就能直接帮你改。",
        followUp: "先发我这轮学习目标，我会生成第一版可调整计划。",
        reason: "没有从最近对话或已保存计划中读取到 weekly_plan。",
        next_steps: ["生成一版学习计划", "确认计划后再按实际情况微调"],
        memory_used: memories,
      });
    }

    const [tweakedDays, tweakSummary] = this._tweak_weekly_plan(rawPlan, changes, normalizedPayload);
    if (!tweakedDays.length) {
      return this._makeResponse({
        mode: "tweak-plan-fallback",
        request: { ...requestEcho, intent: "tweak_plan", changes },
        message: "我读到了当前计划，但这版计划结构不完整，暂时没法稳定微调。",
        followUp: "你可以让我重新生成一版，我会把这次反馈一起考虑进去。",
        reason: "当前 weekly_plan 无法转换为可执行任务结构。",
        next_steps: ["重新生成计划并带上这次调整要求"],
        memory_used: memories,
        is_fallback: true,
        error_message: "invalid weekly_plan for tweak",
      });
    }

    const stages: WorkflowStageResult[] = [
      {
        stage: "load_current_plan",
        status: "done",
        summary: `已读取${source}中的当前计划。`,
      },
      {
        stage: "tweak_plan",
        status: "done",
        summary: tweakSummary,
      },
    ];
    const finalMessage = `我已按“${this._short_goal(changes, 32)}”把当前计划调过一版。${tweakSummary}`;
    const nextActions = [
      "先看新版每天总量是否顺手。",
      "如果还不合适，可以继续说“再轻一点”“多加题”“压缩到 45 分钟”。",
      "确认后再开始勾选任务，我会用执行情况继续调下一轮计划。",
    ];
    const plan: StudyPlanPayload = {
      learner_profile: this._analyze_request(normalizedPayload),
      retrieved_context: retrievedContext,
      stages,
      weekly_plan: tweakedDays,
      final_message: finalMessage,
      next_actions: nextActions,
    };
    return this._makeResponse({
      mode: "plan-tweaked",
      request: { ...requestEcho, intent: "tweak_plan", changes },
      message: finalMessage,
      followUp: nextActions[0]!,
      reason: `这次没有重做整版计划，只对当前计划做局部调整。${tweakSummary}`,
      next_steps: nextActions,
      plan,
      memory_used: memories,
    });
  }

  private _load_latest_weekly_plan(userId: string): [Array<Record<string, unknown>>, string] {
    try {
      const conversations = this.runtime_store.list_conversations(userId);
      for (const conversation of conversations.slice(0, 5)) {
        const messages = this.runtime_store.get_messages(conversation.id);
        for (const message of [...messages].reverse()) {
          const raw = message.plan_data_json;
          if (!raw) {
            continue;
          }
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }
          let weeklyPlan = data["weekly_plan"];
          if (!weeklyPlan && data["plan"] && typeof data["plan"] === "object") {
            weeklyPlan = (data["plan"] as Record<string, unknown>)["weekly_plan"];
          }
          if (Array.isArray(weeklyPlan) && weeklyPlan.length) {
            return [weeklyPlan as Array<Record<string, unknown>>, "最近对话"];
          }
        }
      }
    } catch {
      // 忽略读取异常
    }

    const saved = this.runtime_store.get_plan(userId);
    if (saved && Array.isArray(saved.weekly_plan) && saved.weekly_plan.length) {
      return [saved.weekly_plan, "已保存计划"];
    }
    return [[], ""];
  }

  private _tweak_weekly_plan(
    rawDays: unknown[],
    changes: string,
    payload: StudyPlanRequest,
  ): [StudyDayPlan[], string] {
    void payload;
    const days = this._coerce_existing_day_plans(rawDays);
    if (!days.length) {
      return [[], ""];
    }

    const text = changes.toLowerCase();
    const targetMinutes = this._extract_tweak_daily_minutes(changes);
    const wantsShorter = ["没时间", "来不及", "缩短", "减少", "轻一点", "轻松点", "压缩", "降载"].some(
      (word) => changes.includes(word),
    );
    const wantsEasier = ["太难", "降低难度", "简单一点", "基础一点", "看不懂"].some((word) =>
      changes.includes(word),
    );
    const wantsPractice =
      ["多练习", "多刷题", "加练习", "加题", "题多一点"].some((word) => changes.includes(word)) ||
      ["practice", "exercise"].some((word) => text.includes(word));
    const wantsHarder = ["太简单", "加难", "提高难度", "挑战一点"].some((word) =>
      changes.includes(word),
    );

    const adjusted: StudyDayPlan[] = [];
    for (const day of days) {
      let tasks: StudyTask[] = day.tasks.map((task) => ({ ...task }));
      const currentTotal = tasks.reduce((sum, task) => sum + task.duration_minutes, 0);
      let dayTarget = targetMinutes;
      if (dayTarget === null) {
        if (wantsShorter || wantsEasier) {
          dayTarget = Math.max(30, pyTruncInt(currentTotal * 0.75));
        } else if (wantsHarder || wantsPractice) {
          dayTarget = Math.min(180, currentTotal + 20);
        } else {
          dayTarget = currentTotal;
        }
      }
      dayTarget = Math.max(15, Math.min(720, pyTruncInt(dayTarget)));

      if (wantsEasier) {
        for (const task of tasks) {
          if (task.task_type === "mock_exam") {
            task.task_type = "practice";
          }
          task.reason = `已降低难度：${task.reason}`;
        }
      }

      if (wantsPractice) {
        const hasPractice = tasks.some((task) => task.task_type === "practice");
        if (!hasPractice) {
          for (const task of [...tasks].reverse()) {
            if (task.task_type === "learn") {
              task.task_type = "practice";
              task.title = `用题目检查：${task.title}`;
              task.reason = "按你的反馈把这一项改成练习驱动。";
              break;
            }
          }
        }
        const total = tasks.reduce((sum, task) => sum + task.duration_minutes, 0);
        if (total + 15 <= dayTarget && tasks.length < 4) {
          tasks.push({
            title: `追加一组 ${day.focus} 针对性练习`,
            task_type: "practice",
            duration_minutes: 15,
            reason: "按你的反馈增加练习量，用小题组快速暴露问题。",
          });
        }
      }

      const totalBeforeFit = tasks.reduce((sum, task) => sum + task.duration_minutes, 0);
      if (wantsHarder && tasks.length < 4 && totalBeforeFit + 20 <= dayTarget) {
        tasks.push({
          title: `完成一次 ${day.focus} 限时挑战`,
          task_type: "mock_exam",
          duration_minutes: 20,
          reason: "按你的反馈提高挑战度，用限时任务检查掌握程度。",
        });
      }

      tasks = this._fit_tasks_to_minutes(tasks, dayTarget);
      adjusted.push({
        day_index: day.day_index,
        focus: day.focus,
        tasks,
        carry_over: day.carry_over,
      });
    }

    const summaryParts: string[] = [];
    if (targetMinutes !== null) {
      summaryParts.push(`每天控制到约 ${targetMinutes} 分钟。`);
    } else if (wantsShorter) {
      summaryParts.push("整体压缩了每天任务量。");
    }
    if (wantsEasier) {
      summaryParts.push("把高压任务改成更基础、更容易启动的版本。");
    }
    if (wantsPractice) {
      summaryParts.push("增加了练习导向。");
    }
    if (wantsHarder) {
      summaryParts.push("增加了挑战任务。");
    }
    if (!summaryParts.length) {
      summaryParts.push("保留原主线，只做轻量结构整理。");
    }
    return [adjusted, summaryParts.join("")];
  }

  private _coerce_existing_day_plans(rawDays: unknown[]): StudyDayPlan[] {
    const plans: StudyDayPlan[] = [];
    let index = 0;
    for (const rawDayInput of rawDays.slice(0, 5)) {
      index += 1;
      if (!rawDayInput || typeof rawDayInput !== "object") {
        continue;
      }
      const rawDay = rawDayInput as Record<string, unknown>;
      const tasks: StudyTask[] = [];
      for (const rawTaskInput of ((rawDay["tasks"] as unknown[]) ?? []).slice(0, 5)) {
        if (!rawTaskInput || typeof rawTaskInput !== "object") {
          continue;
        }
        const rawTask = rawTaskInput as Record<string, unknown>;
        const task: StudyTask = {
          title: this._clean_text(rawTask["title"]) || "完成一个具体学习任务",
          task_type: this._coerce_task_type(rawTask["task_type"]) as TaskType,
          duration_minutes: this._clamp_minutes(rawTask["duration_minutes"], 30, 720) || 30,
          reason: this._clean_text(rawTask["reason"]) || "这是当前计划中的任务。",
        };
        // v2：微调计划必须保留科目，否则只要改一次计划，多科目分组就全部塌回「未分类」，
        // 计划页的科目筛选条也随之消失（day.focus 里的「/」还在，看起来就很矛盾）
        const subject = this._clean_text(rawTask["subject"]);
        if (subject) {
          task.subject = subject;
        }
        tasks.push(task);
      }
      if (tasks.length) {
        const carryOver = (rawDay["carry_over"] as unknown[]) ?? [];
        plans.push({
          day_index: pyInt(rawDay["day_index"] || index),
          focus: this._clean_text(rawDay["focus"]) || `第 ${index} 天学习`,
          tasks,
          carry_over: carryOver.map((item) => String(item)).filter((item) => item.trim()),
        });
      }
    }
    return plans;
  }

  private _extract_tweak_daily_minutes(text: string): number | null {
    if (text.includes("半小时")) {
      return 30;
    }
    const minuteMatch = /(\d{1,3})\s*(?:分钟|min)/i.exec(text);
    if (minuteMatch) {
      return Math.max(15, Math.min(720, Number.parseInt(minuteMatch[1]!, 10)));
    }
    const hourMatch = /(\d(?:\.\d)?)\s*小时/.exec(text);
    if (hourMatch) {
      return Math.max(15, Math.min(720, pyTruncInt(Number.parseFloat(hourMatch[1]!) * 60)));
    }
    return null;
  }

  private _fit_tasks_to_minutes(tasks: StudyTask[], targetMinutes: number): StudyTask[] {
    return fit_tasks_to_minutes(tasks, targetMinutes);
  }

  // ------------------------------------------------------------------
  // 内部：计划生成
  // ------------------------------------------------------------------

  private _expand_block_plan_to_weekly_plan(
    blockPlan: BlockPlan,
    payload: StudyPlanRequest,
  ): StudyDayPlan[] {
    return this.block_plan_service.expand_to_weekly_plan(blockPlan, payload);
  }

  private _build_block_plan(payload: StudyPlanRequest, retrievedContext: string[]): BlockPlan {
    return this.block_plan_service.build_block_plan(payload, retrievedContext);
  }

  /**
   * 降级说明文案。
   * 「没配 Key」和「连不上模型」对用户来说该做的事完全不同：前者要去填 Key，
   * 后者要检查网络或域名白名单，所以分开写。
   */
  private _fallback_notice(reason: string): string {
    // 只认离线规划 provider。不能写成「不等于 deepseek」—— golden 基线用的 mock
    // 也不是 deepseek，那样会把基线里的降级文案改掉。
    const isOffline = this.providers.llm.describe()["provider"] === "offline-rule";
    if (isOffline) {
      return (
        "当前没有配置模型 Key，下面这版计划由本地规则引擎生成，功能可以正常用。\n" +
        "想让我更懂你的表达，可以在「我的」里填一个 DeepSeek Key。"
      );
    }
    return `没能连上模型，下面这版计划由本地规则生成。\n原因：${reason}`;
  }

  private async _generate_plan_result(
    payload: StudyPlanRequest,
    retrievedContext: string[],
  ): Promise<PlanGeneration> {
    // 已知模型不可达：不再发起请求（避免用户连吃两次超时），直接用规则计划
    if (this._llmUnreachableReason) {
      const fallback = await this._generate_rule_plan(payload, retrievedContext);
      const notice = this._fallback_notice(this._llmUnreachableReason);
      return {
        ...fallback,
        status: "fallback",
        summary: `模型请求失败（${this._llmUnreachableReason}），已改用本地规则计划。`,
        // 必须让用户看见：否则「问什么都被当成学习目标排计划」会显得莫名其妙
        final_message: `${notice}\n\n${fallback.final_message}`,
      };
    }

    const llmInfo = this.providers.llm.describe();
    if (llmInfo["provider"] === "deepseek") {
      try {
        return await this._generate_deepseek_plan(payload, retrievedContext, llmInfo);
      } catch (error) {
        const fallback = await this._generate_rule_plan(payload, retrievedContext);
        return {
          ...fallback,
          status: "fallback",
          summary: `DeepSeek 未返回可用结构化计划，已切换到输入相关的规则计划。原因：${String(error)}`,
        };
      }
    }

    const fallback = await this._generate_rule_plan(payload, retrievedContext);
    // 离线规划模式（壳显式开启且用户没配 Key）：必须说明这版计划是本地规则排的。
    // 注意不能只依赖 _llmUnreachableReason —— 走澄清问答时那个标记会在
    // submit_clarification 开头被重置，提示就丢了（这就是「没配 Key 却悄悄出了计划」的原因）。
    const offlinePlan = llmInfo["provider"] !== "deepseek";
    return {
      ...fallback,
      status: "fallback",
      summary: "当前后端未启用 DeepSeek，已按用户输入和可用时间生成规则计划。",
      final_message: offlinePlan
        ? `${this._fallback_notice("")}\n\n${fallback.final_message}`
        : fallback.final_message,
    };
  }

  private async _generate_deepseek_plan(
    payload: StudyPlanRequest,
    retrievedContext: string[],
    llmInfo: Record<string, unknown>,
  ): Promise<PlanGeneration> {
    const prompt = buildPlanPrompt(payload, retrievedContext);
    const content = await this.providers.llm.generateText(prompt);

    let parsed: Record<string, unknown>;
    let weeklyPlan: StudyDayPlan[];
    try {
      parsed = this._parse_llm_json(content);
      weeklyPlan = this._coerce_weekly_plan(
        (parsed["weekly_plan"] as unknown[]) ?? [],
        payload.available_minutes_per_day,
        payload.available_days_per_week,
      );
      if (!weeklyPlan.length) {
        throw new Error("weekly_plan 为空");
      }
    } catch (error) {
      throw error;
    }

    const finalMessage =
      this._clean_text(parsed["final_message"]) ||
      `DeepSeek 已根据「${this._short_goal(payload.learning_goal)}」生成计划。`;
    const nextActions = (((parsed["next_actions"] as unknown[]) ?? []) as unknown[])
      .map((item) => this._clean_text(item))
      .filter((item) => item)
      .slice(0, 4);

    return {
      weekly_plan: weeklyPlan,
      final_message: finalMessage,
      next_actions: nextActions,
      status: "done",
      summary: `已调用 ${String(llmInfo["model"] ?? "DeepSeek")} 生成结构化学习计划。`,
    };
  }

  private _parse_llm_json(content: string): Record<string, unknown> {
    let cleaned = content.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
    if (fenced) {
      cleaned = fenced[1]!.trim();
    }

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }

    // 去掉 ] 或 } 前的尾随逗号（LLM 常见 JSON 错误）
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // 最后手段：尝试修复字符串内未转义的换行
      cleaned = cleaned.replace(/(?<!\\)"([^"]*\n[^"]*)"/g, (_match, inner: string) => {
        return `"${inner.replace(/\n/g, "\\n")}"`;
      });
      cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
      parsed = JSON.parse(cleaned);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("DeepSeek 响应不是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  }

  private _coerce_weekly_plan(
    rawDays: unknown[],
    dailyMinutes: number,
    maxDays: number,
    defaultSubject = "",
  ): StudyDayPlan[] {
    const plans: StudyDayPlan[] = [];
    let index = 0;
    for (const rawDay of rawDays.slice(0, Math.min(maxDays, 5))) {
      index += 1;
      if (!rawDay || typeof rawDay !== "object") {
        continue;
      }
      const dayDict = rawDay as Record<string, unknown>;

      const tasks: StudyTask[] = [];
      let usedMinutes = 0;
      for (const rawTask of ((dayDict["tasks"] as unknown[]) ?? []).slice(0, 4)) {
        if (!rawTask || typeof rawTask !== "object") {
          continue;
        }
        const taskDict = rawTask as Record<string, unknown>;

        let duration = this._clamp_minutes(
          taskDict["duration_minutes"],
          Math.max(15, Math.min(45, Math.floor(dailyMinutes / 3))),
          Math.max(15, dailyMinutes - usedMinutes),
        );
        if (usedMinutes + duration > dailyMinutes) {
          duration = Math.max(10, dailyMinutes - usedMinutes);
        }
        if (duration <= 0) {
          continue;
        }

        const task: StudyTask = {
          title: this._clean_text(taskDict["title"]) || "完成一个具体学习任务",
          task_type: this._coerce_task_type(taskDict["task_type"]) as TaskType,
          duration_minutes: duration,
          reason: this._clean_text(taskDict["reason"]) || "该任务来自后端模型规划结果。",
        };
        // v2：仅在能确定科目时才写入 subject，保证单科目旧行为与黄金样本不变
        const subjectText = this._clean_text(taskDict["subject"]) || defaultSubject;
        if (subjectText) {
          task.subject = subjectText;
        }
        tasks.push(task);
        usedMinutes += duration;
        if (usedMinutes >= dailyMinutes) {
          break;
        }
      }

      if (tasks.length) {
        plans.push({
          day_index: pyInt(dayDict["day_index"] || index),
          focus: this._clean_text(dayDict["focus"]) || `第 ${index} 天学习`,
          tasks,
          carry_over: [],
        });
      }
    }

    return plans;
  }

  // ------------------------------------------------------------------
  // 内部：长期计划（里程碑）
  // ------------------------------------------------------------------

  get_long_term_plan(userId: string): LongTermPlan | null {
    return this.runtime_store.get_long_plan(userId);
  }

  private _is_date(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
  }

  private _coerce_date(value: unknown, fallback: string): string {
    const text = (this._clean_text(value) || "").slice(0, 10);
    return this._is_date(text) ? text : fallback;
  }

  /** 中文数字/半 → 数值（只处理「一」到「十」和「半」）。 */
  private _parse_cn_number(text: string): number {
    const digits = Number.parseInt(text, 10);
    if (Number.isFinite(digits)) {
      return digits;
    }
    const table: Record<string, number> = {
      一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
      六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5,
    };
    return table[text] ?? 0;
  }

  /**
   * 目标跨度（天）—— 用来判断这是不是一个「一周排不下」的目标。
   *
   * 只读文本里的相对时间表达（3 个月 / 14 天 / 两周）与显式截止日期。
   * **刻意不改动 payload.deadline**：那是既有字段，语义变了会让旧基线漂移。
   */
  private _horizon_days_of(payload: StudyPlanRequest, text: string, today: string): number {
    if (payload.deadline && this._is_date(payload.deadline)) {
      const byDate = days_between(today, payload.deadline);
      if (byDate !== null && byDate > 0) {
        return byDate;
      }
    }
    const normalized = (text || "").replace(/\s+/g, "");
    const monthMatch = /([一二两三四五六七八九十半\d]+)个?月/.exec(normalized);
    if (monthMatch) {
      const months = this._parse_cn_number(monthMatch[1]!);
      if (months > 0) {
        return Math.round(months * 30);
      }
    }
    const weekMatch = /([一二两三四五六七八九十\d]+)个?(?:周|星期)/.exec(normalized);
    if (weekMatch) {
      const weeks = this._parse_cn_number(weekMatch[1]!);
      if (weeks > 0) {
        return Math.round(weeks * 7);
      }
    }
    const dayMatch = /(\d{1,4})\s*(?:天|day)s?/i.exec(normalized);
    if (dayMatch) {
      const days = Number.parseInt(dayMatch[1]!, 10);
      if (days > 0) {
        return days;
      }
    }
    return 0;
  }

  /**
   * v2：生成长期计划（里程碑）。
   *
   * 只有跨度超过一周时才产出；跨度不足或日期不可用时返回 null ——
   * 调用方据此决定要不要附带 longPlan，所以一周以内的目标行为与旧版完全一致。
   */
  async build_long_term_plan(
    payload: StudyPlanRequest,
    subjects: string[],
    sourceText = "",
  ): Promise<LongTermPlan | null> {
    const today = to_date(this.clock.nowIso());
    if (!this._is_date(today)) {
      return null;
    }
    const horizon = this._horizon_days_of(payload, sourceText || payload.learning_goal, today);
    if (horizon <= LONG_TERM_THRESHOLD_DAYS) {
      return null;
    }
    const deadline =
      payload.deadline && this._is_date(payload.deadline)
        ? payload.deadline
        : add_days(today, horizon);
    const stageCount = Math.max(1, Math.min(6, Math.ceil(horizon / 21)));

    let milestones: Milestone[] = [];
    const llmInfo = this.providers.llm.describe();
    if (llmInfo["provider"] === "deepseek" && !this._llmUnreachableReason) {
      try {
        const raw = await this.providers.llm.generateText(
          buildLongTermPlanPrompt({
            goal: payload.learning_goal,
            subjects,
            today,
            deadline,
            totalDays: horizon,
            stageCount,
          }),
        );
        milestones = this._coerce_milestones(
          this._parse_llm_json(raw)["milestones"],
          today,
          deadline,
        );
      } catch (error) {
        console.warn("[Synapse] 长期计划生成失败，回退到规则阶段", error);
      }
    }
    if (!milestones.length) {
      milestones = build_rule_milestones({
        goal: payload.learning_goal,
        deadline,
        today,
        subjects,
      });
    }
    if (!milestones.length) {
      return null;
    }

    return this.runtime_store.save_long_plan(payload.user_id, {
      goal: payload.learning_goal,
      deadline,
      subjects,
      milestones,
    });
  }

  /** 校验并规范模型给的阶段；日期不合法、超出总周期的直接丢弃。 */
  private _coerce_milestones(raw: unknown, today: string, deadline: string): Milestone[] {
    if (!Array.isArray(raw) || !raw.length) {
      return [];
    }
    const milestones: Milestone[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const dict = item as Record<string, unknown>;
      const startDate = this._coerce_date(dict["start_date"], "");
      const rawDue = this._coerce_date(dict["due_date"], "");
      if (!startDate || !rawDue) {
        continue;
      }
      const dueDate = rawDue > deadline ? deadline : rawDue;
      if (dueDate < startDate || startDate < today) {
        continue;
      }
      const title = this._clean_text(dict["title"]) || `第 ${milestones.length + 1} 阶段`;
      milestones.push({
        id: `m${milestones.length + 1}`,
        title: title.slice(0, 12),
        goal: this._clean_text(dict["goal"]) || title,
        subject: "",
        start_date: startDate,
        due_date: dueDate,
        acceptance: this._clean_text(dict["acceptance"]) || `${title}的阶段任务全部完成`,
        status: milestones.length === 0 ? "active" : "pending",
      });
    }
    return milestones;
  }

  /** 当前应推进的阶段（界面与「按阶段排本周」都用它）。 */
  get_active_milestone(userId: string): Milestone | null {
    const longPlan = this.runtime_store.get_long_plan(userId);
    return longPlan ? pick_active_milestone(longPlan.milestones) : null;
  }

  /** 已确认科目（记在用户身上，跨对话保留）。 */
  get_confirmed_subjects(userId: string): string[] {
    return this.runtime_store.get_subjects(userId).map((item) => item.name);
  }

  /**
   * 判断模型从对话里抠出的 goal 是否可信。
   * 目的是拦住「当然算数」这类回答短句被当成学习目标 —— 它随后会被计划提示词当成科目名。
   */
  private _accept_llm_goal(candidate: string): boolean {
    if (!candidate) {
      return false;
    }
    if (candidate.length >= 8) {
      return true;
    }
    if (detect_subject_candidates({ learningGoal: candidate }).length) {
      return true;
    }
    return ["学", "复习", "准备", "考试", "刷题", "背", "练", "备考", "掌握"].some((word) =>
      candidate.includes(word),
    );
  }

  /**
   * 本轮涉及的科目候选：本轮输入/薄弱点命中 ∪ 课程表科目 ∪ 模型给的 subject（需通过校验）。
   */
  private _collect_subject_candidates(payload: StudyPlanRequest, llmSubject = ""): string[] {
    const candidates = detect_subject_candidates({
      learningGoal: payload.learning_goal,
      weakPoints: payload.weak_points,
      timetable: this.runtime_store.get_timetable(payload.user_id),
    });
    const fromLlm = sanitize_subject_candidate(llmSubject);
    if (fromLlm && !candidates.includes(fromLlm)) {
      candidates.push(fromLlm);
    }
    return candidates;
  }

  /** 并入「已确认科目」，返回本轮新增的科目（用于判断这是不是一次中途追加）。 */
  private _merge_confirmed_subjects(userId: string, candidates: string[]): string[] {
    const added: string[] = [];
    for (const name of candidates) {
      if (this.runtime_store.add_subject(userId, name, "对话中提出")) {
        added.push(name);
      }
    }
    return added;
  }

  /**
   * 今天是短期计划的第几个学习日（1 起）。
   * start_date 缺失、日期不可解析、或已超出本期范围时返回 0（表示这一期已走完）。
   */
  current_day_index(startDate: string, lastDayIndex: number): number {
    if (lastDayIndex < 1) {
      return 0;
    }
    // v2 之前的计划没有记 start_date。当作「今天就是第 1 天」，
    // 否则会返回 0（语义是计划已走完），今日列表会毫无理由地空着。
    if (!startDate) {
      return 1;
    }
    const today = to_date(this.clock.nowIso());
    const offset = days_between(startDate, today);
    if (offset === null) {
      return 0;
    }
    const index = offset + 1;
    return index >= 1 && index <= lastDayIndex ? index : 0;
  }

  /** 把已保存的周计划规范化成 StudyDayPlan[]（今日切片、按阶段排课都复用它）。 */
  normalize_saved_days(weeklyPlan: Array<Record<string, unknown>>): StudyDayPlan[] {
    return this._coerce_existing_day_plans(weeklyPlan);
  }

  /**
   * 中途追加科目：在现有周计划上做**增量补排**。
   * 已有条目一律原样保留，所以打卡状态既不会丢、也不会串到新条目上。
   * 返回 null 表示当前没有可追加的计划，交给正常流程生成新计划。
   */
  private _handle_append_subjects(args: {
    payload: StudyPlanRequest;
    requestEcho: Record<string, unknown>;
    memories: FrontendMemory[];
    retrievedContext: string[];
    addedSubjects: string[];
  }): StudyPilotRunResponse | null {
    const saved = this.runtime_store.get_plan(args.payload.user_id);
    if (!saved || !saved.weekly_plan.length) {
      return null;
    }
    const existingDays = this._coerce_existing_day_plans(saved.weekly_plan);
    if (!existingDays.length) {
      return null;
    }

    // 这一期已经走完（今天超出计划范围）时不做追加，交给正常流程开新一期
    const lastDayIndex = Math.max(...existingDays.map((day) => day.day_index));
    const todayIndex = this.current_day_index(saved.start_date, lastDayIndex);
    if (!todayIndex) {
      return null;
    }

    // 增量追加的前提：这份计划里已经有可辨识的科目。
    // 否则（例如尚无科目维度的旧数据）无法安全地在上面加东西，交给正常流程重生成。
    const planSubjects = new Set<string>();
    for (const day of existingDays) {
      for (const task of day.tasks) {
        const name = (task.subject || "").trim();
        if (name) {
          planSubjects.add(name);
        }
      }
    }
    if (!planSubjects.size) {
      return null;
    }
    // 本轮提到的科目如果计划里本来就有，不算追加
    if (args.addedSubjects.every((name) => planSubjects.has(name))) {
      return null;
    }

    const subjectPlans = args.addedSubjects.map((subject) => ({
      subject,
      days: this.rule_plan_service.generate_rule_plan({
        ...args.payload,
        learning_goal: subject,
        weak_points: [],
      }).weekly_plan,
    }));
    const result = append_subjects_to_days(existingDays, subjectPlans, {
      dailyMinutes: args.payload.available_minutes_per_day,
      fromDayIndex: todayIndex,
    });
    const addedText = args.addedSubjects.join("、");
    const requestEcho = {
      ...args.requestEcho,
      intent: "create_plan",
      appended_subjects: args.addedSubjects,
    };

    if (!result.added) {
      return this._makeResponse({
        mode: "append-subjects-full",
        request: requestEcho,
        message:
          `好，${addedText} 我记下了。但这周剩余几天的时间已经被现有任务占满，新任务暂时插不进去。` +
          "你可以让我把现有任务压缩一点，或者告诉我每天能多留出多少时间。",
        followUp: "告诉我要不要先压缩现有任务，我马上重排。",
        reason: "每天剩余可支配时间不足 15 分钟，没有硬塞新任务。",
        next_steps: ["把每天可用时间调大一些", `先压缩现有任务，再把${addedText}插进去`],
        memory_used: args.memories,
      });
    }

    const stages: WorkflowStageResult[] = [
      {
        stage: "load_current_plan",
        status: "done",
        summary: "已读取当前计划，未改动任何已有条目。",
      },
      {
        stage: "append_subjects",
        status: "done",
        summary: `已把 ${addedText} 追加到每天的剩余时间里，共新增 ${result.added} 条任务。`,
      },
    ];
    const finalMessage =
      `好，${addedText} 已经加到这周的计划里了。原有条目和你的打卡记录都原样保留，` +
      `新任务只占用每天的剩余时间` +
      `${result.skipped.length ? `；有 ${result.skipped.length} 处因为当天时间已满没排上` : ""}。`;
    const nextActions = [
      "看看新加的科目每天放的位置顺不顺手。",
      "如果时间不够，可以让我把现有任务压缩一点。",
    ];
    const plan: StudyPlanPayload = {
      learner_profile: this._analyze_request(args.payload),
      retrieved_context: args.retrievedContext,
      stages,
      weekly_plan: result.days,
      final_message: finalMessage,
      next_actions: nextActions,
    };

    return this._makeResponse({
      mode: "subjects-appended",
      request: { ...requestEcho, normalized: args.payload },
      message: finalMessage,
      followUp: nextActions[0]!,
      reason: `没有重做整版计划，只在现有计划上追加了 ${addedText}。`,
      next_steps: nextActions,
      plan,
      memory_used: args.memories,
    });
  }

  /**
   * v2：识别本轮涉及的科目（少于 2 个时返回空数组，表示走单科目旧行为）。
   * 「已确认科目」是权威来源：中途追加过的科目即使本轮没再提，也继续参与排程。
   */
  private _detect_payload_subjects(payload: StudyPlanRequest): string[] {
    const merged = detect_subjects({
      learningGoal: payload.learning_goal,
      weakPoints: payload.weak_points,
      timetable: this.runtime_store.get_timetable(payload.user_id),
    });
    for (const name of this.get_confirmed_subjects(payload.user_id)) {
      if (!merged.includes(name)) {
        merged.push(name);
      }
    }
    return merged.length >= 2 ? merged : [];
  }

  /**
   * 当前唯一确定的科目（本轮识别 ∪ 已确认科目）。
   * 恰好一个时返回它；0 个无法判断、多个应走多科目合并路径，都返回空串。
   */
  private _single_subject_of(payload: StudyPlanRequest): string {
    const subjects = this._collect_subject_candidates(payload);
    for (const name of this.get_confirmed_subjects(payload.user_id)) {
      if (!subjects.includes(name)) {
        subjects.push(name);
      }
    }
    return subjects.length === 1 ? subjects[0]! : "";
  }

  /**
   * v2：多科目规则计划 —— 每个科目各生成一份规则计划，再按天合并并收敛到每日预算，
   * 使每天同时包含多个科目的任务（界面按科目分组展示）。
   */
  private async _generate_multi_subject_rule_plan(
    payload: StudyPlanRequest,
    subjects: string[],
    retrievedContext: string[],
  ): Promise<PlanGeneration> {
    const totalDays = Math.min(Math.max(1, payload.available_days_per_week), 5);
    const subjectPlans = subjects.map((subject) => {
      const result = this.rule_plan_service.generate_rule_plan({
        ...payload,
        learning_goal: subject,
        weak_points: [],
      });
      return { subject, days: result.weekly_plan };
    });

    const merged = merge_subject_plans(subjectPlans, totalDays, payload.available_minutes_per_day);
    const hits = collect_document_hits(retrievedContext);
    const weeklyPlan = hits.length ? this._attach_material_evidence(merged, hits) : merged;
    const summary = `已按科目（${subjects.join("、")}）分别排课并合并到每天的 ${payload.available_minutes_per_day} 分钟预算内。`;

    let finalMessage = "";
    try {
      const llmInfo = this.providers.llm.describe();
      if (llmInfo["provider"] === "deepseek" && !this._llmUnreachableReason) {
        finalMessage = await this.providers.llm.generateText(
          buildMultiSubjectIntroPrompt(
            subjects,
            this._short_goal(payload.learning_goal),
            payload.available_minutes_per_day,
            merged.length,
          ),
        );
      }
    } catch {
      // 模板兜底
    }

    if (!finalMessage) {
      finalMessage =
        `我先按你输入的「${this._short_goal(payload.learning_goal)}」整理了这版计划，` +
        `涉及 ${subjects.join("、")} 这几科，每天会同时安排，各自控制在 ${payload.available_minutes_per_day} 分钟总预算内。`;
    }
    if (hits.length) {
      finalMessage = `${finalMessage}\n（这版安排参考了你上传的《${this._material_names(hits)}》。）`;
    }

    return {
      weekly_plan: weeklyPlan,
      final_message: finalMessage,
      next_actions: [
        "看看每天各科的比例是否合适，需要调整可以直接告诉我。",
        "补充截止时间或每天可用时间，可以让计划更贴近真实约束。",
      ],
      status: "fallback",
      summary,
    };
  }

  private async _generate_rule_plan(
    payload: StudyPlanRequest,
    retrievedContext: string[],
  ): Promise<PlanGeneration> {
    const subjects = this._detect_payload_subjects(payload);
    if (subjects.length >= 2) {
      return this._generate_multi_subject_rule_plan(payload, subjects, retrievedContext);
    }

    const result = this.rule_plan_service.generate_rule_plan(payload);
    let weeklyPlan = result.weekly_plan;

    // v2：单科目时也给任务打上科目标签 —— 界面按科目分组、以及「中途追加科目」的
    // 增量判断都依赖这个字段；纯规则计划（模型不可用时）也要能工作。
    const singleSubject = this._single_subject_of(payload);
    if (singleSubject) {
      weeklyPlan = weeklyPlan.map((day) => ({
        ...day,
        tasks: day.tasks.map((task) => ({ ...task, subject: singleSubject })),
      }));
    }

    const hits = collect_document_hits(retrievedContext);
    if (hits.length) {
      weeklyPlan = this._attach_material_evidence(weeklyPlan, hits);
    }

    const topic = this.rule_plan_service.infer_topic(payload.learning_goal, payload.weak_points);
    const focus = payload.weak_points.length ? payload.weak_points.slice(0, 3).join("、") : topic;
    const deadlineNote = payload.deadline ? `我已把截止时间 ${payload.deadline} 作为节奏参考。` : "";

    let finalMessage = "";
    try {
      const llmInfo = this.providers.llm.describe();
      if (llmInfo["provider"] === "deepseek" && !this._llmUnreachableReason) {
        const planSummary = weeklyPlan
          .slice(0, 3)
          .map(
            (d) =>
              `Day${d.day_index}:${d.focus}(${d.tasks
                .slice(0, 2)
                .map((t) => t.title.slice(0, 10))
                .join("/")})`,
          )
          .join("、");
        finalMessage = await this.providers.llm.generateText(
          buildRulePlanMessagePrompt(
            this.rule_plan_service.short_goal(payload.learning_goal),
            focus,
            planSummary,
            weeklyPlan.length,
            deadlineNote,
          ),
        );
      }
    } catch {
      // 模板兜底
    }

    if (!finalMessage) {
      finalMessage = result.final_message;
    }
    if (hits.length) {
      finalMessage = `${finalMessage}\n（这版安排参考了你上传的《${this._material_names(hits)}》。）`;
    }

    return { ...result, weekly_plan: weeklyPlan, final_message: finalMessage };
  }

  private _attach_material_evidence(
    weeklyPlan: StudyDayPlan[],
    hits: ParsedDocumentHit[],
  ): StudyDayPlan[] {
    if (!weeklyPlan.length || !hits.length) {
      return weeklyPlan;
    }
    const firstDay = weeklyPlan[0]!;
    if (!firstDay.tasks.length) {
      return weeklyPlan;
    }
    const snippet = String(hits[0]!.excerpt ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 60);
    const note = `参考你上传的《${hits[0]!.file_name}》：${snippet}…`;
    return weeklyPlan.map((day, dayIndex) => {
      if (dayIndex !== 0) {
        return day;
      }
      return {
        ...day,
        tasks: day.tasks.map((task, taskIndex) =>
          taskIndex === 0 ? { ...task, reason: `${task.reason}（${note}）` } : task,
        ),
      };
    });
  }

  private _material_names(hits: ParsedDocumentHit[]): string {
    return [...new Set(hits.map((hit) => hit.file_name))].join("、");
  }

  // ------------------------------------------------------------------
  // 内部：规则服务委托
  // ------------------------------------------------------------------

  private _short_goal(text: string, limit = 24): string {
    return this.rule_plan_service.short_goal(text, limit);
  }

  private _clamp_minutes(value: unknown, fallback: number, upper: number): number {
    return this.rule_plan_service.clamp_minutes(value, fallback, upper);
  }

  private _coerce_task_type(value: unknown): string {
    return this.rule_plan_service.coerce_task_type(value);
  }

  private _clean_text(value: unknown): string {
    return this.rule_plan_service.clean_text(value);
  }
}
