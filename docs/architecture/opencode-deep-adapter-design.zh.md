# SoloMap OpenCode 深度适配设计

> 交互式身份更新（2026-09-01）：用户主动发起的 OpenCode 原生交互终端如何创建并绑定 Session，以[交互式 Agent 会话身份稳定绑定设计](./interactive-agent-session-identity-design.zh.md)为准；本文继续负责 OpenCode 的供应商、模型、凭据和无人值守结构化运行边界。

## 这份文档解决什么判断

这份文档固定 SoloMap 如何在不破坏任何既有 Agent CLI 能力的前提下，为 OpenCode 增加供应商切换、模型发现、结构化运行和稳定续接能力。

核心判断只有一句：**用户继续选择自己熟悉的 Agent CLI；OpenCode 只是其中拥有专用深度适配器的一项，不是替代其他 CLI 的统一运行时。**

## 最终用户结果

用户仍按现有方式选择主 Agent 和复核 Agent。选择 Codex、Claude、Cursor、Copilot、Agy / Antigravity 或自定义 CLI 时，现有设置、模型、执行、续聊、复核和安装路径保持不变。

只有用户选择 OpenCode 时，SoloMap 才补充以下动作：

- 查看 OpenCode 当前是否可用。
- 查看 OpenCode 已识别的供应商和模型。
- 在同一个 OpenCode CLI 下切换供应商和模型。
- 直接录入、替换或移除当前供应商的 API Key。
- 使用结构化事件跟踪任务、会话和失败原因。
- 继续由独立安装的 OpenCode 获取上游更新和新增供应商能力。

用户不需要理解 adapter、JSON event、模型目录来源或 OpenCode 配置文件结构。

## 不变量

以下约束优先于所有实现便利：

1. 不删除、不隐藏、不降级任何已有 Agent CLI。
2. 不改变现有 `cliPath`、`reviewerCliPath`、路线图 `agentCli` 和历史会话的含义。
3. 不把 OpenCode 的供应商心智强加给其他 CLI；非 OpenCode 路径不出现 OpenCode 专属字段或提示。
4. 不 fork、vendor、复制或修改 OpenCode 源码，不导入其内部模块。
5. API Key 只能进入 VS Code SecretStorage；不得进入项目文件、普通设置、日志、运行记录、终端命令或回传给 Webview。OAuth Token 仍由 OpenCode 自己管理。
6. 不覆盖用户的 OpenCode 全局配置、项目配置、插件、Agent、MCP、Skills 或权限规则。
7. OpenCode 适配失败时只影响 OpenCode 增强能力，不得阻断其他 CLI。
8. 上游更新不能中断已启动任务；任务运行期间不触发安装或升级。
9. 普通用户界面只表达选择、连接、执行和继续，不暴露实现协议。

## 当前实现事实

### Observed in code

- `src/agentCli.ts` 已识别 `opencode`、`open-code` 和 `open-code-cli`，并能生成 `opencode run --model ...` 与原生 session 续接命令。
- `src/sidebarDependencies.ts` 已把 OpenCode 列为受支持 CLI，并提供 `npm install -g opencode-ai` 安装入口。
- `src/agentModels.ts` 已调用 `opencode models`，但把返回值作为单层文本模型列表处理。
- `SolopreneurSettings.agentModelPreferences` 已按 Agent family 保存模型偏好；OpenCode 模型继续使用完整的 `provider/model`。
- `.solopreneur/step-sessions/<nodeId>.json` 已按 CLI family 保存 session ID，OpenCode 具有独立 session 槽位。
- OpenCode 当前没有可验证的只读复核命令；`buildReadOnlyAgentCommandForPromptFile` 对 OpenCode 返回空命令。
- 首版已新增 `src/openCodeAdapter.ts`，负责供应商规范化、SecretStorage key 名和 OpenCode 终端凭据环境；版本、事件和能力探测仍属于后续增量。

### Inference

当前代码已具备最小兼容运行能力，适合通过增量适配器升级，而不需要重写通用 Agent 执行框架。首版单独保存 `openCodeProvider`，让用户在尚未选定具体模型时也能确定 API Key 的归属；模型一旦明确，运行时始终以 `provider/model` 中的供应商为准，避免错误注入。

## 目标架构

```text
设置 / 任务卡片 / Solo / Flow / 自动化 / 复核
                    │
                    ▼
          现有 Agent CLI 调度层
             │             │
             │             └── 其他 CLI 现有路径（保持不变）
             ▼
       OpenCodeAdapter
       ├── 版本与能力探测
       ├── 供应商连接状态
       ├── provider/model 目录
       ├── 结构化任务事件
       ├── session 捕获与续接
       └── OpenCode 专属错误归一
             │
             ▼
      用户独立安装的 OpenCode
             │
             └── 用户选择的模型供应商
```

通用调度层仍以 `agentCli` 选择执行路径。只有 `getAgentCliFamily(agentCli) === 'opencode'` 时才进入 `OpenCodeAdapter`；其他 family 不经过该适配器，也不依赖其初始化成功。

## 适配器职责

建议新增独立模块 `src/agentAdapters/openCodeAdapter.ts`，对通用层暴露稳定、最小的公开契约：

```ts
interface OpenCodeCapabilities {
  available: boolean;
  command: string;
  version: string;
  supportsJsonEvents: boolean;
  supportsSessionResume: boolean;
  supportsProviderAuth: boolean;
  supportsReadOnlyReview: boolean;
  message: string;
}

interface OpenCodeModel {
  value: string;       // provider/model
  provider: string;
  model: string;
  label: string;
}

interface OpenCodeRunRequest {
  workspaceRoot: string;
  promptFilePath: string;
  model: string;       // auto 或 provider/model
  sessionId?: string;
  permissionMode: string;
  title?: string;
}

interface OpenCodeLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  envPatch: Record<string, string>;
  displayCommand: string;
}

interface OpenCodeAdapter {
  probe(): Promise<OpenCodeCapabilities>;
  listModels(forceRefresh?: boolean): Promise<OpenCodeModel[]>;
  listConnectedProviders(): Promise<string[]>;
  buildProviderLogin(provider?: string): OpenCodeLaunchPlan;
  buildRun(request: OpenCodeRunRequest): OpenCodeLaunchPlan;
  parseEvent(line: string): OpenCodeEvent | null;
}
```

适配器只负责形成执行计划和解析 OpenCode 公开输出。终端创建、进程就绪门闩、运行目录、状态文件、数据库、Git 证据、完成判断和 UI 刷新继续由 SoloMap 现有执行链负责，避免形成第二套任务系统。

## 上游所有权与更新边界

OpenCode 必须作为用户环境里的独立可执行文件存在：

- SoloMap 可以提供官方安装命令和“检查版本”动作。
- OpenCode 自己读取其全局与项目配置、凭据和模型目录。
- OpenCode 自己决定如何支持新供应商、新模型、插件和内部工具。
- SoloMap 不固定 OpenCode 源码提交，不复制 provider adapter，也不在扩展包中携带私有构建。
- SoloMap 不在启动、冷加载或任务运行期间自动执行 `opencode upgrade`。
- 用户或 OpenCode 完成升级后，下一次探测读取新版本与能力。

兼容判断采用“能力优先、版本辅助”：先运行只读探测并确认所需命令与结构化输出可用，再记录版本用于诊断。未知新版本不能仅因版本号较新而拒绝；缺少必需能力时也不能靠版本号猜测兼容。

探测和模型刷新属于后台增强，不得阻塞设置首屏、项目切换或其他 CLI 的任务启动。

## 设置与选择体验

### Agent CLI 选择保持不变

`主 Agent` 和 `复核 Agent` 继续列出所有现有 CLI。OpenCode 与其他 CLI 平级，不使用“推荐”“官方默认”或迁移提示改变用户选择。

### OpenCode 条件设置

当主 Agent 选择 OpenCode 时，设置区按动作顺序显示：

```text
主 Agent
OpenCode

模型供应商
Anthropic

默认模型
Claude Sonnet 4

API Key
已安全保存                      [替换] [移除]
```

当切换到其他 CLI 时，`模型供应商` 和 OpenCode API Key 设置从界面移除；该 CLI 原有模型选择保持原样。

首次使用且尚未添加项目时，新手引导在现有 Agent 就绪区提供“安装 OpenCode”动作，复用既有 Agent 安装终端并执行官方 npm 包安装命令。它不替代其他 Agent 的安装入口，也不把 OpenCode 自动设为默认 CLI；安装完成后，用户仍在统一设置页自主选择 OpenCode 并配置供应商。

默认模型仍写入：

```ts
agentModelPreferences.opencode = 'anthropic/claude-sonnet-4';
```

`openCodeProvider` 只保存供应商选择，不保存凭据。界面从第一个 `/` 前的内容校验模型归属；选择新供应商后，如果旧模型不属于该供应商，界面选择该供应商的首个可用模型或 `Auto`，并通过现有设置补丁只更新 `agentModelPreferences.opencode`；缺失字段不得清空其他 CLI 的模型偏好。

### 供应商目录

供应商列表由 `opencode models` 返回的完整模型 ID 分组得到，不能在 SoloMap 内维护静态供应商名单。这样 OpenCode 上游新增供应商后，SoloMap 只需刷新目录即可显示。

密钥是否存在只以 SecretStorage 的布尔状态返回界面。状态读取失败不能把供应商从模型目录删除，也不能影响其他 CLI。

### 凭据操作

用户在 OpenCode 条件设置中输入 API Key。Key 通过一次 Webview 消息交给 Extension Host 后立即写入按供应商隔离的 VS Code SecretStorage；Webview 只收到“已配置 / 未配置”，保存成功后清空输入框。

OpenCode 当前公开 CLI 没有稳定的非交互式 API Key 写入参数，因此首版不改写其 `auth.json`。启动 OpenCode 专属终端时，Extension Host 从 SecretStorage 读取当前供应商的 Key，并通过 OpenCode 支持的 `OPENCODE_AUTH_CONTENT` 只注入该终端进程。Key 不拼进 shell 命令，也不写入 `run-agent.sh`、`command.txt` 或项目目录；非 OpenCode 终端不接收该环境变量。

## 模型目录契约

OpenCode 模型值必须符合 `provider/model`；第一个 `/` 分隔供应商，剩余部分完整保留为模型 ID。解析不能假设模型 ID 只有一段。

目录归一规则：

1. 去除 ANSI 控制字符和空行。
2. 只接受包含非空 provider 与 model 的条目。
3. 保留上游原始完整 ID 作为执行值。
4. 按 provider 分组，组内保持上游顺序并去重。
5. `Auto` 是 SoloMap 运行选择，不伪装成 OpenCode 供应商。
6. 刷新失败时保留最近一次有效缓存；没有缓存时仍允许 `Auto`。
7. 迟到目录不得覆盖用户刚完成的 CLI、供应商或模型选择。

缓存 key 至少包含解析后的 OpenCode 可执行文件路径和版本。上游版本变化后，旧模型缓存失去提交权并重新发现。

## 运行协议

### 第一阶段正式协议

第一阶段使用 OpenCode 公开的非交互结构化入口：

```text
opencode run --format json --model <provider/model> --title <run-title> <prompt>
```

存在 session 时使用同一 `run` 入口附加 `--session <session-id>`，不能回退到只打开 TUI 的 `opencode --session` 来冒充自动续推。

完整任务继续由 `prompt.txt` 承载。适配器不得把多行 prompt 拼进 shell 命令，也不得依赖 `$(cat ...)`。如果 OpenCode 当前公开入口只能接收消息参数，传入的消息只是一条稳定 wrapper，要求读取绝对路径的 `prompt.txt`；必须用包含空格、引号、Unicode 和长路径的最终命令回归验证。

### 交互协议边界更新

ACP 已被明确禁止，不再是 OpenCode 的后续升级、备选、兼容或评估路径。用户主动对话继续使用 OpenCode 原生 TUI；首次 Session 的创建、绑定和恢复统一遵循[交互式 Agent 会话身份稳定绑定设计](./interactive-agent-session-identity-design.zh.md)中的官方 Server + `attach --session` 路径。无人值守任务继续使用本文既有的公开结构化 `run` 路径，两者都不得转向 ACP。

## 结构化事件与完成判断

适配器把 OpenCode JSON 行归一为 SoloMap 内部事件，但不把 OpenCode 私有字段扩散到数据库和 UI：

| 内部事件 | 必需信息 | 用户意义 |
| --- | --- | --- |
| `session_started` | session ID | 对话已建立 |
| `turn_started` | session ID、run ID | Agent 已开始 |
| `output_delta` | 可展示文本 | Agent 正在执行 |
| `tool_activity` | 工具类型、状态 | 可选运行摘要 |
| `permission_required` | 请求类型 | 需要你确认 |
| `turn_completed` | session ID、终态 | 本轮已结束 |
| `turn_failed` | 分类、可行动原因 | 本轮失败 |
| `turn_cancelled` | session ID | 已停止 |

字段未知时保留原始行到本地诊断输出，但不得把未知事件当作完成。正式完成仍要求：

1. 收到可识别的 OpenCode 终态事件；
2. 进程以成功状态退出；
3. SoloMap 既有完成决策文件有效；
4. 状态写入后重新读取对应用户可见作用域，旧 in-flight 快照失去提交权。

进程成功退出但没有终态事件时标记“OpenCode 在交付任务前退出”，不能从最后几行自然语言推断成功。

## Session 与续接

- session ID 从结构化事件取得，不再依赖终端中的 `Continue opencode -s ...` 文本。
- 现有 `.solopreneur/step-sessions/<nodeId>.json` 继续按 `opencode` key 保存 session，不改变文件版本和其他 CLI 槽位。
- 续聊默认继承原 conversation 的 Agent CLI 和模型；用户明确切换 OpenCode 模型时才传入新的 `provider/model`。
- 用户从 OpenCode 切换到其他 CLI 时创建或复用该 CLI 自己的 session，不覆盖 OpenCode session。
- 取消、异常退出或 VS Code 重载后不得自动重发上一条 prompt；只能用已保存 session 恢复，或要求用户再次确认发送。
- 同一业务 run 的 watcher、poller 和状态刷新必须幂等，重复观察同一终态不得重复创建续接任务或终端。

## 权限与复核边界

SoloMap 不把 OpenCode `--auto` 等同于无条件全权限，也不修改用户全局权限文件。

实施前必须针对当前稳定版本验证：

- 默认交互权限如何表现；
- `--auto` 实际自动批准哪些动作；
- 是否可通过运行级配置实现 `read-only`；
- 权限请求是否进入结构化事件；
- 用户拒绝、超时和终止的终态是什么。

在可验证的只读模式存在前，OpenCode 不得被标记为可用复核 Agent。当前其他 CLI 的只读复核能力保持不变。通过验证后，OpenCode 只读复核也必须由执行权限强制，而不是依赖提示词“请勿修改”。

## 失败与降级

| 情况 | 行为 |
| --- | --- |
| OpenCode 未安装 | 显示安装或填写路径动作；其他 CLI 正常可用 |
| 版本探测失败 | 保留普通 OpenCode 终端入口，不显示伪造的深度能力 |
| 模型刷新失败 | 使用最近有效缓存或 `Auto`，保留用户当前选择 |
| 登录状态未知 | 显示“尚未确认”，允许打开官方连接流程 |
| JSON 事件无法解析 | 保存诊断、标记适配不兼容，不猜测完成 |
| 上游升级后缺少必需能力 | 说明具体缺失能力和检测版本，不自动降级为文本猜测 |
| Adapter 自身异常 | 只终止目标 OpenCode run，其他 CLI 和其他会话继续运行 |
| 用户选择自定义 OpenCode 路径 | 所有探测、缓存和运行都绑定解析后的该路径，不偷换到 PATH 中另一份 OpenCode |

## 数据与兼容策略

首版不做破坏性 schema 迁移：

- `cliPath` 继续保存默认主 CLI。
- `reviewerCliPath` 继续保存复核 CLI。
- `agentModelPreferences` 继续按 family 保存模型；OpenCode 值使用完整 `provider/model`。
- `openCodeProvider` 保存当前供应商标识；API Key 本体只保存在 SecretStorage，设置快照只携带 `openCodeApiKeyConfigured` 布尔值。
- 路线图 `agentCli` 列保持不变。
- 历史 conversation、execution、step session 和 run digest 不批量重写。

新增的 OpenCode 能力、版本和模型目录属于可重新探测的派生状态，优先放在内存缓存；若为冷启动体验增加磁盘缓存，必须带可执行路径、版本、读取时间和完整快照版本，且不能成为凭据或配置真相。

## 代码落点

第一轮实现应保持小步增量：

1. 首版新增 `src/openCodeAdapter.ts`：供应商规范化、SecretStorage key 与专属终端环境；后续再增量补入探测、运行计划和事件解析。
2. `src/agentModels.ts`：OpenCode 分支委托 adapter，返回既有 `AgentModelCatalog`，不改变其他 family 策略。
3. `src/agentCli.ts`：只把 OpenCode 命令构造委托 adapter；其他 CLI 分支保持字节级输出不变。
4. `src/pluginContracts.ts` 与设置持久化：新增 `openCodeProvider` 和运行时布尔状态，不新增任何明文 key 字段。
5. `src/sidebarWebview.ts`：仅在 OpenCode 被选中时显示供应商、API Key 和模型选择；所有已有 CLI 选项、默认值和 per-conversation 选择保持不变。
6. `src/continuation.ts` 与运行结算路径：优先消费结构化 session 和终态事件，同时保留历史记录读取兼容。
7. `src/sidebarDependencies.ts`：保留现有安装动作，增加能力状态但不替 SoloMap 触发自动升级。

若在实施中发现需要修改通用运行状态机，必须先证明该修改是所有 CLI 都需要的共享修复；OpenCode 私有差异继续留在 adapter 内，不能借深度集成重写旧 CLI 路径。

## 验证矩阵

### Adapter 单元测试

- 解析多供应商、同供应商多模型、模型 ID 多段路径、重复项和 ANSI 输出。
- 解析 session 开始、运行、完成、失败、取消和未知 JSON 事件。
- 对空输出、截断 JSON、混合 stderr、非零退出和未知版本 fail closed。
- 对包含空格、单引号、Unicode 和长路径的 prompt 文件验证最终参数。
- 版本变化后旧缓存失去提交权。

### OpenCode 集成测试

- `probe → models → 选择 provider/model → run → 捕获 session → resume` 完整链路。
- 用户配置多个供应商后可切换，切换不会覆盖其他供应商的 SecretStorage 凭据或 `opencode.json`。
- 用户在模型加载期间切换 CLI，迟到 OpenCode 目录不能重置当前选择。
- 运行中 OpenCode 可执行文件发生升级时，当前进程完成；下一次运行重新探测。
- 扩展重载、终端关闭、取消和失败后不重复执行 prompt。

### 旧 CLI 零回归矩阵

Codex、Claude、Cursor、Copilot、Agy / Antigravity、自定义 CLI 至少逐项验证：

- 设置选择和持久化。
- 安装 / 登录 / 检查动作。
- 模型发现和既有默认值。
- Step、Solo、Flow、路线图调整、自动化与重试入口。
- 原生 session 续接。
- 主 Agent 与复核 Agent 分别选择。
- 最终生成命令与改动前快照一致。

任何旧 CLI 的命令、权限参数、模型值、session key、提示词投递或 UI 可见性变化，都视为本功能回归，而不是可接受迁移。

### 用户体验验收

- 选择非 OpenCode CLI 时看不到供应商设置，也没有多余说明。
- 选择 OpenCode 后可直接完成“连接供应商 → 选择模型 → 启动任务”。
- API Key 保存后不会回传到 Webview，也不会出现在普通设置、日志、运行记录、终端命令和项目文件中。
- 冷启动不等待 OpenCode 探测；模型目录和 Key 布尔状态在后台收敛且不重置用户选择。
- 从发送动作开始 5 秒内终端可见并确认正式 Agent 命令已经接收。

## 分阶段交付

### 阶段 O1：适配器骨架与零回归锁

- 冻结全部旧 CLI 命令与设置快照。
- 抽出 OpenCode 专用 adapter，但保持当前可见行为。
- 为 OpenCode 路径、版本、模型与命令增加最窄测试。

### 阶段 O2：供应商与模型体验（首版已落地）

- 把 `provider/model` 目录映射为条件式两级选择。
- 接入供应商级 SecretStorage API Key 保存、替换、移除和专属终端注入。
- 验证设置补丁不会覆盖其他 CLI 偏好。

### 阶段 O3：结构化运行与 Session

- 使用 `opencode run --format json`。
- 用结构化事件替代 OpenCode 的终端文本 session 捕获和完成猜测。
- 覆盖取消、异常退出、重载和并发。

### 阶段 O4：只读复核

- 只有在运行级只读权限验证通过后开放 OpenCode 复核。
- 不评估、不引入 ACP；交互式恢复只消费已确认的原生 Session 绑定。

每个阶段都必须单独通过旧 CLI 零回归矩阵。后续阶段不能以“最终会统一”为理由推迟修复已经出现的旧 CLI 回归。

## 完成标准

这项设计完成实施的判定不是“OpenCode 能跑一次”，而是同时满足：

- 用户仍可原样选择并使用所有旧 CLI。
- OpenCode 用户可以在 SoloMap 内完成供应商切换、API Key 配置和模型选择。
- OpenCode 任务使用公开结构化协议，session 与终态不依赖自然语言文本猜测。
- OpenCode 上游可以独立升级，SoloMap 通过能力探测适配，不维护上游源码。
- SoloMap 只在 VS Code SecretStorage 保存供应商 API Key，不把明文写入普通设置或项目，也不覆盖 OpenCode 配置。
- 设置、运行、续聊、取消、复核和异步加载均通过正向与负向验证。
- 所有最终命令、事件组合和用户界面都经过真实生成物与真实运行环境检查。
