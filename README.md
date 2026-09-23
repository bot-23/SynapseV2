# SynapseNext

AI 学习陪伴助手。目标形态是 **「一个核心，多平台可用」**：领域逻辑只写一份 TypeScript，Web / 小程序 / 桌面 / 安卓共用同一份核心，各平台只提供薄壳。

本仓库是从旧 Python 后端（`Synapse/`）按 [docs/architecture.md](docs/architecture.md) 平移而来的 v2 实现。

---

## 当前状态

这是**已交付微信小程序与浏览器 Web 两个应用壳**的版本，核心学习规划链路、离线规则模式、本地资料检索、课程表避让、三层计划、复习闭环，以及**作业式计划（老师布置的任务 → 排进日程 → 盯着截止）**在两大平台均已落地。桌面和 Android 仍只有架构规划，没有对应应用壳。

状态口径：

| 标记 | 含义 |
| --- | --- |
| ✅ 已实现 | 已有可调用代码与界面，并通过当前自动化测试或预览验证 |
| 🧪 实验性 | 已有独立验证入口，但尚未接入正式业务主链路 |
| 🧩 接口已留 | core 已定义端口或协议，平台实现尚未接入 |
| ⏳ 未实现 | 当前仓库没有可交付实现 |

最近一次验证结果：

- core 单元测试、黄金样本、边界与压力测试：**108/108 通过**（含 22 句作业抽取评测：截止日/数量/科目 100%）
- core、小程序与 Web TypeScript 类型检查：通过
- vendor 导入边界：通过（core 对外导出 163 个，检查 35 个壳文件）
- Web Playwright 端到端测试：**21/21 通过**
- Web 生产构建、微信小程序生产构建：通过
- 真实中文 TXT：导入后切出 1 段，能在离线计划的消息、理由和 Day 1 任务中引用资料名

> 自动化测试覆盖 core 行为，不等于所有微信原生交互都已真机验收。`chooseMessageFile`、网络合法域名、云开发 AI 等仍受微信运行环境影响。

---

## 功能全景

### 用户可直接使用

| 模块 | 状态 | 当前实现 |
| --- | --- | --- |
| 首次引导 | ✅ | 填写并真实校验 DeepSeek API Key；也可跳过，直接进入本地规则模式 |
| AI 对话 | ✅ | 多轮会话、会话隔离、新建/切换/删除历史会话、失败后保留输入 |
| 意图编排 | ✅ | 区分闲聊、澄清、制定计划、微调计划、重做计划、教学答疑、记忆用户信息 |
| 澄清问答 | ✅ | 信息不足时生成可点击选项；提交后继续同一轮计划流程 |
| 自由计划 | ✅ | 根据目标、薄弱点、可用时间、截止日期生成按天任务 |
| 积木计划 | ✅ | 先生成 Day 1 可替换积木，再展开成一周计划 |
| 离线规则计划 | ✅ | 未配置 Key 或模型不可达时仍能生成可执行计划，并明确提示降级原因 |
| 多科目计划 | ✅ | 自动识别科目、按科目分别排程，再合并到每日时间预算 |
| 中途追加科目 | ✅ | 只占用未来日期的剩余预算，不重排旧任务，不破坏已有打卡 |
| 计划微调 | ✅ | 支持“太难”“压缩到 30 分钟”“多加练习”等局部调整 |
| 计划版本 | ✅ | 最多保留 30 版，可恢复历史版本；恢复会生成新版本，打卡记录保留 |
| 今日待办 | ✅ | 从短期计划按日期切片，可手动加/移出任务，未完成项跨天顺延 |
| 长期计划 | ✅ | 跨度超过一周时生成里程碑，也可手动输入目标和截止日期划分阶段 |
| 阶段转短期计划 | ✅ | 可选择长期计划中的某个里程碑，重新生成本周计划 |
| 复习队列 | ✅ | 完成学习任务自动入队；按 SM-2 安排到期复习，也可手动添加知识点 |
| 课程表 | ✅ | 粘贴文本解析（钟点或「第 N-M 节」，后者按默认作息表换算）、自动分列教室与教师、手动录入、逐条校正；计划按空闲时间压缩任务量 |
| 资料库 | ✅ | 支持粘贴文本、多选 `.txt` / `.md` / `.pdf` 批量导入（逐个返回成功/失败，单个失败不阻塞其他）、超限明确提示、中文解码、切片与删除 |
| PDF 导入（Web） | ✅ | 壳注入 pdf.js 逐页抽取文字（动态 import 分包，主包只涨 2KB）；CMap 由 `scripts/copy-pdfjs-cmaps.mjs` 从 node_modules 复制到本地静态目录，中文 CID 字体不乱码，且不依赖外网 CDN |
| 资料结构化元数据 | ✅ | 每份资料带科目（关键词表自动推断，可手改）、标签、来源（上传/粘贴）、字数、图谱节点数与复习卡数；旧数据读取侧补默认值，不需要迁移 |
| 资料自动构图 | 🧪 | 每份资料可显式构建图谱；有 Key 时由模型抽取，无 Key/调用失败时降级为本地 bigram 高频词；构图后把节点 ID 回写到资料上 |
| 图谱可视化 | ✅ | Web 使用 SVG、小程序使用 Canvas 环形布局；支持节点分类着色与点击查看说明 |
| 资料转复习 | 🧪 | 构图或一键学习化后，将新知识点去重加入次日 SM-2 复习队列，并把复习卡 ID 回写到资料上 |
| 一键学习化 | ✅ | 资料库一个按钮串起「构建图谱 → 生成复习卡」，两步各自失败独立提示 |
| 作业式计划 | ✅ | 把老师布置的作业原话（「数学第三章习题1-20明天交」）解析成条目：有 Key 走 JSON 结构化抽取，无 Key 走本地日期词表 + 数量正则；按截止日倒排摊到每一天，复用每日预算与课表避让 |
| 作业打卡与逾期 | ✅ | 清单按截止日分组，显示 D-n / 今天截止 / 已逾期；打卡翻转状态并自动入复习队列；逾期项可一键重新排期，把剩余量摊到后续几天 |
| 作业包分享 | ✅ | 把未完成作业打包成一段可扫码的纯文本短码（首行带 `SYNAPSE-ASG/1` 签名）；Web 端生成二维码，小程序 `scanCode` 扫码或粘码导入；按「标题 + 截止日」去重，同一包反复导入、互相转发都不会长出重复条目 |
| 学习仪表盘 | ✅ | 今日完成率、本周打卡天数、逾期作业数、今日待复习数、按科目的能力值（Lv + 进度条） |
| 数据导出 | ✅ | 一键导出全部本地 KV 数据为 JSON（Web 下载文件、小程序复制到剪贴板），导出内容不含 API Key |
| 演示数据 | 🧪 | 开发/体验环境一键载入数学错题资料、三天计划、打卡、到期复习、资料图谱与作业清单（含 1 条逾期） |
| 本地检索 | ✅ | BM25 + 中文相邻双字索引；资料、画像、执行记录、课程表、知识图谱统一进入上下文预算 |
| 资料证据 | ✅ | 命中资料后，计划消息、理由、首个任务和计划卡片显示资料名与来源摘要 |
| 教学答疑检索 | ✅ | 教学问题命中资料时，将文件名和片段加入提示词；没有资料时保持旧提示词 |
| AI 内容标识 | ✅ | AI 消息与计划卡片显示“AI 生成”；资料命中时显示“依据：你的资料《X》” |
| 用户画像 | ✅ | 本地保存姓名、年级；姓名首次设定后锁定 |
| 科目注册表 | ✅ | 对话识别出的科目跨会话保留，识别错误可在“我的”页删除 |
| 数据清理 | ✅ | 一键清空画像、计划、进度、课程表、资料与 API Key |
| 知识图谱 | ✅ | 内置 9 个节点、10 条边，并可从个人资料增量生长，为计划提供相关节点和学习路径建议 |

### 小程序页面清单

| 页面 | 路由 | 类型 | 能力 |
| --- | --- | --- | --- |
| 首次引导 | `pages/onboarding/index` | 启动页 | Key 校验、跳过并使用本地规则模式 |
| 对话 | `pages/chat/index` | Tab | 多轮对话、自由/积木模式、澄清卡片、计划卡片、AI 标识 |
| 计划 | `pages/plan/index` | Tab | 今日、短期、长期、复习四个视图 |
| 我的 | `pages/mine/index` | Tab | 画像、科目、Key、仪表盘、课程表、资料库、作业清单、知识图谱、数据导出、演示数据与数据清理入口 |
| 历史会话 | `pages/conversations/index` | 二级页 | 新建、切换、长按删除会话 |
| 课程表 | `pages/timetable/index` | 二级页 | 文本解析、手动录入、校正、保存 |
| 资料库 | `pages/documents/index` | 二级页 | 粘贴或选择 TXT/MD（可多选）、查看元数据与切片摘要、一键学习化、编辑标题/科目/标签、构图谱、删除（PDF 仅 Web 端支持） |
| 作业清单 | `pages/assignments/index` | 二级页 | 粘贴作业原话排期、按截止日分组、倒计时、打卡、逾期重新排期、未来 7 天日程、生成作业包短码、扫一扫/粘码导入 |
| 知识图谱 | `pages/graph/index` | 二级页 | 环形可视化节点与关系、点击节点查看说明 |
| 云开发 AI 自检 | `pages/cloudcheck/index` | 实验页 | 探测 provider/model、思考模式、工具调用、JSON mode、流式输出 |

### Web 页面清单

Web 壳是单页应用，用视图状态切换而非路由表；左侧栏提供主导航，窄屏（≤760px）自动改为固定底部导航。

| 视图 | 组件 | 能力 |
| --- | --- | --- |
| 首次引导 | `pages/Onboarding.tsx` | 填写姓名与年级，或跳过直接进入本地规则模式 |
| 对话 | `pages/Chat.tsx` | 多轮会话、自由/积木模式、澄清卡片、计划卡片、AI 标识 |
| 计划 | `pages/Plan.tsx` | 今日、短期、长期、复习四个视图 |
| 我的 | `pages/Mine.tsx` | 画像、科目、Key、仪表盘、课程表/资料库入口、图谱入口、数据导出、演示数据、清空数据 |
| 资料库 | `pages/Documents.tsx` | 粘贴或批量选择 TXT/MD（2MB 上限）、元数据与切片摘要、一键学习化、编辑标题/科目/标签、构图谱、删除 |
| 作业 | `pages/Assignments.tsx` | 粘贴作业原话排期、按截止日分组、倒计时、打卡、逾期重新排期、未来 7 天日程、生成二维码作业包、粘码导入（另有小程序端 `scanCode` 扫码） |
| 课程表 | `pages/Timetable.tsx` | 文本解析、手动录入、校正、保存 |
| 知识图谱 | `pages/Graph.tsx` | SVG 环形布局、按分类着色、点击节点查看说明 |

### 已实现但有边界

| 能力 | 当前边界 |
| --- | --- |
| 资料格式 | Web 端开放 `.txt` / `.md`（含 `.markdown` / `.mdx`）/ `.pdf`；小程序端仍只有文本类（未接 pdf.js）。core 通过 `ports/FileExtractor` 分发，PDF 提取器由壳注入 |
| PDF 抽取 | Web 端由 pdf.js 逐页取 textContent；扫描件（图片版 PDF）**没有文字层，抽不出内容**，会给出「可能是扫描件，当前不支持 OCR」的明确提示而不是静默空结果 |
| PDF 体量 | 文本类文件上限 2MB，PDF 上限 30MB；抽取文字仍受 core 的 20 万字索引上限约束，超出即停止翻页 |
| 中文编码 | TXT 按 UTF-8 → GBK → GB2312 尝试；最终退回 UTF-8 宽松解码 |
| 资料长度 | 单文件界面限制 2MB；core 单份资料最多索引 20 万字（超出部分不参与检索，不再静默截断到 6000 字） |
| 作业日期解析 | 离线词表覆盖 今天/明天/后天/大后天、周X/星期X/礼拜X、下周X、M月D日、M/D、D号、「还有 X 天」；更绕的说法（「隔周周二」「下下周五」）需配上 Key 由模型抽取，解析不出会走澄清追问而不是静默丢弃 |
| 作业数量估算 | 没说数量时按整件事估 30 分钟；1题≈3分钟、1页≈10分钟、1单词≈0.5分钟；估时只影响每天摊多少，不改变截止日 |
| 作业提醒 | 逾期只在清单里标红并支持一键重排，没有推送订阅消息（模板申请不在本轮范围） |
| 作业包 | 短码是明文，只做「首行签名 + 逐行格式」校验，不加密也不防篡改：定位是「省去全班重录一遍」，不要往里放敏感内容。单包最多 60 条，标题超过 60 字会被截断；坏行只丢那一行，不会整包作废。小程序端不出二维码图（不引 canvas 绘码库），生成短码后复制转发，扫码一侧用 `scanCode` |
| 整体用时预算 | 作业排期复用短期计划的 `fit_tasks_to_minutes` 与课表避让；某天预算极小时会按比例压缩时长 |
| 课表节次 | 「第 N-M 节」按内置 12 节作息表换算（含常见大课间）；各校作息不同，可传 `periodSchedule` 覆盖，界面暂未开放编辑入口 |
| 课表单双周 | core 已有 `is_entry_active_in_week` 并在传入教学周时生效；界面暂未提供「学期开始日期」，因此当前默认按「每周固定」计算占用 |
| 检索方式 | 端侧 BM25 词法检索，不做 embedding；问题与资料没有字面重叠时不会命中 |
| “资料未覆盖”提示 | 有命中片段时提示词要求模型不得补写；完全未命中时为保护冻结基线，仍沿用旧教学提示词 |
| 模型服务 | 正式主链路只接 DeepSeek 直连；Key 保存在本机 KV 中，没有服务端代管 |
| 云开发 AI | 只有能力自检页，尚未成为正式 `LlmProvider`，不会替代 DeepSeek 主链路 |
| 流式输出 | core 和 DeepSeek provider 已有流式接口与 SSE 测试；聊天 UI 当前仍等待整条响应 |
| 数据容量 | 微信本地存储通常约 10MB；尚无自动归档、跨设备同步或云端备份 |
| 平台范围 | 目前交付的是 Taro 微信小程序；支付宝/抖音依赖已存在，但未做完整平台验收 |

---

## 尚未实现

以下内容不要从接口名或实验页面误判为已经交付：

| 能力 | 状态 | 缺口 |
| --- | --- | --- |
| PDF 导入（小程序） | 🧩 | core 的 `FileExtractor` 端口与 `.pdf` 分发已就绪（Web 端已接入 pdf.js，见上）；小程序端未接 pdf.js，没有 PDF 选择入口 |
| 聊天附件 | ⏳ | 聊天请求仍固定 `files: []`；资料只能先在资料库导入 |
| 图片/OCR/Word/Markdown | ⏳ | 没有解析器与 UI 入口（`.md` 作为纯文本已支持） |
| 聊天流式打字机 | 🧩 | core 有 `runStream`，壳未消费流事件 |
| 推送提醒 | 🧩 | `NotifierProvider` 当前是 mock，没有订阅消息或系统通知实现；作业逾期只做清单标红 |
| 真实日历同步 | 🧩 | `CalendarProvider` 当前只做截止日期提示，没有系统日历读写 |
| 云开发 AI 正式接入 | 🧪 | 自检页只验证能力；尚未实现 Provider、配置切换与回归测试 |
| 用户账号与登录 | ⏳ | 当前固定本地用户 `default`，没有微信登录、账号体系或多用户切换 |
| 跨设备同步/云备份 | ⏳ | 全部业务数据仅在当前设备 KV 中；已有导出，但没有导入恢复入口 |
| 数据导入/恢复 | ⏳ | 已支持 JSON 导出；没有把导出文件读回来的「恢复」入口 |
| Web 应用 | ✅ | `apps/web`：Vite + React 单页壳，复用 `@synapse/core`，localStorage 适配器、离线规则模式、资料/课程表/作业/计划/复习/仪表盘均可用 |
| 桌面应用 | ⏳ | Tauri 壳、文件系统 KV 适配器和旧 SQLite 迁移器尚未实现 |
| Android 应用 | ⏳ | Tauri Mobile / Kotlin 薄壳均未实现 |
| HTTP/SSE 服务端 | ⏳ | 协议可映射为 HTTP，但当前只有进程内调用，不提供服务器 |
| 向量检索 | ⏳ | 没有 embedding 模型、向量库或语义召回 |
| Web UI 自动化测试 | 🧪 | Playwright e2e 共 19 条，覆盖引导/对话/计划/资料导入（含 .md、批量上传、PDF 抽取）/资料构图/图谱/演示数据/移动端导航/课程表（含节次）/作业（对话排期、打卡、倒计时）/我的；微信原生交互仍需真机验收 |

---

## 可扩展与可替换

core 通过接口而不是平台全局 API 获取外部能力。替换实现时，优先实现端口并在壳的组装处注入，不要把平台代码写进 `packages/core`。

| 扩展点 | 当前实现 | 可以替换为 | 主要位置 |
| --- | --- | --- | --- |
| LLM | `DeepSeekLlmProvider` / 离线规则 provider | 其他 OpenAI 兼容模型、云开发 AI、本地模型 | `providers/contracts.ts`、`providers/build.ts` |
| 网络 | 小程序 `Taro.request` | Web `fetch`、Tauri HTTP、Node HTTP | `ports/HttpTransport` |
| 流式传输 | DeepSeek SSE 协议 | 小程序 chunked、Web SSE、WebSocket | `ports/StreamTransport` |
| 存储 | 小程序 `Taro.storage` KV | IndexedDB、Tauri fs、SQLite、云 KV | `storage/kv.ts`、壳 `adapters/` |
| 资料提取 | core 内置 TXT 解码 | 注入 pdf.js、OCR、Office 转文本 | `ports/FileExtractor`、`application/fileExtract.ts` |
| 检索 | 本地知识图谱 + BM25 | embedding、远程搜索、混合排序 | `RetrievalProvider`、`domain/bm25.ts` |
| 日历 | mock 截止日期提示 | 系统日历、课程平台 API | `CalendarProvider` |
| 通知 | mock 文案 | 微信订阅消息、系统通知 | `NotifierProvider` |
| 时间与 ID | 小程序真实时间 + UUID v4 风格随机 ID | 服务端时间、确定性 ID、平台安全随机源 | `ports/Clock`、`ports/IdGen` |
| UI 壳 | Taro 微信小程序 | React Web、Tauri、Tauri Mobile/Kotlin WebView | 新建 `apps/*`，复用 `@synapse/core` |

### 扩展新模型

实现 `LlmProvider` 的五个方法：

```ts
interface LlmProvider {
  generateText(prompt: string): Promise<string>
  generateWithTools(prompt: string, tools: unknown[], forceTool?: string): Promise<GenerateWithToolsResult>
  generateJson(prompt: string): Promise<Record<string, unknown>>
  streamText(prompt: string): AsyncIterable<string>
  describe(): Record<string, unknown>
}
```

然后在 `buildProviderBundle` 或平台组装处选择新实现。只要保持工具调用、JSON 输出和错误语义一致，工作流与 UI 不需要重写。

### 扩展新平台

最小工作量是：

1. 实现 `KvStore`、`HttpTransport`、`StreamTransport`、`Clock`、`IdGen`。
2. 如需 PDF，再实现 `FileExtractor`。
3. 调用 `createSynapseCore(...)` 完成依赖注入。
4. 新壳只负责页面、路由、文件选择、生命周期和平台权限。
5. 使用同一份协议类型与 core 测试，不复制业务算法。

### 替换检索策略

当前资料检索固定输出：

```text
资料命中[文件名]: 片段
```

上下文分类、来源摘要和资料证据都依赖这个格式。可以替换 BM25 的内部打分，也可以实现新的 `RetrievalProvider`，但在迁移协议前应保持该文本格式与 `retrieved_context: string[]` 不变。

---

## 快速开始

```bash
git clone https://github.com/bot-23/SynapseV2.git
cd SynapseV2
npm install
npm run sync:core
npm test
npm run typecheck
```

关键约定：

- `packages/core/src/` 是核心唯一事实来源。
- `apps/miniprogram/src/vendor/core/` 是同步生成物，**不要手改**。
- 修改 core 后运行 `npm run sync:core`，再跑测试和类型检查。
- `node_modules/`、构建产物、本地凭据、`.pai/`、`trae-tasks.md` 与本地测试资料不会进入 Git。

---

## 1. 技术栈总览

| 位置 | 技术 | 版本 | 说明 |
| --- | --- | --- | --- |
| 语言 | TypeScript | ^5.6（strict） | 全仓库唯一语言 |
| 包管理 | npm workspaces | — | monorepo，`packages/*` + `apps/*` |
| 测试 | Vitest | ^3.0 | 100 个测试，含黄金样本回放与压力测试 |
| 核心 | 纯 TypeScript | — | `@synapse/core`，**零运行时依赖** |
| 小程序壳 | Taro | 4.1.9 | React 18 + SCSS Modules，微信小程序为主 |
| Web 壳 | Vite + React | ^5.4 / ^18 | `apps/web`，浏览器单页，直接复用 core |
| PDF 解析 | pdfjs-dist | ^6.3 | **仅 Web 壳**注入 `ports/FileExtractor`；动态 import 分包（主包 +2KB），CMap 走本地目录，不依赖外网 CDN |
| UI | React | ^18 | 函数组件 + Hooks |
| 状态 | Zustand | ^4.5 | 页面级状态 |
| 工具库（壳） | dayjs / classnames | ^1.11 / ^2.5 | 仅壳内使用，不进 core |
| 构建 | Webpack | 5.91.0 | 由 Taro 驱动 |
| 模型接入 | DeepSeek（OpenAI 兼容） | — | `POST {base_url}/chat/completions`，Bearer 认证 |
| 本地存储 | KV 抽象 | — | 小程序走 `Taro.storage`，Web 走 `localStorage` |
| 平台配置 | `miniprogram-ci` | ^2.1.26 | 小程序上传/预览 |

核心包的依赖表是**空的** —— 这不是巧合，而是硬性约束（见 §3）。

---

## 2. 仓库结构

```
SynapseNext/
├── packages/
│   └── core/                     # @synapse/core：平台无关核心（零依赖）
│       ├── src/
│       │   ├── protocol/         # 契约层：请求/响应类型、SSE 事件
│       │   ├── domain/           # 纯计算：计划生成、调整、算法
│       │   ├── application/      # 用例编排：workflow / core / prompts
│       │   ├── ports/            # 端口定义：core 访问平台的唯一出口
│       │   ├── providers/        # LLM / 检索 / 日历 / 通知 适配器
│       │   └── storage/          # KV 之上的运行时存储（含键空间）
│       └── test/                 # 6 个测试文件，100 个用例
├── apps/
│   ├── miniprogram/              # Taro 微信小程序壳
│       └── src/
│           ├── adapters/         # 端口实现：HttpTransport / KvStore
│           ├── vendor/core/      # core 的同步副本（脚本生成，勿手改）
│           ├── pages/            # 9 个页面（3 个 Tab + 6 个启动/二级/实验页）
│           ├── components/       # 计划、积木计划、澄清卡片
│           └── services/         # 壳侧封装，对接 vendor/core
│   └── web/                      # Vite + React Web 壳
├── baseline/                     # 旧 Python 行为的冻结基线（黄金样本）
└── scripts/                      # sync-core-to-miniprogram / check-vendor-imports
```

---

## 3. 架构：一个核心，多平台

分三层，依赖方向单向：

```
protocol（契约）  ←  domain（纯逻辑）  ←  application（编排）
                                              ↓
                                          ports（端口）
                                              ↓
                                   壳的 adapters（平台实现）
```

### 边界硬规则

`packages/core/src` 下**任何文件**都不得出现：

- Node 内置模块（`node:*`、`fs`、`path`、`crypto` …）与 `require(`
- DOM / 浏览器 API（`window`、`document`、`fetch(`）
- 平台 API（`wx.`、`@tauri-apps`）
- 进程环境（`process.env` / `cwd` / `exit`）

这条规则由 [boundary.spec.ts](packages/core/test/boundary.spec.ts) 逐文件扫描强制，任何一次提交破坏它都会让测试变红。

### 端口与适配器（依赖注入）

core 只声明接口，由壳注入实现（[ports/index.ts](packages/core/src/ports/index.ts)）：

| 端口 | 职责 | 小程序壳的实现 |
| --- | --- | --- |
| `HttpTransport` | 普通 HTTP 请求 | `Taro.request`（包 `wx.request`） |
| `StreamTransport` | SSE 流式逐块产出 | 同上（流式） |
| `FileExtractor` | PDF 等二进制取文本 | 预留；TXT 在 core 解码，PDF 尚未注入 |
| `Clock` | 时间源 | 真实时间，测试注入固定值 |
| `IdGen` | ID 生成 | 小程序注入 UUID v4 风格随机 ID，测试注入序列 |
| `KvStore` | 键值持久化 | `Taro.getStorageSync` 等 |

小程序的核心组装只依赖少量 `adapters/`。换平台时重写这些适配器与 UI 即可，计划、检索、复习、存储编排等 core 逻辑无需复制。

---

## 4. 模型接入：DeepSeek 直连

用户设备直连模型商，**没有中间服务器**（[deepseek.ts](packages/core/src/providers/deepseek.ts)）。走 OpenAI 兼容协议，支持三种调用方式：`generateText` / `generateWithTools`（function calling）/ `generateJson`（JSON mode）。

默认配置在 [build.ts](packages/core/src/providers/build.ts)：

```ts
{
  llmProvider: "mock",              // 未存 Key 时用本地规则模式
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-flash",
  deepseekTemperature: 0.3,
  deepseekMaxTokens: 4096,
  offlinePlanFallback: false,       // 壳会开启：没配 Key 时直接走规则引擎排计划
}
```

**没有 Key 时自动降级**：切到本地规则计划引擎，App 依然可用，并在聊天里明说降级原因，不静默失败。小程序壳通过 `offlinePlanFallback: true` 开启（默认关闭是为了不破坏冻结基线，详见 §7）。

### 三个已验证的接入约束

真机联调时实测出来的，记在这里避免再踩：

1. **思考模式默认是开的，且它不支持强制 tool_choice。** 官方文档写明 thinking 开关默认 `enabled`，此时传 `tool_choice: {type:"function"}` 或 `"required"` 会直接返回 `400 Thinking mode does not support this tool_choice`（`"auto"` 与省略该字段则正常）。工作流在识别到「给我计划 / 太难 / 没时间 / 重来」这类意图时会强制指定工具，所以请求里显式传了 `thinking: {type: "disabled"}`。
2. **思考模式会静默忽略 `temperature`。** 官方原话是「设置这些参数不会报错，但也不生效」。我们靠 `temperature: 0.3` 求稳定的结构化输出，这也是必须关掉思考模式的原因之一。
3. **JSON mode 要求提示词里出现 `json` 字样。** 否则返回 `400 Prompt must contain the word 'json'`。core 的提示词已统一带上「请只输出 JSON」，`generateJson` 也会额外补一句兜底。

---

## 5. 存储：KV 键空间

core 不碰数据库，所有持久化都落在 `KvStore` 的键上（[runtimeStore.ts](packages/core/src/storage/runtimeStore.ts)）。小程序端上限约 10MB。

| 键 | 内容 |
| --- | --- |
| `profile` | 用户资料，含 `api_key` |
| `conversations` | 会话列表 |
| `messages:{conversationId}` | 消息明细 |
| `clarifications` | 待澄清会话 |
| `assessments:default` | 评估记录 |
| `plans:{userId}` | 当前短期计划 |
| `plan_versions:{userId}` | 计划历史版本（保留最近 30 版） |
| `subjects:{userId}` | 科目注册表（跨对话保留） |
| `long_plan:{userId}` | 长期计划与里程碑 |
| `today:{userId}` | 今日待办（含未完成顺延） |
| `review:{userId}` | 间隔重复复习队列 |
| `progress:{userId}` | 任务打卡进度 |
| `documents:{userId}` | 导入的资料（含科目/标签/来源/字数等元数据与图谱、复习卡回填 ID） |
| `assignments:{userId}` | 作业清单（含截止日、数量、估时、状态、复习卡回填 ID） |
| `timetable:{userId}` | 课程表 |
| `kg:nodes` / `kg:edges` | 知识图谱（9 个内置节点 + 资料构建的增量节点） |

---

## 6. 范式定位：轻量检索增强，而非向量 RAG 平台

这是一个 **LLM 编排 + 规则引擎主导的确定性工作流**。它已经具备本地资料检索增强，但不是依赖 embedding 与向量数据库的通用 RAG 平台：

- **规则引擎是骨架。** 计划的天数、每天时长、任务切片、顺延、里程碑划分都由确定性算法产出，可被黄金样本逐字复现。
- **LLM 负责理解与措辞。** 识别意图、抽取学习目标、生成 `focus` 短语、把结构化结果说成人话。
- **检索是“增强”而非“主体”。** 知识图谱与用户上传资料走本地检索；命中资料时，计划和教学提示词会带上片段与文件名。
- **上下文有来源配额。** 资料最多保底 3 条、课程表 2 条、执行记录/画像/图谱各 1 条，避免图谱结果按位置把用户资料挤出窗口。
- **来源可见。** `retrieved_context` 随计划消息持久化，计划卡片展示来源计数和资料依据。

因此不需要向量库、不需要 embedding 服务、不需要服务器，整个应用可以是纯离线可用的本地程序（模型调用除外）。

### 三个离线算法

| 算法 | 位置 | 说明 |
| --- | --- | --- |
| **SM-2 间隔重复** | [review.ts](packages/core/src/domain/review.ts) | 初始 2.5 难度系数、下限 1.3；间隔 1 天 → 6 天 → ×ease，上限 180 天；打卡完成自动入复习队列 |
| **BM25 检索** | [bm25.ts](packages/core/src/domain/bm25.ts) | `k1=1.5`、`b=0.75`，中文按相邻双字（bigram）切分，零依赖倒排索引 |
| **资料图谱构建** | [kgBuilder.ts](packages/core/src/application/kgBuilder.ts) | 模型抽取结构化节点和关系；不可用时取高频 bigram top 5，按资料 ID 幂等写入 |
| **作业解析与摊量** | [assignment.ts](packages/core/src/domain/assignment.ts) | 日期词表 + 数量正则把「习题1-20明天交」解析成条目；按截止日倒排把每条作业摊到截止前的每一天，再用每日预算收口 |

---

## 6.1 两种计划范式：目标式 vs 作业式

同样一个「学习计划」，用户其实带着两种完全不同的诉求进来，core 用两条独立链路承接，互不覆盖：

| | 目标式计划（`learning_request`） | 作业式计划（`assignment`） |
| --- | --- | --- |
| 用户原话 | 「我想系统学高数」 | 「数学第三章习题1-20明天交」 |
| 语义 | 我想学 | **我必须交** |
| 时间锚点 | 每周可学天数 + 每天分钟数 | 老师给的截止日 |
| 产出 | 按天任务 + 重点 + 理由 | 按截止日分组的作业清单 + 未来排期 |
| 打卡 | 任务勾选 → 进度 + 复习入队 | 作业勾选 → 状态翻转 + 复习入队 |
| 逾期处理 | 未完成项跨天顺延 | 标红 + 一键把剩余量重排到后续几天 |
| 失败兜底 | 规则引擎出计划 | 规则解析出条目；解析不出 → 澄清追问 |

两条链路的意图判定顺序是：模型工具调用（`submit_assignment`）优先，模型没给出工具调用或没配 Key 时，用「截止词 + 作业词/数量」的强信号规则兜底 —— 普通学习请求不会被误判成作业。

### 资料 → 图谱 → 计划的闭环

导入的资料不只用于检索，还能显式长成知识图谱，并被后续计划引用：

1. **构图**：在资料库对某份资料点「构建图谱」→ 抽取知识点与关系，按 `doc_{资料ID前8位}_{序号}` 生成节点，并补一条 `document → topic` 的 `contains` 边。
2. **降级**：没配 Key 或模型调用失败时，改用本地 bigram 高频词 top 5 作为 topic 节点，`description` 标注「离线规则抽取」，不阻断流程。
3. **幂等**：节点按 `id`、边按 `(source_id, target_id, relation)` 去重，同一资料重复构建不会产生重复内容。
4. **入队与回填**：构图产生的新 topic 会去重写入次日 SM-2 复习队列；图谱节点 ID 与复习卡 ID 会回写到该资料的记录上，形成「资料 → 图谱 → 复习」全链路的可查证据。
5. **元数据**：导入时按文件名（权重 3）与正文（权重 1）的关键词表推断科目，允许在资料库里手改标题/科目/标签；旧资料缺字段时在读取侧补默认值，不写迁移脚本。
6. **复用**：`KgRetrievalProvider.search()` 无需改动即可命中新节点，生成计划时提示词会同时带上「图谱学习路径」与「资料原文片段」双证据。
7. **可视化**：小程序用 Canvas、Web 用 SVG 渲染环形图谱，节点按分类着色，可点击查看说明。

另有一组 **Python 语义兼容函数**（[pyCompat.ts](packages/core/src/domain/pyCompat.ts)）：`pyRound`（银行家舍入）、`floorDiv`、`pyTruncInt` —— 用于让 TS 结果与旧 Python 逐位对齐。

---

## 7. 质量保障：黄金样本回放

`baseline/golden/` 里冻结了 13 份旧 Python 后端的真实响应（外加 `openapi.json` 接口契约）。TS 实现必须**逐字对齐**这些输出，也就是把「旧行为」当成不可协商的事实。

这带来两个好处：平移过程不会悄悄漂移；重构时有安全网。

**质量门禁（全绿）**

| 门禁 | 命令 | 现状 |
| --- | --- | --- |
| 单元 + 回放 + 压力测试 | `npm test` | 100/100 通过 |
| 类型检查 | `npm run typecheck` | 通过（core + 小程序壳 + Web） |
| core 边界规则 | 含在 `npm test` | 通过 |
| vendor 边界校验 | `npm run check:vendor` | 通过（对外名 161 个） |

### 新增行为怎么不破坏基线

基线冻结的是「旧行为」，v2 的新行为不能悄悄改掉它。约定是**默认值保持旧行为，新行为由壳显式开启**：例如离线规划模式做成 `offlinePlanFallback` 开关（默认 `false` = 基线里的 Mock 行为），只有小程序壳传 `true`。这样 `httpBaseline.spec.ts` 不需要改，新功能也能落地。

### 小程序壳的编译选项为什么要跟 core 对齐

壳会通过 `src/vendor/core` 对 core 的代码做类型检查（`tsc` 会把被 import 的文件拉进程序里）。两边的编译选项不一致时，会出现「同一份代码在 core 里没事、在壳里报错」——而 vendor 是生成物不能改，只能改壳的配置。

所以 `apps/miniprogram/tsconfig.json` 里有两项是专门为此设的：`lib` 至少到 ES2022（core 用了 `replaceAll`）、`noUncheckedIndexedAccess`（core 开了它，索引访问才被当作可能为 undefined）。

另外 `skipLibCheck: true` 是必需的：Taro 4.1.9 自带的类型包有若干缺陷（缺 `react-native` 类型、缺 `CommonEventFunction`、重复标识符等），不跳过会报几十个与业务无关的错误。

### 关于 vendor 边界校验

`check:vendor` 会静态比对壳里的具名导入是否真实存在于 core 导出中。它现在与 `tsc` 有一部分重叠（tsc 也能发现不存在的导入名），但它作为 `sync:core` 的一环**在同步当下就失败**、且不需要拉起整个类型检查，报错也更直接，所以保留。

---

## 8. 常用脚本

```bash
npm install                           # 拉依赖（node_modules 不入库，clone 后必跑）
npm test                              # 全仓测试（当前 100 个）
npm run test:stress --workspace @synapse/core # 单独运行 core 压力测试
npm run typecheck                     # 全仓类型检查（core + 小程序壳 + Web）
npm run sync:core                     # core → 小程序 vendor（增量覆盖 + 校验）
npm run check:vendor                  # 只做 vendor 边界校验
npm run dev    --workspace @synapse/web   # 起 Web 开发服务器（默认 http://localhost:5180）
npm run build  --workspace @synapse/web   # Web 生产构建（输出 apps/web/dist）
npm run preview --workspace @synapse/web  # 本地预览构建产物
npm run e2e --workspace @synapse/web      # Web 端到端冒烟测试（Playwright/Chromium，先起 dev server）
```

`sync:core` 是按需覆盖：内容没变不重写文件，避免预览构建产物清单错乱导致 `ChunkLoadError`。

**`apps/miniprogram/src/vendor/core/` 是生成物，不要手改** —— 改 `packages/core` 后跑 `npm run sync:core`。

Web 端（`apps/web`）直接进程内复用 `@synapse/core`，浏览器用 `localStorage` 适配 KV、`fetch` 适配 HTTP、`crypto.randomUUID` 适配 ID。没配 DeepSeek Key 时同样走 `offlinePlanFallback` 本地规则模式。

PDF 抽取用 `pdfjs-dist`，由 `apps/web/scripts/copy-pdfjs-cmaps.mjs` 在 `predev` / `prebuild` 阶段把 CMap 表从 `node_modules` 复制到 `apps/web/public/pdfjs/cmaps`（该目录已 gitignore，属「npm install 可再生」产物）。**CMap 不放 CDN** 是刻意的：本项目的演示卖点之一就是断网可用。

---

## 9. 平台现状与后续

| 平台 | 状态 |
| --- | --- |
| 微信小程序（Taro） | 已交付主链路及资料结构化 / 批量导入 / 一键学习化 / Canvas 图谱 / 作业清单 / 仪表盘 / 数据导出 / 演示数据；微信原生交互仍需真机验收，云开发 AI 仅自检 |
| Web（Vite + React） | 已交付主链路及资料结构化 / 批量导入 / PDF 抽取 / 一键学习化 / SVG 图谱 / 作业清单 / 仪表盘 / JSON 导出 / 演示数据，复用同一份 `@synapse/core`，19 条 e2e 通过 |
| 桌面（Tauri） | 待做 |
| Android | 待做 |

新增平台只需要：实现 `adapters/` 里的几个端口 + 写 UI。core 直接复用。

---

## 10. 仓库瘦身：把 node_modules 从历史里抹掉

`.gitignore` 只拦得住**以后**的文件。v2 首次上传时 `node_modules/`（约 600 MB）被一并提交，`.git` 因此长期停在 53 MB 量级，每次 clone 都要把这段历史拉下来。

下面这条流程把 `node_modules/`、`dist/`、`.pai/`、`.swc/`、`.auth/` 从**全部历史**中删除。它会重写提交 SHA，属破坏性操作，务必按序执行。

> **当前状态：已完成。** 首次瘦身时远端 `main` 的 clone 体积从 53.54 MiB 降到 0.64 MB。下面的流程保留作为复用与追溯 —— 将来若又误提交了大文件，按同样步骤再走一遍即可。

### 10.1 装工具

`git filter-branch` 已被官方劝退，用 `git-filter-repo`（单文件 Python 脚本）：

```bash
pip install git-filter-repo
git filter-repo --version
```

### 10.2 在干净 clone 上操作

filter-repo 会拒绝在「不像刚 clone 的仓库」上运行（防止误毁正在开发的历史），所以**不要在开发目录里做**：

```bash
git clone https://github.com/bot-23/SynapseV2.git SynapseV2-clean
cd SynapseV2-clean
```

从 GitHub 克隆会直接通过它的 fresh-clone 检查（实测无需 `--force`）；若从本地路径克隆则会报 `not a fresh clone`，此时补 `--force` 即可 —— 这个 clone 里没有任何未提交内容，强行推进是安全的。

### 10.3 备份（建议）

备份只能放本地。**别在远端新建指向旧提交的 tag/分支**，那样旧对象仍然可达，等于白瘦。

```bash
git bundle create ../SynapseV2-before-shrink.bundle --all
```

### 10.4 重写历史

```bash
git filter-repo --invert-paths \
  --path node_modules \
  --path apps/miniprogram/node_modules \
  --path apps/miniprogram/dist \
  --path apps/miniprogram/.pai \
  --path apps/miniprogram/.swc \
  --path apps/miniprogram/.auth
```

`--invert-paths` 是「删掉这些路径」（默认语义相反：只保留这些路径）。提交信息与作者/提交时间都不变，只换 SHA。

### 10.5 重新挂 origin 并强推

filter-repo 出于安全会**自动删掉 `origin`**（输出里会写 `NOTICE: Removing 'origin' remote`），要自己加回来：

```bash
git remote add origin https://github.com/bot-23/SynapseV2.git

# 注意：先把所有还没推上去的提交也带进这份 clone，
# 否则强推会让它们从远端消失
git push --force origin main
git push --force origin --tags
```

`main` 若开了分支保护，先在 Settings → Branches 临时放行，推完再打开。

### 10.6 验证

```bash
git count-objects -vH      # 关注 size-pack
git ls-files | wc -l       # PowerShell: (git ls-files | Measure-Object).Count
git log --all --oneline -- node_modules apps/miniprogram/.auth apps/miniprogram/dist
```

实测结果（从 GitHub 克隆的 53.54 MiB 仓库）：

| 指标 | 瘦身前 | 瘦身后 |
| --- | --- | --- |
| `size-pack` | 53.54 MiB | **209.81 KiB** |
| `.git` 目录 | 57 MB | **0.25 MB** |
| `git log --all -- node_modules` | 命中 2 次 | 空 |
| 耗时 | — | 重写 2.0 s + 清理 11.1 s |

### 10.7 两个实测踩过的坑

1. **linked worktree 的陈旧 index 会让瘦身彻底失效。** 带 `git worktree` 副工作区的仓库里，即使 filter-repo 跑完、`git repack -a -d` 也执行了，`size-pack` 可能纹丝不动，而 `git fsck --unreachable` 还报「0 个不可达对象」—— 因为副工作区的 index 里仍留着旧提交的 13,215 条 `node_modules` 记录，git 据此认定那些 blob 可达，打包时全部保留。处理：`git worktree list` 找到副工作区，在它里面跑一次 `git reset`（只重建索引，不动工作区文件），确认无用则 `git worktree remove`，再回主仓库重跑 `git repack -a -d`。
2. **原目录不要 `git reset --hard`。** 新历史里没有 `dist/`、`.auth/`，硬重置会把本地这些文件删掉（包括小程序上传私钥）。要同步就重新 clone 一份。

### 10.8 强推之后

- 旧对象在 GitHub 侧只是变成**不可达**，并未立刻删除：知道 SHA 仍可能被直接取到，仓库容量统计也要等 GitHub 自己 GC。要立刻彻底清除需联系 GitHub Support（私有仓库同理）。
- 任何旧 clone 都不能再 `git pull`（历史已分叉），需要重新 clone。
- 瘦身前那份备份 bundle 请放在仓库之外，别提交进来。
