# SynapseNext

AI 学习陪伴助手。目标形态是 **「一个核心，多平台可用」**：领域逻辑只写一份 TypeScript，Web / 小程序 / 桌面 / 安卓共用同一份核心，各平台只提供薄壳。

本仓库是从旧 Python 后端（`Synapse/`）按 [docs/architecture.md](docs/architecture.md) 平移而来的 v2 实现。

---

## 1. 技术栈总览

| 位置 | 技术 | 版本 | 说明 |
| --- | --- | --- | --- |
| 语言 | TypeScript | ^5.6（strict） | 全仓库唯一语言 |
| 包管理 | npm workspaces | — | monorepo，`packages/*` + `apps/*` |
| 测试 | Vitest | ^3.0 | 65 个测试，含黄金样本回放 |
| 核心 | 纯 TypeScript | — | `@synapse/core`，**零运行时依赖** |
| 小程序壳 | Taro | 4.1.9 | React 18 + SCSS Modules，微信小程序为主 |
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
│       └── test/                 # 5 个测试文件，65 个用例
├── apps/
│   └── miniprogram/              # Taro 壳（当前唯一已交付的壳）
│       └── src/
│           ├── adapters/         # 端口实现：HttpTransport / KvStore
│           ├── vendor/core/      # core 的同步副本（脚本生成，勿手改）
│           ├── pages/            # 7 个页面
│           ├── components/       # 卡片组件
│           └── services/         # 壳侧封装，对接 vendor/core
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
| `FileExtractor` | PDF 等二进制取文本 | 预留，未接入 |
| `Clock` | 时间源 | 真实时间，测试注入固定值 |
| `IdGen` | ID 生成 | `crypto.randomUUID`，测试注入序列 |
| `KvStore` | 键值持久化 | `Taro.getStorageSync` 等 |

小程序壳的 `adapters/` 总共不到 120 行，且**没有任何原生代码**。换平台就是重写这几个文件，core 一行不用动。

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
| `documents:{userId}` | 导入的资料 |
| `timetable:{userId}` | 课程表 |
| `kg:nodes` / `kg:edges` | 知识图谱（9 节点 / 10 边） |

---

## 6. 范式定位：不是 RAG

这是一个 **LLM 编排 + 规则引擎主导的确定性工作流**，不是向量检索问答系统：

- **规则引擎是骨架。** 计划的天数、每天时长、任务切片、顺延、里程碑划分都由确定性算法产出，可被黄金样本逐字复现。
- **LLM 负责理解与措辞。** 识别意图、抽取学习目标、生成 `focus` 短语、把结构化结果说成人话。
- **检索是"增强"而非"主体"。** 知识图谱与用户上传资料走本地检索，用于补充上下文，不承担事实来源职责。

因此不需要向量库、不需要 embedding 服务、不需要服务器，整个应用可以是纯离线可用的本地程序（模型调用除外）。

### 两个离线算法

| 算法 | 位置 | 说明 |
| --- | --- | --- |
| **SM-2 间隔重复** | [review.ts](packages/core/src/domain/review.ts) | 初始 2.5 难度系数、下限 1.3；间隔 1 天 → 6 天 → ×ease，上限 180 天；打卡完成自动入复习队列 |
| **BM25 检索** | [bm25.ts](packages/core/src/domain/bm25.ts) | `k1=1.5`、`b=0.75`，中文按相邻双字（bigram）切分，零依赖倒排索引 |

另有一组 **Python 语义兼容函数**（[pyCompat.ts](packages/core/src/domain/pyCompat.ts)）：`pyRound`（银行家舍入）、`floorDiv`、`pyTruncInt` —— 用于让 TS 结果与旧 Python 逐位对齐。

---

## 7. 质量保障：黄金样本回放

`baseline/golden/` 里冻结了 13 份旧 Python 后端的真实响应（外加 `openapi.json` 接口契约）。TS 实现必须**逐字对齐**这些输出，也就是把「旧行为」当成不可协商的事实。

这带来两个好处：平移过程不会悄悄漂移；重构时有安全网。

**质量门禁（全绿）**

| 门禁 | 命令 | 现状 |
| --- | --- | --- |
| 单元 + 回放测试 | `npm test` | 65/65 通过 |
| 类型检查 | `npm run typecheck` | 通过（core + 小程序壳） |
| core 边界规则 | 含在 `npm test` | 通过 |
| vendor 边界校验 | `npm run check:vendor` | 通过（对外名 134 个） |

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
npm test                              # 全仓测试（65 个）
npm run typecheck                     # 全仓类型检查（core + 小程序壳）
npm run sync:core                     # core → 小程序 vendor（增量覆盖 + 校验）
npm run check:vendor                  # 只做 vendor 边界校验
```

`sync:core` 是按需覆盖：内容没变不重写文件，避免预览构建产物清单错乱导致 `ChunkLoadError`。

**`apps/miniprogram/src/vendor/core/` 是生成物，不要手改** —— 改 `packages/core` 后跑 `npm run sync:core`。

---

## 9. 平台现状与后续

| 平台 | 状态 |
| --- | --- |
| 微信小程序（Taro） | 已交付：引导页 / 对话 / 计划（今日·短期·长期·复习）/ 我的 / 历史会话 / 课程表 / 资料库 |
| Web | 待做 |
| 桌面（Tauri） | 待做 |
| Android | 待做 |

新增平台只需要：实现 `adapters/` 里的几个端口 + 写 UI。core 直接复用。

---

## 10. 仓库瘦身：把 node_modules 从历史里抹掉

`.gitignore` 只拦得住**以后**的文件。v2 首次上传时 `node_modules/`（约 600 MB）被一并提交，`.git` 因此长期停在 53 MB 量级，每次 clone 都要把这段历史拉下来。

下面这条流程把 `node_modules/`、`dist/`、`.pai/`、`.swc/`、`.auth/` 从**全部历史**中删除。它会重写提交 SHA，属破坏性操作，务必按序执行。

> **当前状态：已完成。** 远端 `main` 的历史已重写，clone 体积 53.54 MiB → 0.64 MB，跟踪文件 174 个。下面的流程保留作为复用与追溯 —— 将来若又误提交了大文件，按同样步骤再走一遍即可。

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
