# Synapse 三层架构设计（TypeScript 核心）

> 状态：已确认核心决策，P0 进行中。旧仓 `../Synapse` 保持可用，本目录独立演进，行为对齐后逐端切换。

## 0. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 核心语言 | TypeScript | 唯一能进入微信小程序且不加服务器的路径；同时收敛技术栈 |
| 服务模型 | 无中间服务器 | 产品硬约束：用户设备直连模型商（DeepSeek） |
| 存储引擎 | **砍掉 SQLite，统一 KV/文档存储**（已定案） | 数据量小、查询全部按键取数；每端适配器约 50 行、零原生代码；接口不变实现可换，无不可逆承诺 |
| 既有数据 | 首启一次性自动迁移，迁移后备份旧库不删除 | `synapse.db` → KV 转换器随壳发布 |
| 壳框架 | 桌面/安卓**尝试**收敛 Tauri 2（含 Mobile）；失败回退"去 Python 后的 Kotlin 薄壳" | 删 Kotlin/Gradle 工具链；成熟度风险有退路 |
| 小程序 | 架构留路，排期最后（P6） | 目标是"能做最好"，不阻塞现有三端 |
| 小程序 UI 框架 | 暂记 Taro，P6 终审时可改原生 | 收益模糊，暂缓决定 |
| 旧重构计划 | 作废 | 本文替代 `Synapse/docs/REFACTOR_PLAN.md`；其接口基线思路被 P0 吸收 |

### 0.1 小程序 v2 范围扩展（2026-09，产品要求优先级调整）

小程序先于 web 端做，并按实际使用反馈做了三项**有意超出原计划**的变更。记录在此，避免与上文约束混淆：

| 变更 | 内容 | 与原约束的关系 |
|---|---|---|
| 任务加科目维度 | `StudyTask.subject?`（可选）；一份周计划内按科目分组展示 | **突破**"不改数据模型字段"；字段可选，不填时输出与旧基线逐字一致 |
| 会话落库与多轮 | `StudyPilotRunRequest/ClarificationRequest` 增加可选 `conversationId`；core 按会话读历史并写入消息 | 新增可选入参；不传时行为与旧版一致 |
| 课程表避让 | 新增 `TimetableEntry` 与 `timetable:{userId}` 键空间；计划生成时避开上课时段并按空闲时长压缩 | **突破**"不新增产品功能"；仅在导入课表后影响输出 |
| 科目注册表 | 新增 `subjects:{userId}` 与 `ConfirmedSubject`：科目**记在用户身上、跨对话保留**，每轮只做并入 | **突破**"不引入新状态"；未登记任何科目时行为与旧版一致 |
| 追加科目走增量补排 | 已有当前计划时，新科目只插进每天的**剩余预算**，已有条目一律不动（`append_subjects_to_days`） | 保护打卡不串味：条目身份不变，进度才不会错位 |
| 计划版本留档 | 新增 `plan_versions:{userId}` 与 `PlanVersionRecord`：每一版都留档（最多 30 版），可回到某一版 | 一版执行完后想调整，不必从零重生成 |
| 三层计划 | 长期（`long_plan:{userId}` + `Milestone`）→ 短期（现有 `weekly_plan`）→ 今日（`today:{userId}` + `TodayItem`）；计划页按「今日 / 短期 / 长期」三个 tab 组织 | **突破**"不改数据模型"；只有目标跨度 > 7 天时才产出长期阶段，一周以内的目标行为与旧版一致 |
| 今日待办与顺延 | 今日从短期计划按日期切片；未完成项跨天自动顺延并标记来源；勾选写进同一份进度存储 | 打卡身份（天+科目+标题）保证今日页与短期计划是同一份数据 |
| 间隔重复复习 | 新增 `review:{userId}` 与 `ReviewItem`，SM-2 调度；**完成学习类任务自动入队**，到期项按每日配额排进今日待办 | 纯本机状态，完全离线；不入队时旧行为不变 |
| 本地资料检索 | 新增资料库（粘贴导入 + 切片），检索由「关键词包含计数」升级为 **BM25**（中文双字索引、零依赖） | 升级的是打分算法与入口；无资料时输出与旧版一致（仍返回空数组） |

进度口径同步调整：任务的打卡标识改为**内容身份**（天 + 科目 + 标题），不再是数组下标；下标会随重排漂移，导致旧打卡套到新条目上。

配套测试策略（保持旧行为不漂移）：
- `baseline/` 黄金样本**不修改**，仍代表旧 Python 实现的行为事实。
- `httpBaseline.spec.ts` 继续逐字比对，比对前仅剥离本次有意新增的字段（`subject` / `version` / `updated_at` / `change_summary`）。
- 新增 `v2Features.spec.ts` 覆盖新行为（课表解析与避让、多科目识别与合并、会话隔离与落库、计划版本、科目注册与增量追加、答句护栏、三层计划、今日顺延、SM-2 与 BM25）。

## 1. 三层划分

```text
┌──────────────────────── shells（平台壳）────────────────────────┐
│  web (React/Vite) │ desktop (Tauri 2) │ android (Tauri Mobile / Kotlin 回退) │ miniprogram (Taro/原生) │
└──────────────────────────────┬─────────────────────────────────┘
                               │  protocol（契约层）
                               │  TS 接口（默认，进程内直调）＝ HTTP/SSE（可选传输）
┌──────────────────────────────┴─────────────────────────────────┐
│                     core（纯 TS，零运行时依赖，禁 Node/DOM API） │
└─────────────────────────────────────────────────────────────────┘
```

- **core**：换平台时一字不改的代码——提示词拼装、意图判断、计划生成/调整算法、澄清状态机、工具分发、Provider 抽象、数据模型、SSE 事件定义、存储接口。
- **shells**：只为某个平台存在的代码——WebView/窗口生命周期、存储适配器、文件选择器、UI 渲染、打包签名、启动脚本。
- **protocol**：核心与壳之间的契约。请求/响应类型、SSE 事件流、错误语义。核心内嵌时是 TS 函数调用；需要跨网络时是 HTTP/SSE。同一份契约，两种传输绑定。

## 2. 目标目录

```text
SynapseNext/
  packages/
    core/                     平台无关核心 + 协议契约
      src/
        protocol/             请求/响应类型、SSE 事件、错误语义（不引用任何层）
        domain/               纯计算：rule/block plans、plan tweaks、plan codec
        application/          用例编排：study workflow、clarification、intent、generation、prompts
        providers/            LLM/检索/日历/通知 契约、DeepSeek 直连实现、Mocks
        storage/              仓储接口（ports）+ 内存 KV 实现（测试/开发用）
        ports/                HttpTransport、StreamTransport、FileExtractor 等壳注入接口
      test/
  apps/
    web/                      Web 壳（React/Vite，UI 从旧仓 frontend/studygg 迁移）
    desktop/                  Tauri 2 壳（复用 apps/web 构建产物 + fs 存储适配器）
    android/                  Tauri Mobile（首选）或 Kotlin WebView 薄壳（回退）
    miniprogram/              小程序壳（P6 阶段）
  baseline/                   P0 产物：旧仓接口与行为基线（黄金样本）
    capture.py                可重复执行的捕获脚本（假 Key、假 LLM、临时数据目录）
    openapi.json              旧仓接口契约快照
    golden/                   行为黄金样本
  docs/
    architecture.md           本文
```

- 用 npm workspaces 管理（Node 自带，不引入额外工具）。
- core 目标零运行时依赖；若引入 schema 校验（zod 级别的小库），单独评审。

## 3. 核心内部依赖方向

```text
protocol（最底层，无依赖）
  ↑
domain（只依赖 protocol）
  ↑
application（依赖 domain、providers 契约、storage 接口、ports）
  ↑
providers 实现 / storage 实现（依赖契约与 ports，由组装处注入）
```

硬性规则（后续用边界测试强制）：

- core 任何文件不得 import Node 内置模块、DOM、wx、Tauri API。
- 网络只经 `ports/HttpTransport`（壳注入：WebView/Node 用 fetch，小程序包 wx.request）。
- 存储只经 `storage/` 接口（壳注入 KV 适配器或内存实现）。
- domain 为纯函数，无 IO、无异步副作用。

## 4. 旧模块逐条处置清单

| 旧模块（Synapse 仓） | 处置 | 说明 |
|---|---|---|
| `app/domain/rule_plans.py`、`block_plans.py` | 翻译 | 纯算法，逐函数译为 TS，语义不变 |
| `workflow.py` 中提示词拼装 | 翻译 | 文案逐字保留，进 `application/study/prompts.ts` |
| `workflow.py` 意图判断/工具分发 | 翻译 | 保留强制工具选择顺序与降级 |
| `workflow.py` 澄清状态机 | 翻译 | `PendingClarificationSession` 语义、一次性消费不变 |
| 计划生成/tweak/codec（`_tweak_weekly_plan`、`_parse_llm_json` 等） | 翻译 | 进 domain，15/30/90 分钟拟合等行为对齐 |
| `providers/base.py` 契约 | 重写 | TS interface + ProviderBundle；Mocks 同步移植 |
| `providers/deepseek.py`（LangChain） | 重写 | 约 150 行直连实现：tool calling、JSON mode、流式；DeepSeek 为 OpenAI 兼容协议 |
| `graphs/`（LangGraph 6 节点线性图） | 废弃 | 无 checkpoint/interrupt，状态机直接并入 application/workflow |
| `db/models.py`（9 张表） | 翻译 | 数据结构译为 TS 类型 + KV 键空间设计，不再使用 SQL |
| `db/store.py`、`repositories/` | 翻译 | 仓储接口的 KV 实现，键空间分桶（`messages:{conversationId}` 等） |
| `db/retrieval.py`（networkx） | 重写 | 9 节点 10 边规模，手写邻接查询，数据存 KV 桶 |
| `file_extract.py` | 拆分 | txt 解码进 core；PDF 提取为 `ports/FileExtractor`，壳注入 pdf.js |
| FastAPI routes/schemas | 翻译 | 进 `protocol/`；HTTP 传输为可选绑定 |
| 前端 `App.jsx`（约 2100 行） | 迁移+拆分 | 迁入 apps/web，按功能拆 components/features/hooks；services 层改为进程内调 core |
| Chaquopy/Python 安卓运行时 | 废弃 | 安卓壳只剩 WebView 壳层；启动超时嫌疑随 Python 进程一并消失 |

功能承诺：现有 Web/桌面/安卓三端功能不阉割。小程序为新增端，其 PDF 提取能力列为 P6 验证项（pdf.js 体积），不作为对现有功能的回归。

## 5. 存储设计（KV 方案）

**键空间分桶**（杜绝"一个大 JSON"）：

```text
profile                         用户画像/API Key（单键）
conversations                   会话清单（单键，按 updated 排序）
messages:{conversationId}       每会话消息一桶，按需加载
clarifications:{conversationId} 待确认会话
plans:{userId}                  已保存计划（v2 起含 version / change_summary / updated_at）
progress:{yyyy-mm}              进度快照按月分桶
assessments:{yyyy-mm}           能力评估按月分桶
timetable:{userId}              课程表条目（v2）
kg:nodes / kg:edges             知识图谱（种子 9 节点 10 边）
```

- 查询模式全部按键取数（无全文搜索、无关联查询），KV 完全覆盖；SQL 优势本就用不到。
- 适配器（每个约 50 行，零原生代码）：desktop → Tauri fs 插件 JSON 文件；android → WebView IndexedDB/localStorage；web 开发 → IndexedDB 或内存；miniprogram → wx.storage。
- 数据增长：重度用户约几十 MB/年（主要是 messages），分桶 + 按需加载可覆盖；真超预期时给单平台补写 SQLite 适配器，核心零改动——接口即保险。
- 小程序 wx.storage 上限 10MB 是真正的天花板，P6 评估保留/归档策略（产品决策，可后议）。
- 旧数据迁移：桌面/安卓首启一次性自动迁移 `synapse.db` → KV；转换器随壳发布，迁移成功后备份旧库文件（不删除），迁移结果校验记录数并抽样比对。

## 6. 协议契约

- 以现行 `/api/v1` 请求/响应形状与 SSE 事件为冻结基线（字段名、别名、事件顺序不变），基线快照存于 `baseline/`。
- core 导出单一入口接口 `SynapseCore`：run（流式）、confirm、expandBlocks、extractFiles、plan CRUD、conversations、settings。
- 默认传输为进程内直调；HTTP/SSE 服务器为可选壳（开发调试、未来可能的远程场景），不在本期范围。

## 7. 精简对照

| | 现在 | 目标 |
|---|---|---|
| 语言/运行时 | Python、TypeScript/JS、Kotlin、Rust、PowerShell | TypeScript（唯一手写语言）+ 壳框架内部原生层 |
| 关键依赖 | FastAPI、LangChain、LangGraph、SQLModel、networkx、pypdf、Chaquopy | core 零依赖；产品运行时依赖：react、pdfjs |
| 存储 | SQLModel + SQLite（各端 SQL 适配） | 统一 KV 接口 + 每端约 50 行适配器，零原生代码 |
| 安卓运行时 | 内嵌 CPython（Chaquopy） | 无，核心跑在 WebView |
| 测试 | pytest +（未建的前端测试） | Vitest 全端统一 |

## 8. 阶段路线

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| P0 | 本文档确认；从旧仓提取接口基线/黄金样本（假 Key、假 LLM） | 基线样本入 `baseline/`，可重复执行 | 已完成（13 个 golden 文件，两次执行哈希一致） |
| P1 | packages/core 骨架；domain 翻译；单测对齐旧行为 | domain 用例输出与 Python 版逐字一致 | 已完成（rule/block plans 翻译，3 个黄金样本回放测试全过 + typecheck 通过） |
| P2 | application/providers/storage/ports 翻译；DeepSeek 直连（假 transport 断言 URL/认证/消息体） | core 全量单测通过；无真实模型调用 | 已完成（20 测试全过：10 个 HTTP 黄金样本回放 + DeepSeek 假 transport + domain + 边界规则；typecheck 通过） |
| P3 | apps/web 接入：UI 迁移、services 改进程内调 core | 现有 Web 功能人工清单回归通过 | 未开始 |
| P4 | desktop（Tauri）接入 + KV fs 适配器 + `synapse.db` 自动迁移验证 | 桌面构建通过；旧数据迁移后完整可读 | 未开始 |
| P5 | android：首选 Tauri Mobile 收敛，失败回退 Kotlin 薄壳；真机验收 | 冷/热启动、聊天、上传无回归；验证启动超时消失 | 未开始 |
| P6 | miniprogram + wx 适配器（storage/http/PDF/流式验证） | 小程序内完成核心流程冒烟 | 已按 v2 范围重做（见 §0.1）：引导页 + 会话列表 + 科目分组计划 + 课程表导入；38 个 core 测试 + typecheck 通过。PDF 提取与流式仍为未做项 |

每阶段完成即停，交接后再进入下一阶段；任何协议/语义变化立即停止并回退。

## 9. 明确不做的事

- 不引入服务器、云函数、微服务。
- 不重新设计 UI/交互，不新增产品功能。
- 不改提示词文案、计划算法语义、SSE 事件结构、数据模型字段。
- 不删除或迁移旧仓，不动旧仓用户数据与未关闭的调试记录；旧库迁移只读不写。

## 10. 风险与开放问题

| 项 | 风险/问题 | 处置 |
|---|---|---|
| 旧库迁移正确性 | 9 张表 → KV 的转换遗漏 | 迁移后校验记录数 + 抽样比对；旧库备份保留 |
| KV 数据增长 | messages 长期累积 | 分桶 + 按需加载；超预期时单平台补 SQLite 适配器，核心不变 |
| 小程序存储上限 | wx.storage 10MB | P6 评估保留/归档策略 |
| 小程序 PDF | pdf.js 包体积可能超限 | P6 专项验证；超限则小程序首版 PDF 降级提示（不属现有功能回归） |
| 小程序流式 | wx.request chunked 与 SSE 兼容性 | P6 用真机验证；备选 WebSocket |
| 安卓壳形态 | Tauri Mobile 成熟度 | P5 先尝试；失败回退 Kotlin 薄壳（约 200 行） |
| 翻译保真 | 1900 行 workflow 的行为漂移 | P0 基线 + P1/P2 逐模块对照测试兜底 |
