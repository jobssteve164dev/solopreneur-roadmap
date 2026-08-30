# 交互式任务终端与任务哨兵解耦设计

> 决策更新（2026-08-30）：SoloMap 不再用非交互 CLI 进程退出判断用户对话完成。Solo、用户主动发起的路线图环节对话和续聊统一使用 Agent CLI 原生交互终端；Agent 通过插件生成的受约束检查点命令上报每轮结果，插件沿用既有结算、复核与路线图完成判断。自建 Chat UI 与 ACP 方案仍只作为历史调研保留。

## 文档状态

- 状态：原生交互终端 + Agent 检查点账本首版已落地。
- 当前覆盖：Codex、Cursor Agent、Antigravity CLI、Claude Code、GitHub Copilot CLI 和 OpenCode 的用户主动对话入口。
- 当前运行边界：用户对话使用原生交互终端；Flow、复核、定时任务、时间计划、自动重试和其他无人值守任务继续使用非交互命令。
- 当前结论：不增加自建 Chat UI 或 ACP 运行时依赖；任务轮次结算依赖显式检查点，不依赖进程退出、终端空闲或输出文案匹配。

## 用户结果

用户从 Solo 或路线图环节发起任务后，第一次就进入 Agent CLI 原生交互终端；Agent 完成当前回复后，终端继续等待用户输入，用户不需要回到侧边栏重新创建一次 CLI 运行才能补充要求。

审批、问题选项、流式输出、中断和快捷操作继续由各 Agent CLI 原生呈现。SoloMap 只负责启动、轮次账本、结果结算和恢复映射，不复制 Provider 的聊天界面。

任务哨兵仍然能够准确区分：

- Agent 正在执行当前轮次。
- Agent 已完成当前轮次，正在等待用户继续。
- 当前轮次失败或会话被关闭。

侧边栏只使用上述用户语言，不暴露 Hook、PTY、事件日志、适配器或 Provider 协议。

## 当前实现与问题

### Observed in code

- 用户主动发起的首次任务由 `buildInteractiveAgentCommandForPromptFile` 构造原生交互命令；后台任务继续调用 `buildAgentCommandForPromptFile`（`src/agentCli.ts`）。
- 插件在项目内生成 `.solopreneur/runtime/task-checkpoint.cjs`，命令校验当前会话令牌后原子写入 `start`、`complete` 或 `session-close` 事件，并在 `complete` 时计算本轮工作区变化（`src/taskCheckpoint.ts`）。
- `buildAgentShellScript` 只在用户对话中注入检查点环境变量；CLI 进程退出仅关闭 Session，未上报检查点时按协议缺失处理，不再被当作正常完成（`src/extension.ts`）。
- `processAgentStatusFile` 消费同一状态管线：`Turn Started` 建立新轮次，完成检查点复用既有完成文件、复核、学习与通知逻辑，结算后写回 `Waiting` 并保留终端映射，`Session Closed` 才注销活动会话。
- 侧边栏通过统一投影把已结算但终端仍存在的会话显示为可继续，不要求数据库记录长期保持 `Running`（`src/conversationPresentation.ts`）。

### Inference

现有任务哨兵不是必须依赖非交互终端。真正的耦合是：系统把“Agent 命令退出”当成“当前任务轮次完成”。交互式 TUI 完成一轮后仍会等待下一次输入，因此不能再用进程退出作为主要完成信号。

### 已落地的检查点协议

Agent 每轮从插件提示词获得唯一命令入口：

```text
node "$SOLOMAP_TASK_COMMAND" start --message "当前要求"
node "$SOLOMAP_TASK_COMMAND" complete --message "当前要求" --outcome <结果> --summary "本轮结果" --next "下一步"
```

其中 `complete` 的结果只允许：`partial`、`candidate_complete`、`blocked_user`、`blocked_external`、`failed`。`candidate_complete` 只提交路线图完成候选，不能绕过完成标准或副 Agent 复核。Agent 不能直接编辑状态文件、完成文件或 SQLite 账本。

入账可靠性不再只依赖 Agent 是否完整执行提示词：用户点击“继续”时，插件必须先创建活动轮次，再开放现有终端输入；`Waiting` 是可长期保持的合法状态，不设置短时过期。若 Agent 在终端内漏掉 `start` 但执行了 `complete`，状态消费者必须为该完成事件补建独立轮次，不能覆盖上一条记录。状态事件按 `checkpointEventId` 防止旧结算覆盖新事件，处理期间到达的新事件进入待处理队列；`Waiting` 必须先于对话历史刷新落盘。

## 核心决策

### 1. 轮次、会话和路线图完成相互独立

- `turn completed` 只表示 Agent 完成当前回复。
- `session closed` 只表示交互终端或原生会话结束。
- 路线图环节完成仍由既有完成决策和完成标准决定。

Agent 的 Stop Hook、终端关闭或 SessionEnd 都不得直接把路线图环节标记为完成。

### 2. 用户主动对话交互式，后台编排继续非交互式

首版改为交互式的入口：

- Solo 直接对话。
- 用户主动发起的路线图环节对话。
- 用户主动恢复已有会话。

继续保持非交互式的任务：

- Flow 内部角色。
- 自动复核与只读审查。
- 每日检查、能力安装、MCP 安装和其他后台任务。
- 没有用户现场参与的自动化编排。

判断标准是用户是否正在进行一场对话，而不是底层是否调用 Agent。

首版不接入 ACP，也不修改用户全局 Hook。插件使用各 Provider 已公开的原生交互启动参数，并用自己的检查点命令取得 Provider 无关的轮次完成信号。

### 3. 任务哨兵监控活动轮次，不监控空闲会话

- 用户提交输入时创建活动轮次并进入“正在执行”。
- 用户通过“继续”进入原生终端时，也必须在终端可输入前创建活动轮次。
- Agent 完成回复后结算该轮次并退出 `Running`。
- 终端仍然存在时，会话进入“等待你继续”；跨窗口会话登记继续保留，但任务哨兵不会把它计作正在运行的任务。
- 用户再次输入时，在同一主对话下创建下一轮并重新注册活动轮次。

终端和原生 Session 的可恢复映射独立保存，不用 `Running` 状态维持。

### 4. 每轮独立结算

下列动作从“CLI 退出后执行”迁移为“每轮结束后执行”：

- 记录本轮开始、结束和结果。
- 维护 SoloMap 根会话 ID 与当前轮次执行记录；原生 Session ID 在 Provider 能提供时保存。
- 计算本轮文件变化和验证信号。
- 保存用户输入、Agent 上报的本轮摘要与后续动作。
- 更新最近对话和侧边栏状态。
- 触发现有复核或完成决策，但不改变其原有边界。

用户提交下一轮之前必须建立新的工作区基线，避免把多个轮次的变化归到同一个执行记录。

## 标准化生命周期

当前检查点协议向 SoloMap 输出统一事件：

```text
turn_started
turn_completed
turn_failed
session_closed
```

事件至少携带：

- `provider`
- `rootConversationId`
- `executionLogId`
- `checkpointSequence`
- `eventType`
- `occurredAt`
- `cwd`

状态文件固定绑定根会话，后续 `turn_started` 由插件创建新的执行记录；`checkpointSequence + eventType` 保证同一轮事件只结算一次。Provider 的审批与提问仍由原生 CLI 处理，SoloMap 首版不伪造自己拿不到的结构化等待状态。

## 历史调研：Codex ACP 自建对话终端（未实施）

### 为什么采用 ACP，而不是直接复刻 app-server 适配器

Codex app-server 能提供完整线程、轮次、审批和工具事件，但直接接入意味着 SoloMap 自己维护一套随 Codex 版本变化的 Provider 私有协议。`@agentclientprotocol/codex-acp` 已经把 app-server 转换为稳定的 ACP 客户端协议，并采用 Apache-2.0 许可；SoloMap 只需实现通用 ACP Client 与自身生命周期映射。

首版进程边界：

```text
SoloMap 对话终端
      │ 用户输入 / 审批 / 回答 / 中断
      ▼
Extension Host 中的会话协调器
      │ 标准化生命周期 + append-only 事件
      ▼
独立 ACP bridge 进程（stdio JSON-RPC）
      │ ACP v1
      ▼
codex-acp → codex app-server → Codex
```

- bridge 进程隔离 ESM SDK、Adapter 版本与 stdout 协议，避免把当前扩展的 CommonJS/TypeScript 约束扩散到 UI 和任务哨兵。
- `session/new` 成功后先持久化 `sessionId`，再允许发送首轮 Prompt。
- 每个 Session 同时最多一个活动 Turn；首版执行中只提供“停止”，不引入 queue/steer 两套用户心智。
- `session/request_permission` 映射为“需要你确认”；`elicitation/create` 映射为“需要你回答”；处理完成后回到“正在执行”。
- `session/prompt` 返回 `end_turn` 后结算本轮并进入“等待你继续”；返回 `cancelled`、`refusal` 或限制原因时分别结算，不用文案猜测。
- 用户显式关闭对话终端只关闭视图，不自动取消活动 Turn；显式“停止”才发送 `session/cancel`。Extension Host 重载后通过 `session/load` 恢复同一 Session。
- Adapter 不可用或能力探测不通过时，不伪装成交互式成功；保留现有非交互路径作为兼容入口，并给出可执行的恢复提示。

### 对话终端的界面边界

- 使用 VS Code Webview 承载终端式对话，不用 PTY/xterm 模拟聊天协议。PTY 继续只服务真实 Shell 终端。
- 主动作始终是输入下一条要求；状态只显示“正在执行 / 需要你确认 / 需要你回答 / 等待你继续 / 已停止 / 出错”。
- Agent 文本流式追加；工具执行默认折叠为单行进度，审批、问题选项和文件变化使用可操作卡片。
- 不展示 ACP、JSON-RPC、app-server、adapter、turnId 等内部术语。
- 同一个主对话只有一个对话终端；侧边栏“打开终端”只 reveal 既有界面，不创建第二个 Session。

## Kanna 的借鉴边界

Kanna 证明了“自建 Agent 客户端 + 结构化协议事件”能够提供比原生 CLI 更完整的交互体验，但 SoloMap 不直接集成 Kanna 整体应用。

借鉴以下实现思路：

- Provider 会话由宿主创建，Session 身份先于首轮存在；每个会话只维护一个活动 Turn。
- Provider 事件先归一化，再驱动对话 UI 和运行状态，不让 UI 解析原始协议。
- 对话与 Turn 事件使用 append-only JSONL；快照负责快速启动，日志尾部负责恢复。
- 客户端重连先收完整快照，再接增量事件；重复推送通过签名与游标去重。
- 等待审批、等待回答、执行中和空闲是显式状态，不从消息文案推断。

首版不借鉴：

- 不引入 Bun、Kanna Web 服务、Cloudflare Tunnel、项目/Worktree/Git 管理和它的整套侧边栏。
- 不复用 Kanna 的嵌入式 PTY 作为 Agent 对话容器；SoloMap 已运行在 VS Code 内，且审批与表单需要结构化控件。
- 不复制 Kanna 源码。其 LICENSE 对特定主体附加排除条款，不是无差别标准 MIT 授权；SoloMap 只依据公开架构独立实现。
- 暂不实现 queue/steer、Prompt 注入和远程分享，避免首版引入与核心目标无关的用户概念。

## 原生 TUI 备选支线的信号设计

### Hook 信号

- `SessionStart`：绑定 SoloMap run 与根 Codex Session。
- `UserPromptSubmit`：建立新轮次并标记执行中。
- `Stop`：表示根 Agent 当前轮次准备结束。

Hook 只写入生命周期事件，不负责路线图状态、数据库结算、Git 操作或 UI 刷新。所有副作用继续由插件宿主在 lease 保护下执行。

上述三个 Hook 已验证能够覆盖正常多轮会话，但不能单独覆盖用户中断。`Stop` 只代表正常结束路径；用户按 Esc 中断时，不能等待一个不会到达的 `Stop`。

### 恢复信号

Codex rollout 中以下事件用于恢复和交叉校验：

- `task_started`
- `task_complete`
- `turn_aborted`
- `error`

在 Hook 已获得可信授权的前提下，Hook 是低延迟信号，rollout 是强制恢复信号；终端关闭、进程退出和心跳是异常兜底。不得解析 ANSI 输出、提示符或自然语言文案判断完成状态。

`turn_aborted` 不是可选交叉校验。当前 Codex 在用户中断时会写入它，但不会触发 `Stop`，所以任何正式适配器都必须消费 rollout，或使用另一个经过同等验证的中断事件源。

### 根会话过滤

Codex 根 Agent 与子 Agent 可能都触发生命周期 Hook。SoloMap 必须记录第一个与当前 run 绑定的根 Session ID，后续只接受该 Session 的轮次完成事件；其他 Session 只能作为子任务证据，不得结算主轮次。

## 事件存储

现有单个状态快照继续用于侧边栏快速读取，但不能承担多轮事件队列职责。

新增 append-only 生命周期事件日志，要求：

- 每条事件一行 JSON。
- 包含唯一事件键和单调序号。
- 写入使用追加或原子替换，不依赖轮询恰好观察中间状态。
- 插件处理成功后记录消费游标。
- VS Code 重载后可以从游标继续。
- 跨窗口仍通过现有 lease 保证只有一个实例执行结算副作用。

原始终端录制只作为本地诊断材料。对话展示的权威内容仍是用户输入、Agent 最终回复、文件变化摘要和明确错误，不直接展示 reasoning 或完整工具输出。

## Hook 配置所有权

- 不覆盖用户现有 Hook、配置、授权和 Provider 设置。
- 不把 SoloMap Hook 默认写入项目并提交到 Git。
- 缺失字段表示本次不修改，不能清空用户设置。
- Hook 仅在存在本轮 `SOLOMAP_RUN_ID` 等运行标识时写事件；普通手动 Agent 会话直接跳过。
- Hook 处理器只记录生命周期身份与状态，不记录提示词正文、reasoning 或无关环境变量。
- Hook 失败不得阻断 Agent 主任务。

正式实现前必须在当前支持版本上验证配置注入方式。优先顺序：Provider 支持的运行级配置层、扩展管理的 Provider 连接器、精确补丁合并；不采用覆盖用户全局文件的方案。

当前 Codex 的运行级 `-c hooks...` 注入能够工作，但 Hook 信任仍是产品门禁：

- 不使用 `--dangerously-bypass-hook-trust` 作为正式方案；它会在原生终端显示安全警告，也绕过了用户应有的信任决策。
- 不复刻 Codex 私有信任哈希，不直接写入 `hooks.state`。
- 不把管理员级 managed config 当作普通本地用户的安装前提。
- 如果只能由用户在 `/hooks` 中手动批准，必须先把“一次性明确授权”设计成可理解的产品步骤，并由用户确认接受该体验。
- 若改用 Codex `notify + rollout` 规避 Hook 信任门槛，应先单独验证并形成设计决策，不能在运行时实现阶段临时换方案。

### `notify + rollout` 不构成等价替代

`notify` 无需 Hook 信任授权，正常轮次完成时能够提供 `thread-id`、`turn-id` 和 `cwd`；相同身份也能在 rollout 中找到对应的 `task_started → task_complete`。它适合在会话已经绑定后提供低干扰的完成提示。

但它不能独立承担首次轮次的生命周期绑定：

- `notify` 只在 Agent 正常完成轮次后触发。用户在首轮按 Esc 中断时没有通知，只有新建 rollout 中的 `task_started → turn_aborted`。
- SoloMap 在首轮完成通知到达前不知道 Codex 生成的根 `thread-id`，因而也不知道应监听哪份 rollout。
- 按创建时间、工作目录或最新文件扫描 rollout，在同一工作区存在多个 Codex 会话时会误绑定，不能作为正式身份协议。
- 先通过 app-server `thread/start` 创建空线程，再交给原生 TUI `resume` 的实验失败：未开始 turn 的线程没有可恢复会话文件，原生 TUI 返回找不到该 Session。
- 尝试让运行级 stdio MCP 在启动时回传 `CODEX_THREAD_ID` 也没有得到身份；Codex CLI `0.145.0` 启动 MCP 子进程时该值为空。
- `notify` 也不覆盖审批和用户输入请求，不能单独支持“需要你确认”的准确状态。

因此 `notify + rollout` 只能作为已绑定会话的补充信号，不能替代 `SessionStart` 一类受信身份事件。原生 Codex TUI 与完整外部生命周期监控目前仍需在以下两条产品路径中选择：

1. 保留原生 TUI，并设计一次性、用户可理解的 Hook 信任授权；
2. 使用 Codex app-server 的正式线程/轮次事件协议，由 SoloMap 提供终端式对话界面，但不再宣称是原生 Codex TUI。

未经验证的 rollout 猜测绑定不作为第三条生产路径。

## 终端与侧边栏行为

- 当前轮执行中：显示“正在执行”，主动作是“打开终端”。
- 等待审批或回答：显示“需要你确认”，主动作是“打开终端”。
- 当前轮完成且终端仍在：显示“等待你继续”，主动作是“打开终端”。
- 终端关闭且 Session 可恢复：显示“继续”。
- 关闭对话终端视图：只隐藏界面，不停止活动轮次，也不关闭可恢复 Session。
- 用户点击“停止”：向当前 Session 发送取消；收到 `cancelled` 后把当前轮记为已停止。
- Adapter 进程在执行中异常退出：当前轮记为异常中断，保留 Session 身份用于恢复。

终端内后续输入自动成为同一主对话下的新轮次，不创建新的顶层 Solo 对话。

## 失败与降级

- ACP bridge 启动失败或能力探测不通过：不创建交互 Session，不显示伪造的“正在执行”；保留现有非交互兼容入口并给出恢复动作。
- Adapter 在活动轮次中退出：先将当前轮标为异常中断，再以已持久化的 `sessionId` 尝试 `session/load`；不得自动重发用户 Prompt，避免重复副作用。
- Webview 重建：从持久快照恢复完整对话，再从事件游标接续增量；UI 重建不得创建第二个 Session。
- 原生 TUI 备选支线若未来启用：Hook 漏发时使用 rollout 恢复；Hook 与 rollout 冲突时优先采用带同一 Session/Turn 身份的持久完成或中断事件。
- Provider 不具备可验证的轮次信号：继续使用现有非交互兼容模式，不以终端空闲或文本匹配伪造精确监控。
- 等待用户确认时停止普通失联计时，避免把人工等待判为 supervisor 丢失。

## 分阶段实施

### 阶段 A1：原生 TUI + Hook 可行性验证

- 验证 Codex 当前版本支持运行级 Hook 配置。
- 验证 `SessionStart`、`UserPromptSubmit`、`Stop` 的载荷字段和触发顺序。
- 验证同一交互终端中的第二轮继续触发完整生命周期。
- 验证 Hook 处理器可以静默、快速、无提示词落盘地写入隔离事件文件。
- 验证根 Agent 与子 Agent 的 Session 身份是否足以过滤。
- 验证退出、打断、限额或 Hook 漏发时的 rollout 恢复证据。

阶段 A1 通过前不得沿原生 TUI 路线修改运行时代码。

## 阶段 A1 验证记录（2026-07-29）

验证环境：Linux、Codex CLI `0.145.0`，本机 `hooks` 功能标记为 stable/enabled。验证使用仓库内的 `scripts/validate-codex-hook-event.cjs`，Hook 只向隔离 JSONL 写入事件名、Session/Turn 身份、字段名和时间，不保存提示词或 Agent 回复正文。

### 已通过

- 运行级注入有效：通过 CLI `-c` 注入 `SessionStart`、`UserPromptSubmit`、`Stop`，没有改写 `~/.codex/config.toml`；验证前后该文件修改时间保持在测试开始之前。
- 正常首轮顺序成立：`SessionStart → UserPromptSubmit → Stop`。
- 同一 TUI 多轮成立：第二轮复用同一 `session_id`，产生新的 `turn_id`，并再次触发 `UserPromptSubmit → Stop`；首轮完成后终端保持可交互。
- 载荷身份足够：`SessionStart` 提供 `session_id` 和 `transcript_path`；`UserPromptSubmit`、`Stop` 同时提供 `session_id`、`turn_id` 和 `transcript_path`。
- 内容最小化成立：Provider 载荷虽然包含 `prompt`、`last_assistant_message`，探针没有写入这些正文，只记录字段名。
- 中断恢复证据成立：Esc 中断的轮次只触发 `UserPromptSubmit`，没有触发 `Stop`；同一 transcript 中出现同一 `turn_id` 的 `task_started → turn_aborted`，`reason` 为 `interrupted`。
- 验证终端均正常退出；测试启动的等待进程已停止，隔离事件文件和两份测试 rollout 已删除。

### 未通过或尚未验证

- **Hook 信任体验未通过**：验证依赖 `--dangerously-bypass-hook-trust`，Codex 会在终端显示安全警告。OpenAI Codex 当前公开实现与 issue 记录表明，普通本地 wrapper 尚无受支持的程序化批准接口。
- 子 Agent 的 Hook 触发与根 Session 过滤尚未做真实验证。
- 限额、Provider 错误、Hook 处理器失败和进程崩溃的恢复矩阵尚未逐项验证。
- 幂等消费与 VS Code 重载恢复属于 SoloMap 适配器行为，只能在阶段 B 代码存在后通过测试验证；不能用本次 Provider 探针替代。

### `notify + rollout` 补充验证

同一环境下另行使用运行级 `notify` 配置验证，未加载 SoloMap Hook，也未使用 Hook 信任绕过参数：

- **正常多轮通过**：同一原生 TUI 连续两轮均收到 `agent-turn-complete`；`thread-id` 保持不变，`turn-id` 每轮不同，并与 rollout 的 `task_started → task_complete` 一致。
- **交互体验通过**：终端没有出现 Hook 信任警告，用户全局 Codex 配置未被改写。
- **已绑定后的中断恢复通过**：后续轮次按 Esc 中断时不触发 `notify`，rollout 记录同一 `turn-id` 的 `task_started → turn_aborted(interrupted)`。
- **首次中断绑定未通过**：新原生 TUI 在首轮开始后立即中断，rollout 在约 150ms 内记录 `task_started → turn_aborted(interrupted)`，但没有 `notify`；SoloMap 在此之前拿不到该 TUI 的根 `thread-id`。
- **空线程预创建未通过**：app-server `thread/start` 返回了线程 ID，但尚未开始 turn 时没有形成原生 TUI 可 `resume` 的持久会话。
- **MCP 身份桥未通过**：运行级 stdio MCP 启动时观测到的 `CODEX_THREAD_ID` 为空，不能在首轮前把根身份带回 SoloMap。

这组结果说明 `notify + rollout` 能降低 Hook 在正常完成路径上的依赖，但没有解决最关键的首次身份绑定，不能据此放行阶段 B。

### A1 当前判定

Hook 事件模型在技术上可行，正常多轮和中断恢复链已经得到真实证据；`notify + rollout` 的正常多轮与中断恢复也得到真实证据，但它无法在首次轮次结束前可靠绑定原生 TUI。由于“无需破坏用户信任边界且不污染首次交互体验”的接入条件仍未成立，阶段 A1 不通过，原生 TUI 不进入运行时实现。

原生 TUI 支线只可在以下任一条件经用户确认后重新开启：

1. Codex 提供并验证了受支持的 Hook 授权/安装接口；
2. 产品明确采用一次性用户授权流程，并验证授权后升级与路径变化不会反复打扰。

此前列出的第三条替代路径——由 SoloMap 承担终端式对话界面——已经收敛为下面的 ACP 支线，不再属于原生 TUI 的放行条件。

### 阶段 A2：ACP 自建对话终端可行性验证

验证环境：Linux、Node.js `22.21.1`、Codex CLI `0.145.0`、`@agentclientprotocol/codex-acp@1.1.7`、ACP v1。验证使用仓库内 `scripts/validate-codex-acp-lifecycle.mjs`，通过 stdio 直接实现最小 ACP Client，不修改 `package.json`，不接入扩展运行时，也不保存提示词与 Agent 回复正文。

真实验证结果：

- **首轮前身份绑定通过**：`session/new` 在任何 `session/prompt` 之前返回稳定 `sessionId`。
- **正常多轮通过**：同一 Session 连续两轮均收到 Agent 消息更新，并以 `end_turn` 结束。
- **审批等待通过**：Read-only 模式的 Shell 请求触发 `session/request_permission`，请求携带同一 `sessionId`；选择 `allow_once` 后本轮正常完成。
- **用户输入等待通过**：通过 ACP 会话配置切换到 Plan 协作模式后，Codex `request_user_input` 转换为 `elicitation/create`；回答后本轮继续并完成。默认协作模式不开放该工具，因此运行时必须消费正式 elicitation，不能假设每种模式都会产生输入请求。
- **取消通过**：探针等待当前轮真实工具状态进入 `in_progress` 后发送 `session/cancel`，`session/prompt` 返回 `cancelled`，没有用进程退出冒充中断。
- **跨进程恢复通过**：关闭首个 Adapter 进程，启动新进程并对原 `sessionId` 调用 `session/load`，后续 Prompt 在同一 Session 正常完成。
- **隔离与清理通过**：验证工作区位于本次会话专用临时目录；脚本关闭 Adapter 后仅在目录为空时删除该目录，没有改写项目文件、Codex 全局配置或扩展运行时。

### A2 当前判定

ACP 路线满足首轮身份绑定、连续多轮、审批、用户回答、中断和恢复六项核心门禁，阶段 A2 通过。Codex 首版可进入阶段 B，但只能按“SoloMap 自建对话终端 + ACP bridge”实施；这不是对原生 TUI + Hook 支线的放行。

### 阶段 B：Codex 用户主动对话

- 增加独立 ACP bridge、Codex 生命周期适配器和 append-only 事件日志。
- 首次任务由 SoloMap 创建 ACP Session，并立即打开同一个对话终端。
- 将结算从进程退出迁移到每轮结束。
- 实现审批卡片、用户输入卡片、停止和 `session/load` 恢复。
- 保留现有非交互后台任务路径。
- 更新侧边栏“打开终端 / 继续”动作。

### 阶段 C：其他 Provider

- Claude Code：Stop / SessionEnd。
- Gemini 系：BeforeAgent / AfterAgent / SessionEnd。
- GitHub Copilot CLI：agentStop / sessionEnd。
- OpenCode：session.status / session.idle。
- 其他 Provider 只有在生命周期信号通过同等验证后才启用交互监控。

## 阶段 A1 原生 TUI 支线通过标准

- 不修改用户现有 Hook 文件也能为一次测试运行注入 Hook。
- 首轮触发顺序可观察为 SessionStart、UserPromptSubmit、Stop。
- 同一 TUI 内第二轮再次产生 UserPromptSubmit、Stop，且 Session ID 不变、Turn ID 可区分。
- Hook 载荷可以稳定提供根 Session 与轮次关联所需字段，或者有经过验证的 rollout 补充方式。
- Hook 输出不污染正常对话，不记录测试提示词正文。
- Hook 重复事件不会导致重复结算。
- Stop 漏发或异常退出存在可验证的恢复路径。
- 验证产生的临时会话、事件文件和终端均已明确清理或保留原因。

任一关键标准不通过时，不得沿原生 TUI 支线进入运行时实现；文档必须记录阻塞、证据和替代方案。

## 阶段 A2 ACP 支线通过标准

- Session ID 必须在首轮 Prompt 前获得并可立即持久化。
- 同一 Session 至少完成两轮，且每轮有独立的 SoloMap Turn 身份与停止原因。
- 审批和用户问题必须是带 Session 身份的结构化请求。
- 中断必须在当前轮真实开始后得到 `cancelled` 确认。
- Adapter 进程重启后必须能够加载原 Session 并继续对话。
- 验证不得修改扩展运行时代码、项目业务文件或用户全局 Agent 配置。

上述标准已由 2026-07-29 的隔离探针全部满足，阶段 B 的 ACP 路线已放行。

## 运行时代码验收标准

- 首次任务直接进入交互终端。
- 不退出终端即可提交第二轮。
- 每轮完成后侧边栏及时进入“等待你继续”。
- 多轮均归属于同一个主对话并保留独立执行记录。
- 子 Agent 完成不会提前结算根 Agent。
- 关闭对话视图不停止活动轮次；只有显式“停止”才取消当前轮。
- VS Code 重载后能恢复尚未结算的活动轮次。
- 两个窗口不会重复写入执行记录、自动化动作或完成副作用。
- Adapter 重启后能通过持久 Session 身份与事件游标恢复；若未来启用 Hook 支线，Hook 漏发时持久事件能够恢复。
- 用户已有 Hook、设置和授权完整保留。
- 普通 Stop 不会修改路线图环节完成状态。

## 当前未授权范围

- 本文档不修改路线图、环节状态或完成标准。
- 本轮设计与阶段 A 验证不修改 Agent 启动、哨兵、账本、数据库和侧边栏运行时代码。
- 不引入 tmux、远程 TUI、后台驻留或关闭终端后继续执行。
- 不在首版同时改造全部 Agent Provider。

## 参考实现与上游证据

- [Kanna：自建 Claude Code / Codex 客户端](https://github.com/jakemor/kanna)
- [Kanna：Codex app-server 会话与轮次适配器](https://github.com/jakemor/kanna/blob/main/src/server/codex-app-server.ts)
- [Kanna：append-only 事件存储与快照恢复](https://github.com/jakemor/kanna/blob/main/src/server/event-store.ts)
- [Kanna：快照订阅、重连与增量推送](https://github.com/jakemor/kanna/blob/main/src/server/ws-router.ts)
- [Kanna：带特定主体排除条款的 LICENSE](https://github.com/jakemor/kanna/blob/main/LICENSE)
- [Agent Client Protocol：协议与稳定版本说明](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP TypeScript SDK：Client 与 stdio 示例](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/examples/client.ts)
- [Codex ACP Adapter：能力、安装与运行选项](https://github.com/agentclientprotocol/codex-acp)
- [Codex ACP Adapter：真实多轮、审批、取消与恢复测试](https://github.com/agentclientprotocol/codex-acp/tree/main/src/__tests__/CodexACPAgent/e2e)
- [OpenAI Codex 配置与 managed hooks 说明](https://github.com/openai/codex/blob/main/docs/config.md)
- [OpenAI Codex：本地 IDE/wrapper 缺少受支持 Hook 信任接口](https://github.com/openai/codex/issues/21615)
- [OpenAI Codex：外部 `notify` 的 turn-complete 配置实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs)
- [OpenAI Codex app-server：线程、轮次与服务器事件协议](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [OpenAI Codex：集成方获取 Session ID 的讨论](https://github.com/openai/codex/issues/8923)
- [OpenAI Codex：自定义 Session ID 请求未计划支持](https://github.com/openai/codex/issues/17782)
- [OpenAI Codex：`notify` 不覆盖审批与用户输入请求](https://github.com/openai/codex/issues/11808)
- [Google Gemini CLI Hooks 文档](https://github.com/google-gemini/gemini-cli/tree/main/docs/hooks)
- [OpenCode 事件与 SDK 实现](https://github.com/anomalyco/opencode)
