# 交互式任务终端与任务哨兵解耦设计

## 文档状态

- 状态：设计已落地，阶段 A 条件未全部通过。
- 首版目标 Agent：Codex。
- 本阶段边界：只落设计、验证 Hook 与恢复信号，不修改 SoloMap 运行时代码。
- 当前阻塞：Codex Hook 生命周期信号可用，但普通本地扩展尚无“受支持、无额外警告、无需改写私有信任状态”的自动授权方式。

## 用户结果

用户从 Solo 或路线图环节发起任务后，第一次就进入 Agent 原生交互终端；Agent 完成当前回复后，终端继续等待用户输入，用户不需要回到侧边栏点击“继续”才能补充要求。

任务哨兵仍然能够准确区分：

- Agent 正在执行当前轮次。
- Agent 已完成当前轮次，正在等待用户继续。
- Agent 正在等待用户确认或回答。
- 当前轮次失败、被中断或终端被关闭。

侧边栏只使用上述用户语言，不暴露 Hook、PTY、事件日志、适配器或 Provider 协议。

## 当前实现与问题

### Observed in code

- 用户主动发起的首次任务通过 `codex exec`、Cursor `-p`、Claude `-p` 等非交互命令执行（`src/agentCli.ts` 的 `buildAgentCommandForPromptFile`）。
- 运行脚本在 Agent 命令前写入 `Running` 状态和心跳，在命令退出后捕获 Session、计算工作区变化并写入最终状态（`src/extension.ts` 的 `buildAgentShellScript`）。
- 原生续聊已经使用交互式 CLI（`src/agentCli.ts` 的 `buildNativeContinueCommand`）；在 Unix 环境存在 `script` 时，SoloMap 可以在保留终端交互的同时捕获输出（`src/extension.ts` 的 `terminalExecutionScript`）。
- 活动对话账本和跨窗口 lease 已有独立实现（`src/activeConversationLedger.ts`），侧边栏动作仍以 `Running` 与否区分“打开终端”和“继续”（`src/conversationPresentation.ts`）。

### Inference

现有任务哨兵不是必须依赖非交互终端。真正的耦合是：系统把“Agent 命令退出”当成“当前任务轮次完成”。交互式 TUI 完成一轮后仍会等待下一次输入，因此不能再用进程退出作为主要完成信号。

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

### 3. 任务哨兵监控活动轮次，不监控空闲会话

- 用户提交输入时创建活动轮次并进入“正在执行”。
- Agent 完成回复后结算该轮次并从活动账本移除。
- 终端仍然存在时，会话进入“等待你继续”，但不继续占用活动任务账本。
- 用户再次输入时，在同一主对话下创建下一轮并重新注册活动轮次。

终端和原生 Session 的可恢复映射独立保存，不用 `Running` 状态维持。

### 4. 每轮独立结算

下列动作从“CLI 退出后执行”迁移为“每轮结束后执行”：

- 记录本轮开始、结束和结果。
- 捕获或确认原生 Session ID 与 Turn ID。
- 计算本轮文件变化和验证信号。
- 保存用户输入与 Agent 最终结论。
- 更新最近对话和侧边栏状态。
- 触发现有复核或完成决策，但不改变其原有边界。

用户提交下一轮之前必须建立新的工作区基线，避免把多个轮次的变化归到同一个执行记录。

## 标准化生命周期

Provider 适配器向 SoloMap 输出统一事件：

```text
session_started
turn_started
turn_waiting_for_user
turn_completed
turn_failed
turn_interrupted
session_closed
```

事件至少携带：

- `provider`
- `runId`
- `rootConversationId`
- `sessionId`
- `turnId`
- `eventType`
- `occurredAt`
- `cwd`

事件以 `provider + sessionId + turnId + eventType` 幂等。同一 Hook、文件观察和终端事件重复到达时，只能结算一次。

## Codex 首版信号设计

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

## 终端与侧边栏行为

- 当前轮执行中：显示“正在执行”，主动作是“打开终端”。
- 等待审批或回答：显示“需要你确认”，主动作是“打开终端”。
- 当前轮完成且终端仍在：显示“等待你继续”，主动作是“打开终端”。
- 终端关闭且 Session 可恢复：显示“继续”。
- 执行中关闭终端：当前轮记为停止或异常中断。
- 等待输入时关闭终端：正常关闭会话，不把已完成轮次改成失败。

终端内后续输入自动成为同一主对话下的新轮次，不创建新的顶层 Solo 对话。

## 失败与降级

- Hook 漏发：使用 rollout 事件恢复。
- Hook 与 rollout 冲突：优先使用带同一 Session/Turn 身份的持久完成或中断事件，并记录冲突信号。
- Hook、rollout 均不可用但终端退出：按退出码和终端关闭原因收口。
- Provider 不具备可验证的轮次信号：继续使用现有非交互兼容模式，不以终端空闲或文本匹配伪造精确监控。
- 等待用户确认时停止普通失联计时，避免把人工等待判为 supervisor 丢失。

## 分阶段实施

### 阶段 A：设计与可行性验证

- 验证 Codex 当前版本支持运行级 Hook 配置。
- 验证 `SessionStart`、`UserPromptSubmit`、`Stop` 的载荷字段和触发顺序。
- 验证同一交互终端中的第二轮继续触发完整生命周期。
- 验证 Hook 处理器可以静默、快速、无提示词落盘地写入隔离事件文件。
- 验证根 Agent 与子 Agent 的 Session 身份是否足以过滤。
- 验证退出、打断、限额或 Hook 漏发时的 rollout 恢复证据。

阶段 A 通过前不得修改运行时代码。

## 阶段 A 验证记录（2026-07-29）

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

### 当前判定

Hook 事件模型在技术上可行，正常多轮和中断恢复链已经得到真实证据；但“无需破坏用户信任边界且不污染首次交互体验”的接入条件尚未成立，因此阶段 A 暂不通过，运行时代码继续保持不变。

阶段 B 只可在以下任一条件经用户确认后开始：

1. Codex 提供并验证了受支持的 Hook 授权/安装接口；
2. 产品明确采用一次性用户授权流程，并验证授权后升级与路径变化不会反复打扰；
3. 另行批准并验证不依赖受信 Hook 的 `notify + rollout` 等价方案。

### 阶段 B：Codex 用户主动对话

- 增加 Codex 生命周期适配器和事件日志。
- 首次任务使用原生交互 TUI。
- 将结算从进程退出迁移到每轮结束。
- 保留现有非交互后台任务路径。
- 更新侧边栏“打开终端 / 继续”动作。

### 阶段 C：其他 Provider

- Claude Code：Stop / SessionEnd。
- Gemini 系：BeforeAgent / AfterAgent / SessionEnd。
- GitHub Copilot CLI：agentStop / sessionEnd。
- OpenCode：session.status / session.idle。
- 其他 Provider 只有在生命周期信号通过同等验证后才启用交互监控。

## 阶段 A 通过标准

- 不修改用户现有 Hook 文件也能为一次测试运行注入 Hook。
- 首轮触发顺序可观察为 SessionStart、UserPromptSubmit、Stop。
- 同一 TUI 内第二轮再次产生 UserPromptSubmit、Stop，且 Session ID 不变、Turn ID 可区分。
- Hook 载荷可以稳定提供根 Session 与轮次关联所需字段，或者有经过验证的 rollout 补充方式。
- Hook 输出不污染正常对话，不记录测试提示词正文。
- Hook 重复事件不会导致重复结算。
- Stop 漏发或异常退出存在可验证的恢复路径。
- 验证产生的临时会话、事件文件和终端均已明确清理或保留原因。

任一关键标准不通过时，阶段 B 不得开始；文档必须记录阻塞、证据和替代方案。

## 运行时代码验收标准

- 首次任务直接进入交互终端。
- 不退出终端即可提交第二轮。
- 每轮完成后侧边栏及时进入“等待你继续”。
- 多轮均归属于同一个主对话并保留独立执行记录。
- 子 Agent 完成不会提前结算根 Agent。
- 关闭执行中的终端与关闭空闲终端产生不同结果。
- VS Code 重载后能恢复尚未结算的活动轮次。
- 两个窗口不会重复写入执行记录、自动化动作或完成副作用。
- Hook 漏发时持久事件能够恢复。
- 用户已有 Hook、设置和授权完整保留。
- 普通 Stop 不会修改路线图环节完成状态。

## 当前未授权范围

- 本文档不修改路线图、环节状态或完成标准。
- 阶段 A 不修改 Agent 启动、哨兵、账本、数据库和侧边栏运行时代码。
- 不引入 tmux、远程 TUI、后台驻留或关闭终端后继续执行。
- 不在首版同时改造全部 Agent Provider。

## 参考实现与上游证据

- [OpenAI Codex 配置与 managed hooks 说明](https://github.com/openai/codex/blob/main/docs/config.md)
- [OpenAI Codex：本地 IDE/wrapper 缺少受支持 Hook 信任接口](https://github.com/openai/codex/issues/21615)
- [OpenAI Codex：外部 `notify` 的 turn-complete 配置实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs)
- [Google Gemini CLI Hooks 文档](https://github.com/google-gemini/gemini-cli/tree/main/docs/hooks)
- [OpenCode 事件与 SDK 实现](https://github.com/anomalyco/opencode)
