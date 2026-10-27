# SoloMap 对话终端发起链路完整审计（2026-10-25）

## 1. 审计结论

本审计从用户、远程或自动生产者接受“新对话 / 继续”动作开始，闭合到目标 Agent CLI 真实进入本次任务，并同时检查项目绑定、持久状态、runner preflight、原生/MCP 收据、重试、恢复、取消、界面反馈和现有观测。第 1—12 节记录修改前的事实审计；审计闭合后实施的最小修复与候选包真实验收单独记录在第 13 节，避免把修复后状态倒写成事故现场事实。

结论分为五层：

1. **已证明的直接阻塞点**：插件在目标终端创建并调用 `show(false)` 后，把 runner 命令投递完全阻塞在 `terminal.processId`。最新生产 trace 等待了 84.378 秒；PID 返回后，命令发送、runner 启动和包装器放行都很快。因此本次“卡半天”的主等待不在 Prompt、runner 命令发送或启动门，而在 VS Code 终端创建/PTY 就绪事件传到 Extension Host 这一段。
2. **已证明的插件契约缺陷**：VS Code 的 `Terminal.show()` 和 `sendText()` 都返回 `void`。当前实现却在调用 `show(false)` 后立即记录 `focus=ok`，而日志里的 `activeTerminalId` 仍是旧项目终端；这个 `ok` 只证明调用没有同步抛错，不证明目标终端已显示或获得活动状态。用户看到其他项目终端，并不等于命令被投给了其他项目终端。
3. **已证明的版本放大回归**：0.0.621 引入生产默认 10 秒 `processId` 超时、双终端尝试、释放 lease 和 5 秒恢复轮询。在 14:06—14:18 的 18 个 delivery trace 中，36 次等待全部超时，形成“创建—等待—关闭—重建—再次恢复”的终端风暴。0.0.622 取消了生产默认超时，只保留 5 秒慢事件，阻止了风暴，但没有消除底层 84 秒等待。
4. **已证明的架构不合规**：本地优先基线要求用户对话先于 SQLite、全量同步、后台衍生计算和诊断，但当前 Runtime 对所有 data socket 无优先级地直接执行，前台 run 状态、stdout/stderr、diagnostic、growth 和维护共用一个 Node 进程、一个同步 SQLite store 和同一个数据库；OS 层 Runtime、Extension Host、file watcher 与 pty host 的 nice 值也全部为 0。现场数据库已达 18,568,531,968 bytes，Runtime 和 file watcher 出现高负载，4 核机器连续多秒 CPU idle 为 0。执行架构确实没有前台车道、后台让行或资源预算；这些共享资源对本次 84 秒宿主延迟的具体因果贡献仍是 Inference，不能写成已证明的唯一生产根因。
5. **已有原生 task-start 信号，但账本中的 start 并不天然是真收据**：`terminal.delivery.agent.spawn/launch` 只记录 `script`/Shell 包装层 spawn 和 fd 3 启动门放行。Codex transcript 的 `task_started` 与 Claude 已验证 native start 是 Agent 已进入任务的原生信号；但 Host 会在复用终端发送前先写 checkpoint start，初次 prepare 也会提前把 run 标为 `Running`，所以单独的 `status=Running` 可能早于 Agent 接收。初次 prepare 不写 `checkpointEventId`，因此首次 MCP start 仍会经过 Git/snapshot 后写真实 checkpoint；只有 Host 已预登记等同时满足 Running/Turn Started + `checkpointEventId=:start` 的路径，MCP start 才直接返回且不留下独立调用收据。现有原生信号也没有贯穿生产者的不可重置 `interactionId`，Codex/恢复观察还经过 5 秒串行 poll。因此既不能用 wrapper 事件，也不能笼统用账本 Running/start 字段作为 10 秒门禁终点。

## 2. 证据等级

- **Observed in code**：当前工作树或当前已安装 0.0.622 的真实代码路径。
- **Observed at runtime**：当前正式数据库、Extension Host 诊断、系统进程和宿主文件。
- **Inference**：由多项事实共同支持，但缺少目标边界内部的直接事件。
- **Evidence gap**：当前观测无法回答，修复前必须补齐或显式承认。

后文不把 Inference 写成已证明事实。

## 3. 用户动作到 Agent 启动的完整调用图

| 阶段 | 当前实现 | 状态/异步边界 | 当前证据 |
| --- | --- | --- | --- |
| 用户/自动生产者 | Sidebar Webview、Roadmap Webview、Telegram、智能内核工具、定时器、复核/维护/恢复器 | 不同生产者的接收、排队和 UI 状态不同；只有一部分带入口 trace | Observed in code；逐生产者见 3.1 |
| Webview 接收 | `src/sidebarProvider.ts` 或 Roadmap `onDidReceiveMessage` | Sidebar 只对白名单命令建立 trace；Roadmap 共享 action 没有等价入口 trace；`runTracedSidebarAction` 完成时记录的 `durationMs` 固定为 0 | Observed in code |
| 项目/设置快照 | `captureRegisteredConversationLaunchSnapshot` 等入口特定逻辑 | 多数本地 Webview 入口会在自身首个异步等待前固定项目、数据根和设置；智能内核先 refresh registry，Telegram `/run` 甚至到 Host 执行时才读取活动项目。不能用共享 helper 概括所有入口 | Observed in code；逐入口见 3.2 |
| 准备终端 | `revealAgentStartupTerminal` | **先等待** OpenCode 环境解析，再 `createTerminal`；按项目和环境签名登记 reservation；调用 `show(false)` 后同步记 `focus=ok` | Observed in code |
| 项目运行目标 | `captureConversationLaunchTarget` | 确保 Runtime 健康，创建绑定固定项目/数据根的 `SyncEngine` | Observed in code |
| Prompt 与运行登记 | `prepareOrdinaryConversation` / 各入口 handler | 通过 Runtime 在统一数据库登记 run、generation、turn、deliveryPending 和最终 shell command | Observed in code |
| 投递去重 | `launchAgentConversationTerminal` | 以 `(globalDataPath, resolved workspaceRoot, conversationId)` 作为内存 Promise key；Promise 未完成时同 key 复用 | Observed in code |
| lease 与终端绑定 | `claim_run_delivery`、`terminalDeliveryId`、`agentTerminalRunTargets` | 先 claim，后持久化 terminalName/deliveryId/trace；reservation 仅按同项目 + 完全相同环境签名消费 | Observed in code |
| 终端显示 | 两次 `terminal.show(false)` | API 无可等待返回值；当前日志只能记录调用，不知道主线程何时真正 reveal/activate | Observed in code + VS Code 类型契约 |
| PTY 就绪门 | `sendTextWhenTerminalReady` | 每终端 WeakMap 串行队列；等待 `terminal.processId`；生产路径无超时，仅 5 秒 slow 事件 | Observed in code |
| 命令提交 | `terminal.sendText(command, true)` | API 无确认回执；插件随后持久化 `terminalCommandSubmittedAt` | Observed in code |
| runner 任务前准备 | `runAgentProcess.js` / `prepareNativeAgentLaunch` | runner claim 后仍可能执行 Git 基线/预提交、全工作区 snapshot、Agent 数据库准备，以及 Provider 的 `--help`、`--version`、Cursor `create-chat` preflight；preflight 也复用通用 `execute()` | Observed in code；全部发生在正式任务之前 |
| 包装器/正式 Agent | `runAgentProcess.js` | 每次 `execute()` 都会记录 wrapper spawn 与 fd 3 gate；因此 preflight 和正式任务均可能产生 `agent.spawn/launch`。只有最后一次正式 `execute(command, ['stdout','stderr'], interactive, ...)` 才会在 gate 后 exec 目标 CLI | Observed in code；`agent.spawn/launch` 甚至不保证对应正式任务 |
| 任务开始信号 | `RunNativeObserver` / `checkpoint_current_run` | Codex/Claude native start 携带 Provider 原始开始时间；上一轮已完成时可新建 checkpoint turn，当前 turn 未结束时只 patch provider-native 字段和 `turnStartedAt`。初次 prepare 只有 Running、没有 `:start` event，首次 MCP start 会继续执行；Host 续轮预登记同时具备 Running + `:start` 时，MCP start 才直接返回而不产生唯一收据 | Observed in code；native start 是强信号，prepare Running 与 Host checkpoint 必须分开；没有入口 interactionId、统一 verdict 和全 Provider 强覆盖 |
| delivery 恢复 | `pollActiveConversations` | 每 5 秒列出待投递 run 并再次调用同一 launch；活跃 Promise 和 delivery owner 防止同 key 同时重复 | Observed in code |
| 原生事件恢复 | `RunRecovery` / `RunNativeObserver` | `RunRecovery` 每 5 秒单 flight、分页且逐 run 串行调用 observer；observer 自身再按 `(project, run, generation)` 串行 | Observed in code；会给真收据增加轮询与队头等待 |
| 关闭/停止 | `onDidCloseTerminal` / `stopAgentRun` / Telegram `internalStopAgent` | 正式终端关闭按捕获的项目+run 身份停止会话并清 binding，但 `processId` 等待没有显式监听 close/cancel；Telegram stop 另走错误的终端名前缀匹配 | Observed in code；本地关闭的 Promise 结算为 gap，远程停止为确定缺陷 |
| 最终界面 | conversation/status refresh | 命令提交后刷新来源项目；继续按钮只在 handler 完整结束时解除 pending | Observed in code |

### 3.1 真实生产者、入口收据与排队边界

| 生产者 | 进入插件的路径 | 入口收据现状 | 10 秒计时缺口 |
| --- | --- | --- | --- |
| Sidebar 普通输入 | Solo、步骤、Flow、续聊、重试、Continue Turn、时间计划、项目继续 | `conversation.runSolo`、`conversation.continue` 在 trace 白名单；其余多数命令不在 | 未带 trace 的入口会在 prepare/delivery 后重新起表 |
| Sidebar 卡片动作 | 交付修复、安全修复、PR 复核、基础能力修复、Issue 修复等不同控件最终发出 `conversation.runSolo` | 共享命令 trace 存在，但没有区分具体控件生产者和点击起点 | 无法逐控件给出独立入口样本和前端投递耗时 |
| Roadmap Webview | 环节对话、Solo、Flow、路线图调整及续接动作进入 `handleSharedWebviewAction` | Roadmap 的 `onDidReceiveMessage` 没有与 Sidebar 等价的统一入口 trace；路线图调整 sender 未带 `projectPath`，Host 回退活动/选中项目 | 点击到共享 handler、入口准备和失败清理未计时；路线图调整存在确定项目漂移缺陷 |
| Telegram | `/run` → `solopreneur.internalRunAgent` | Telegram 只传 `nodeId`；Host 执行时才读取可变 `activeProjectRoot`，handler 提前返回也仍可能回复“已启动” | 项目身份、远程接收、editor command 排队与 Agent task-start 未绑定；存在确定的错项目/假确认缺陷 |
| 智能内核工具 | Runtime `start_conversation` → `ConversationTracking.reserve/beginDispatch` → editor bridge → `solopreneur.internalStartConversation` | Runtime 有 launch reservation、dispatch owner、死亡清理和 acknowledge 状态，但没有贯穿目标 Agent CLI 的同一单调计时 | registry refresh、target capture、dispatch 恢复和 editor command 排队可以被漏掉 |
| 定时自动化 | scheduled task poller → `handleRunSoloConversation` | 有 occurrence/launch intent，未建立统一入口 trace | 应从定时触发被正式接收而非 terminal delivery 开始计时 |
| 结算后自动动作 | run settlement → automation effect → retry 和/或自定义 prompt → Solo/步骤/路线图调整 handler | effect/intent 可持久恢复，但没有贯穿真实 CLI 的统一入口 trace；同一规则的 retry 与 prompt 顺序执行 | 应从 effect 取得执行资格并被本地消费者接收时计时，前一个动作不能让后一个无界排队 |
| Flow/复核后继 | Flow role、自动复核、复核修订由前序状态机产生 | 有 run 身份，通常没有用户入口 trace | 应从后继任务具备执行资格并被调度时开始计时 |
| 维护类 Agent | CLI/技能/MCP 安装升级、迁移、回收等正式动作 | 直接 prepare 后进入共享 delivery | 应从维护动作被插件接受时开始计时 |
| 全局提示词复盘 | `settings.reviewGlobalPrompt` → `runGlobalPromptReview` | 绕过共享 delivery，直接 `createAgentTerminal` + `sendTextWhenTerminalReady`；同内容请求等待全局单 flight | 点击、复盘准备和直接 PTY 等待未纳入统一 trace，项目终端归属也未走共享契约 |
| 已有原生会话续轮 | 当前生产 UI 的 `conversation.continue` → 复用 terminal → Host 预登记 turn → `sendAgentTextWhenTerminalReady`；另有无生产 sender 的兼容 handler `conversation.continueTurn` | handler 在 `sendText()` 返回后结束；Host checkpoint start 发生在发送前，不是真收据。Codex/Claude native start 可随后形成强信号，但未与本次入口 interaction 关联或被 handler 等待；MCP start 可能被幂等短路且不留独立收据 | 终点应是已绑定 CLI 自身确认本轮输入，不能套用“新进程启动”或用 Host checkpoint/`sendText()` 冒充 |
| 项目成长汇报继续 | 成长汇报 `growth.reportAction(kind=continue)` → `growthReportActions` 去重 → 读取原任务/汇报 → 等待进程清理 → `handleContinueConversationTurn` | 独立 Webview 入口；其输入框确认、去重等待、资料读取和 cleanup 均没有贯穿到目标 CLI 的统一 trace | 必须从用户确认补充要求时起计时；不能在进入共享续聊 handler 后重置，`growthReportActions` 和 cleanup 等待都计入同一 5/10 秒预算 |
| 原生终端直接输入 | 用户直接在仍存活的 Agent CLI 终端键入下一轮 | 绕过 Webview/Host action；Codex `task_started` / Claude native event 可在后续恢复为新轮次，但插件没有该次输入的动作起点、端到端时延或同步 verdict | 明确纳入插件体验承诺：terminal bridge 只传输原始按键；以对应 Provider 官方 submit-accepted 候选确认提示已被 CLI 接受并建立 pending attempt，终点仍只能是更后的 Provider task-ingress 强状态。空 Enter、审批/提问回答、slash command、本地命令与多行编辑不得误建 attempt，适用同一 5/10 秒门禁 |
| delivery recovery | 5 秒 poller 发现持久 pending run | 只有新建的 delivery trace | 必须继承原动作时间；不能以恢复轮询时间重置 10 秒预算 |

另有四个非对话维护入口直接使用 `sendTextWhenTerminalReady`：GitHub 登录、GitHub CLI 检查、Agent CLI 安装、Agent CLI 检查。它们不属于“Agent 对话进入任务”的逐入口验收集合，但会创建普通终端并竞争同一 terminal service / PTY Host，必须作为后台负载与资源竞争生产者进入满载验收，不能从系统边界中忽略。

全局提示词复盘必须列入正式对话验收集合，而不是只作为旁路实现备注：它启动 `learning_review` Agent、当前直接创建终端并发送正式 runner 命令，且用户能从设置入口触发。逐入口基线因此至少包括 Sidebar、Roadmap、Telegram、智能内核、定时任务、effect 派生任务、Flow/复核后继、维护类 Agent、全局提示词复盘、现有会话续轮、成长汇报继续、原生终端直接输入和 delivery recovery。

因此“共享 helper 已覆盖”不等于“所有入口已验收”。本审计已反查三个 helper 的生产调用，并将调用方显式分为 Agent 对话入口、原生终端直接输入和非对话终端维护入口；当前实现尚未为每个对话生产者提供不可重置的动作起点及真实 CLI 收据，这是修复契约和验收工具必须闭合的缺口。

### 3.2 各类入口在首个异步边界前后的真实顺序

通用调用图不能代替入口自身审计。当前入口至少分为以下不同顺序，所有列出的前置等待都属于同一 5/10 秒预算：

| 入口 | 同步捕获/接收点 | 首个及后续任务前等待 |
| --- | --- | --- |
| Sidebar Solo/步骤/Flow/普通续聊/重试/时间计划/项目继续 | Webview Host 收到动作；部分入口同步捕获项目和设置 | 多数先 reveal，再捕获 Runtime/engine、读取历史或 cleanup、prepare；不同 handler 的 reservation 释放不一致 |
| 路线图调整 | Roadmap Webview 发送动作；当前 sender 未携带 `projectPath` | Host 先从可变 `activeProjectRoot/getSelectedProjectPath` 补项目，再 `captureConversationLaunchTarget`、项目动作队列和 `handleRoadmapRevision`；没有预创建终端，存在确定跨项目漂移缺陷 |
| 当前生产 UI 的 Continue | Host 收到 `conversation.continue` 的项目和 conversation | 先 reveal，再捕获 target、读历史并等待 cleanup；复用时 Host `checkpoint(start)` 先读取状态、Git HEAD 和全工作区 snapshot，落账后才 `sendText`。这些重 I/O 全部计入 5/10 秒；无法复用时进入新 delivery |
| 兼容 Continue Turn handler | `conversation.continueTurn` 仅有 action alias、Host handler 和测试，当前无生产 Webview sender | 先捕获 target、读历史和 cleanup，之后才可能 reveal/复用；仍属于可调用兼容面，但不得冒充当前 UI 生产入口样本 |
| 项目成长汇报继续 | `growth.reportAction` 命中动作并加入 `growthReportActions` | 读取 sources/原任务/汇报、捕获 target、等待用户输入、cleanup，再进入继续 handler |
| 智能内核 | Runtime 接受 tool 调用并持久化 launch reservation/dispatch owner | editor bridge 调用后，Extension 先 refresh project registry，再捕获 target；step/solo 到这之后才 reveal，Flow 无预创建终端 |
| 定时任务 | poller 读取一次 settings 后 claim 一批 due occurrence | claim 后按数组逐个 `await runScheduledAutomationTask`；每条执行时又重读当前 settings，并重新决定 project、data root 与 CLI，再执行 Runtime health、`engine.initAndSync()`、reveal、prepare、delivery。后一个既受前一个队头阻塞，也可能在等待期间发生身份/设置漂移；task contract 的 `projectPath` 还是可选 |
| Telegram `/run` | Runtime inbox 已先 durable accept，随后 claim；action dispatch 前还会 `begin_inbox_action` | inbox schema 没有不可变 acceptedAt，当前 handler 也未携带项目；等 editor bridge 到 Host 后才从可变活动项目捕获，再 reveal、capture target、prepare。修复必须以 durable inbox accept 为 acceptedAt，在 accept 时固定项目/data root/config，并让 claim、reclaim、begin action、editor command 和 task receipt 复用同一 interaction |
| 自动 effect | effect 进入持久可执行状态时应写 `eligibleAt/parentInteractionId`；当前 consumer 再取得 owner，list/claim/apply | apply 内还会创建/初始化 engine、查询 execution/status，随后重读 automation settings；revision 重读 `taskPermissionMode`，Flow 重读 `globalPrompt`。前序等待期间设置变化会改写已 claim 动作。修复必须从父 `eligibleAt` 建立不可变 budgetOriginAt，在 claim 时原子冻结项目、data root、规则、CLI、模型、权限和 prompt policy；retry/custom prompt 使用确定性 childInteractionId、各自 acceptedAt，但共同继承父预算起点并独立启动 |
| Flow role/恢复 | Flow role 具备执行资格或读到已有 intent | 先访问权限/flow state/Prompt 或 `read_run_state` + `resumePreparedAgentRun`，再共享 delivery；后继 role 通常无预创建终端 |
| 自动复核 | review intent 具备执行资格 | 首个 Runtime `read_run_intent`，再读取主 run/output/Git evidence、构造 Prompt、prepare，之后共享 delivery |
| 复核修订 | revision intent 具备执行资格 | 首个 Runtime `read_run_intent`，再读取主 run/binding、prepare continuation，之后共享 delivery |
| 维护类 Agent | CLI/技能/MCP 设置动作、capability operation 或迁移动作被接受 | 技能安装/升级/卸载可能先访问 store、registry 或 capability operation；迁移回收可能先生成计划并等待用户最终确认；随后才 Runtime health、可选 filesystem baseline、prepare maintenance 和共享 delivery。需要用户确认的入口以最终确认被接受为 5/10 秒起点，初次点击只计算其交互等待，不把用户思考时间计入启动预算 |
| 全局提示词复盘 | 设置动作通过全局 single-flight | 先以 `context.extensionPath` 而不是已经解析的 `workspaceRoot` 创建终端，导致 cwd/ownership key 错绑扩展目录；首个 await 为 Runtime health，随后 register project、prepare，再直接 `sendTextWhenTerminalReady`，绕过 delivery claim |
| 原生终端直接输入 | 终端收到用户提交 | 绕过 Webview Host；现有 Codex/Claude observer 或 MCP start 在任务开始后才能入账，且没有与提交时刻相连的 interaction |

这张表描述当前实际边界，不表示顺序合理。修复后的统一要求是：每个入口在其生产者正式接受动作时建立不可重置计时；此后的 registry、engine、cleanup、队列、preflight、PTY、恢复观察全部计入，不能在共享 handler、prepare、delivery 或 native observer 处重新起表。

### 3.3 现有 task-start 信号的语义矩阵

| 来源 | 发生时机 | 当前持久结果 | 能否直接作为门禁终点 |
| --- | --- | --- | --- |
| Host `registerInteractiveConversationTurn` | 复用终端发送文本之前 | 调用 `checkpointRun(start)`，创建新 turn、写 `turnStartedAt`、递增 `checkpointEventId` | 否；这是发送前预登记 |
| prepare `patch_run_inputs(status=Running)` | runner/CLI 启动之前 | run 投影已经显示 Running，但没有因此生成 `checkpointEventId=:start` | 否；只是 launch 已准备，也不会单独触发 MCP fast path |
| MCP `solomap_conversation_status(start)` | Agent 主动调用工具时 | 初次 prepare 虽是 Running，但没有 `:start` event，仍会先读 Git HEAD、snapshot workspace，再 `checkpointRun(start)`；Host 已预登记等同时满足 Running/Turn Started + `:start` 时才立即返回原状态 | 首次普通 checkpoint 的完成可证明 MCP 已调用，但 receipt 时间被 Git/snapshot 推迟；幂等快路径不保存独立调用到达时间，续轮无法从持久状态唯一证明 |
| Codex transcript `task_started` | Provider 已开始 turn | observer 保存原生 turn id/startedAt/offset；当前 turn 未结束时只 patch native 字段与 `turnStartedAt`，上一轮已结束时才 `checkpointRun(start)` 新建 turn | 是强信号，但当前发现依赖身份绑定与最多 5 秒起步的串行恢复观察，且未关联入口 interaction |
| Claude `native-event` start | Provider hook 产生受控 start event | `recordClaudeNativeEvent` 先持久 document/head，随后同步 observer；`native-ready/native-append` 自身不触发 observer。observer 再按当前/新 turn 分支记录 native 字段或 checkpoint | 已验证 contract 下是强信号，但未关联入口 interaction；fallback transcript/recovery 仍可能排队 |

因此修复不能把 `checkpointEventId`、`turnStartedAt` 或 `Running` 统一定义成 task-start。必须给 native start 和实际 MCP start 调用保存独立收据，完整绑定 `(data root, project, run, execution, generation, delivery/turn-attempt, turn, interaction)`；Host 预登记保留账本作用，但明确标记为 `host-accepted`，不得进入时限终点。

## 4. 最新故障 trace 的逐段时间线

正式 0.0.622，trace `71e9dc9cdae5ec69`，目标项目 `/home/ubuntu/project/ME`，execution id 148：

| UTC 时间 | 事件 | 本段耗时/累计 |
| --- | --- | --- |
| 16:29:11.086 | 用户动作进入 Extension Host | 0ms |
| 16:29:11.090 | startup terminal create/show 调用返回 | 4ms |
| 16:29:11.199 | 项目目标捕获完成 | 110ms |
| 16:29:11.290 | Runtime 健康确认完成 | 90ms |
| 16:29:11.388 | resume 检查完成 | 98ms |
| 16:29:11.610 | session 阶段完成 | 61ms |
| 16:29:11.637 | Prompt 阶段完成 | 27ms |
| 16:29:13.166 | run 准备完成 | 1,529ms；累计 2,080ms |
| 16:29:13.618 | delivery claim 完成 | 380ms |
| 16:29:13.619 | 第二次 `show(false)` 同步记为 ok | 日志仍显示旧 active terminal |
| 16:29:14.876 | terminal identity 持久化完成 | 1,257ms |
| 16:29:14.877 | 开始等待 `processId` | 累计 3,791ms |
| 16:29:19.878 | 记录 slow | 已等待 5,001ms，不中断 |
| 16:30:22 | `/bin/bash` 真实进程出生 | 点击后约 71 秒 |
| 16:30:39.255 | Extension Host 收到 PID 2758090 | `processId` 等待 84,378ms；比进程出生晚约 17 秒 |
| 16:30:39.256 | `sendText` 调用完成 | 小于 1ms |
| 16:30:39.357 | submission 持久化完成 | 102ms |
| 16:30:40.005 | runner PID 2758532 启动 | 命令提交后约 649ms |
| 16:30:40.045 | runner claim | 40ms |
| 16:30:40.242 | 包装器 PID 2758549 spawn | 197ms；实际进程为 `script` |
| 16:30:40.255 | fd 3 启动门放行 | 13ms；不是实际 Agent CLI 启动回执 |

运行进程树显示，PID 2758549 是 `script`，其下 PID 2758550 才进入配置的 Codex CLI 启动器，随后再拉起供应方可执行进程。现有 delivery trace 没有记录后两者的精确毫秒时间，也没有关联本次入口的 native/MCP task-start。数据库虽可能在后续由原生 observer 或 Agent MCP start 写入真实任务开始状态，但没有与这条 delivery trace 的不可重置 interaction 贯通，不能反推出完整端到端耗时。这条 trace 可以排除 Prompt 组装、run prepare、runner claim 和包装器启动门是 84 秒主阻塞，但不能声称已经精确测得真实 Agent CLI 启动。直接阻塞边界仍是 terminal create/show → shell fork → `processId` 回调传播。

## 5. “错误项目终端”现象的真实含义

最新 trace 中：

- 请求目标 terminal id：`terminal-2c0647631d8b`
- `show(false)` 调用前采样的 active terminal id：`terminal-37d2b12d5d9a`
- 两次 focus 事件都立即记录 `ok`，但记录的是调用前快照，没有 show 后复核。

代码检查结果：

- 首次正式投递保存并使用的是目标 `Terminal` 对象，不读取 `vscode.window.activeTerminal` 来选择发送对象。
- reservation map 以 `workspaceRoot` 分区，正式终端只消费同一项目且环境签名相同的 reservation。
- delivery Promise 使用 data root + 项目路径 + conversation id；但终端 binding、native continuation flight 和部分 cleanup key 只有项目路径 + conversation id。当前初次投递路径没有“任选当前活动终端”的代码。
- 本地 stop 从 Webview 只接收项目/conversation，执行时又读取当前设置的数据根；切换数据根后，相同项目和数字 ID 可能命中错误数据库或旧内存 flight。

所以当前证据支持的是：**这条初次投递中，旧项目终端在 UI 上继续保持活动，因为目标终端 reveal/activate 尚未完成；正式命令仍等待并最终发送给目标终端对象。** 不能把这个视觉现象错误描述成该次命令被路由到旧项目。独立缺陷仍存在：focus 日志不真实、宿主 reveal 不可确认、目标 PTY 创建被延迟，以及 data root 未进入全部终端/控制身份。

## 6. 所有终端创建入口与 reservation 清理矩阵

### 6.1 预创建终端入口

| 入口 | 预先 reveal | 正式消费 reservation | 未启动时显式 discard | 审计结果 |
| --- | --- | --- | --- | --- |
| `conversation.runSolo` | 是 | 是 | 是，`finally` | 闭合 |
| `conversation.runStep` | 是 | 成功进入 delivery 时是 | 否 | 提前返回/失败可残留 |
| `timePlan.generate` | 是 | 成功进入 delivery 时是 | 否 | 提前返回/失败可残留 |
| `flow.run` | 是 | 首个 role delivery 时是 | 否 | 授权拒绝、空目标或准备失败可残留 |
| `conversation.continue` | 是 | 新 run delivery 时是 | 否 | 找不到历史、cleanup/身份恢复失败可残留 |
| `conversation.retry` | 是 | 重试 delivery 时是 | 否 | 前置失败可残留 |
| `conversation.continueTurn` | 无可复用终端时是 | 新 run delivery 时是 | 否 | 新 run 前失败可残留 |
| `project.continue` | 是 | 成功进入 delivery 时是 | 否 | 注册失败可残留 |
| `internalRunAgent` | 是 | 成功进入 delivery 时是 | 否 | 提前返回/失败可残留 |
| `internalStartConversation: step` | 是 | 是 | 仅未 registered 时 discard | 基本闭合 |
| `internalStartConversation: solo` | 是 | 是 | `finally` discard | 闭合 |
| `internalStartConversation: flow` | 否 | 不适用 | 不适用 | 独立正式创建 |
| scheduled solo | 是 | 是 | 否 | 准备失败可残留 |
| recovery poller | 否 | 不适用 | 不适用 | 直接创建正式终端 |

残留 reservation 不会跨项目消费，但可能被同项目、同环境的后续启动拿走，使“后一次动作复用前一次空终端”。这是当前代码中的确定缺口，不是本次跨项目视觉现象的唯一解释。

### 6.2 正式 delivery 的全部生产调用组

共享 delivery 的所有 `launchAgentConversationTerminal` 调用可归为以下七组；此外还有两条绕过共享 delivery、直接向终端发送的 Agent 路径：

| 调用组 | 是否有用户动作开始时的预创建终端 | 当前边界 |
| --- | --- | --- |
| ordinary conversation：Solo、步骤、续聊、retry、time plan、roadmap revision | 取决于上表入口；roadmap revision 没有 | 统一经 `deliverOrdinaryConversation`；没有预创建的入口要到 prepare 完成后才创建终端 |
| Flow 首个/后续 role | `flow.run` 只预创建一次 | 首个 role 可消费 reservation，后续 role 直接新建正式终端 |
| Flow 持久状态恢复 | 否 | 已登记的待投递 role 直接创建正式终端 |
| Agent 自动复核 | 否 | 读取主 run 证据并 prepare 后才创建终端 |
| Agent 复核修订 | 否 | 读取主 run/binding 并 prepare 后才创建终端 |
| maintenance agent：迁移、回收、CLI/技能/MCP 等维护动作 | 否 | prepare 完成后直接创建正式终端 |
| delivery recovery poller | 否 | 从持久 run 恢复后直接创建正式终端 |
| 全局提示词复盘（绕过共享 delivery） | 否 | 直接创建终端并调用 `sendTextWhenTerminalReady`，未使用共享 lease/identity/trace |
| 已有原生会话续轮（绕过新 CLI delivery） | 复用现有终端 | 登记新 turn 后调用 `sendAgentTextWhenTerminalReady`；正确终点是存活 CLI 接收本轮，不是新进程 spawn |

因此基线中的“所有入口先给出终端可见反馈”当前并未统一实现；共享的只有正式 delivery 和 `processId` 就绪门，预创建/显示与失败清理仍由各入口自行决定。

## 7. 恢复、重试与取消审计

### 7.1 当前 0.0.622

- 正常生产调用没有 `terminalReadyTimeoutMs`，因此 `processId` 永远不返回时，delivery Promise、内存去重 key 和 UI pending 都可能无限保留。
- 5 秒 `terminal.process.slow` 只是诊断，不取消、不释放 lease、不创建替代终端。
- recovery poller 会看到未投递 run，但同 Extension Host 内由 delivery Promise 和 owner lease 防重；它不能让挂起的 `processId` 更快完成。
- 用户关闭终端会进入 `handleAgentTerminalClosed`，但等待函数没有显式把关闭事件接入 cancellation。宿主最终会把 `processId` resolve 为 `undefined`、reject，还是永久未结算，当前没有真实宿主证据。
- runner 已认领前有 10 秒 watchdog；它只覆盖命令已经提交之后的 runner claim，不覆盖本次 84 秒 PTY 等待。
- Telegram `/stop` 调用 `internalStopAgent`，当前只按终端名是否以 `step-` / `solo-` 开头来 dispose；实际 Agent 终端名以项目名开头，因此通常无法命中，也没有项目、run、generation 或 delivery lease 身份。该停止入口不能取消 Flow、复核、维护或尚在启动等待中的任务。
- Telegram `/run` 不携带项目身份，Host 收到时才读取活动项目；没有项目时 handler 可提前返回，但调用侧没有权威 started receipt 仍可能回复已启动。这是已确认的远程入口归属与确认缺陷。

### 7.2 0.0.621 的回归

提交 `d8622a3` / 版本 0.0.621 增加了生产默认 10 秒 readiness timeout、两次尝试、delivery release 和恢复轮询。14:06—14:18 的正式诊断显示：

- 18 个独立 delivery trace；
- 36 次 `process.wait start`；
- 36 次约 10 秒后 `terminal_process_timeout`；
- 18 次第一次失败后的 retry；
- 18 次第二次失败；
- 14:12 同时存在两个 delivery trace。

因此 0.0.621 是明确的**放大回归**。提交 `499608c` / 0.0.622 移除了生产默认 timeout，修正了重建风暴，但把行为恢复为无限等待，底层故障仍在。

### 7.3 当前队列、single-flight 与队头阻塞

Observed in code：

- `pollActiveConversations` 以 data root 为 key 使用 `activeRunConsumerPolls` 做整轮 single-flight；一轮内逐页、逐条 `await launchAgentConversationTerminal`，之后才执行 terminal owner reconcile、pending status settlement、run effects、automation UI delivery 和 completion criteria refresh。首条 delivery 的 `processId` 无限等待会阻塞同一 data root 后续所有 pending delivery以及这些结算动作。
- `agentTerminalDeliveries` 以 `(data root, project, conversationId)` 复用同一个完整 delivery Promise。同一 run 的重复入口不会重复发送，这是正确去重；但所有等待者也会共同挂在同一个无界 `processId` Promise 上。
- `projectActionLaunchQueues` 按项目串行等待前一个动作调用 `registered()`。多数入口在 run 登记后、正式 delivery 前释放，但只要前一个动作在 runtime/prepare/登记之前卡住，后续同项目用户动作就会把这段排队计入自身真实等待；当前 trace 没有记录 queue enter/leave。
- `nativeContinuationByConversationKey` 按 `(project, conversationId)` 复用整个续聊 Promise，未包含 data root；范围覆盖终端 reveal、项目捕获、旧进程清理、原生身份恢复、新 run 准备和 delivery。首次续聊若挂起，同 key 后续续聊全部等待；切换 data root 后相同数字 ID 还可能错误复用旧 flight。
- `agentProcessCleanupByConversationKey` 按 `(project, conversationId)`（Runtime 路径还带 data root 别名）复用进程清理 Promise。`conversation.continue`、`conversation.continueTurn` 和成长汇报继续均在 CLI 投递前等待它；当前没有 queue enter/leave、继承原动作起点或分段收据，清理挂起会直接吞掉 5/10 秒预算。
- `growthReportActions` 按 data root、项目、任务、execution、turn 和动作种类去重成长汇报动作；“继续”从加入集合直到资料读取、cleanup 和完整续聊结束才释放。相同动作会被静默忽略，当前没有把这段占用关联到用户动作收据。
- `terminalInputQueues` 按 terminal 串行所有文本投递。已有 CLI 的 Continue Turn 与用户/系统先前投递共享该队列，但当前没有 queue wait 到真实 CLI 接收本轮的端到端收据。
- `activeGlobalPromptReview` 对全局提示词复盘做全局 single-flight；同内容请求等待整个复盘任务，不同内容直接拒绝。其直接终端路径同样会无界等待 `processId`。
- 全局提示词复盘的 direct path 在 `prepareAgentRun` 后直接 `sendTextWhenTerminalReady`，没有显式 `claim_run_delivery` 或 `terminalDeliveryId`；不过 prepare 已写入 delivery owner，活 owner 会被 recovery 查询排除，所以同一活 Extension Host 下不会每 5 秒并发抢投递。真实缺口是：活 owner 卡在 `processId` 时 recovery 被无限压住；若 owner 死亡，旧 Shell/命令可能迟到，而 recovery 会重新投递。run generation/claim 可阻止两个有效 owner，但当前不能保证一个终端、一次命令尝试。
- owner 丢失窗口不只属于全局复盘：`prepare_run` 在数据库创建 run 时就写入当前 Extension Host 的 live delivery owner，之后 `prepareAgentRun` 还会执行 binding、planned session、policy read、memory context 和 `patch_run_inputs`。任一步抛错时，普通首发调用方尚未取得完整 prepared result，通用路径没有对应 release；全局复盘在 prepare 后的 terminal closed/send failure 分支也直接抛错。数据库因此保留 live owner，recovery 持续排除该 pending run，形成无需 `processId` 卡住也能永久不恢复的通用缺陷。
- `activeRunEffectPolls` 按 data root 串行 claim/apply effect；结算后的 automation retry 与自定义 prompt 在同一 effect 内顺序 `await`，第一个 Agent 启动挂起会阻止第二个以及后续 effect。
- effect claim 后仍会在 engine 初始化/状态查询之后重读当前 automation settings，revision 路径重读 `taskPermissionMode`，Flow 路径重读 `globalPrompt`；已具备执行资格的动作会因排队期间设置变化而漂移，且当前没有从持久 `eligibleAt` 贯穿的 interaction。
- scheduled poller 一次 claim 一批 due occurrence，随后逐条等待完整 `runScheduledAutomationTask`；第一条的 Runtime/engine/terminal/CLI 启动会让同批后续 occurrence 排队。
- `ConversationTracking.reserve` 命中同一未 acknowledged launch 时仍会调用 `beginDispatch` 新增 token；schema 只有普通 ref 索引，没有单一 live-dispatch 约束。Runtime 又在 acknowledged、`deliveryPending=false` 或仅 `terminalCommandSubmittedAt` 时返回 `status=started`，Extension 内部命令也只等待 handler/命令提交，因此会出现多个 live dispatch 和早于 task-start 的假启动回执。
- `RunRecovery.recovery` 将每 5 秒触发的整轮恢复合并为单一 Promise；每轮在扫描任何 run 前先全局等待 `RunInputMaterialization.recover()`，之后才按页、按 run 顺序等待 `RunNativeObserver.observe`、workspace snapshot、Git evidence 和结算。input materialization 或一个慢 run 都会推迟后续 run 的原生 `task_started` 入账。
- `RunNativeObserver` 再按 `(projectId, runId, generation)` 把观察工作串接到先前 Promise；同一 run 的后续直接输入必须等待该 run 已排队的 transcript/native event 处理。

这些队列有去重与顺序价值，但没有 10 秒前台预算、优先级或可跳过的后台边界。修复不能只替换最内层 terminal helper；必须保证任一 foreground launch 不会被另一个 terminal readiness、恢复扫描或后台 effect 形成队头阻塞。

## 8. 已证明的架构不合规与尚待补证的生产因果

这不是本地优先设计允许的正常退化，而是设计要求没有落实到运行架构。

### 8.1 基线要求

`docs/ui/local-first-loading-interaction-baseline.zh.md` 已明确规定：

- 对话入口以 5 秒为正常目标、10 秒为发布硬上限，终点必须是真实 Agent CLI 进入本次任务。
- SQLite 初始化或全量同步不得阻塞终端显示。
- 终端创建和可见反馈必须先于项目初始化、数据库准备、Git 备份与 Prompt 组装。
- L0 用户状态立即生效；L2 衍生数据只能在不影响 L0/L1 时补充。

### 8.2 当前实现为何不满足

Observed in code：

1. `startRuntimeControlServer` 为每个 data socket 直接执行 `await options.onData(parsed.request)`；请求没有 `foreground/background` 分类，没有优先队列、抢占、并发配额或 admission control。
2. `createRuntimeDataOperations` 把前台 run 生命周期、run log、diagnostic、growth、迁移、维护、智能循环等全部路由到同一个 `UnifiedDataStore`。
3. `UnifiedDataStore` 使用同步 SQLite。代码自己也承认“a synchronous SQLite request owns its event loop”。一个大事务执行期间，后来到达的前台请求无法在同一 Runtime event loop 内抢占。
4. `writeProjectGrowth` 把一个 snapshot 的全部 items、edges、signals 和 labels 放在同一个同步事务内逐条插入；现场近期每个 snapshot 约 5,584 items，还不含 edges。
5. `appendRunLog` 对每个输出 chunk 做同步事务，并同时写原 stream 和重复的 `output` stream、content、request、event 和结果 content。
6. 诊断事件也写入同一个数据库。越慢时生成越多 slow/retry 事件，观测本身继续参与共享 I/O。
7. Runtime 的后台 cycle、迁移、storage maintenance 与对话数据服务运行在同一进程。只有 storage maintenance 的部分 batch 会 `setImmediate`；growth snapshot 和大量同步 store 操作没有前台让行点。
8. Runtime、Extension Host、file watcher、pty host 都使用默认调度优先级（nice 0）；插件没有在用户点击发送时降低后台工作速率或暂停可延后的写入。
9. 对话主路径在正式 terminal delivery 前仍执行 Runtime 健康、resume、session、Prompt、prepare 和多次状态持久化。最新 trace 中，光 terminal identity persist 就用了 1,257ms。

因此已经能够证明的是：**所有工作都被设计成平权竞争，后台工作可以先持有不可抢占的同步数据库/事件循环和系统资源，前台对话没有可验证的 QoS**。这违反本地优先基线；但在 main thread、terminal service 与 pty host 的内部阶段补齐前，不能把 Runtime/SQLite 竞争写成本次 84 秒终端延迟的唯一直接原因。

### 8.3 为什么“没有更新也突然出现”

Observed at runtime：

- `solomap.db`：18,568,531,968 bytes，WAL 约 24MB，WAL mode，4KB page，约 453 万页。
- `sqlite_stat1`：`growth_items` 约 14,099,669 行，`growth_edges` 约 4,958,358 行，`contents` 约 2,785,154 行，`log_chunks` 约 1,820,759 行，`requests/events` 各约 128 万行。
- 近期单个 growth snapshot 约 5,583/5,584 items；数据库统计中存在 2,811 个历史 snapshot 估计，实时 snapshot 记录为 1,636，说明统计本身也存在陈旧度，不能混写成实时精确计数。
- Runtime PID 2742590 自 16:24 启动后累计 CPU 约 66%，file watcher PID 2742349 约 20%，Extension Host PID 2742433 约 25%；5 秒采样期间 Runtime 约 82%、file watcher 约 85%。
- `vmstat 1 6` 的五个实时采样 CPU idle 均为 0%，运行队列 10—24。
- Runtime `/proc/io` 累计 `write_bytes` 约 4.86GB、`wchar` 约 18.38GB。
- `appendRunLog` 每个 stdout/stderr chunk 都在一个同步事务中执行幂等查询、content 写入、原 stream 与重复 output stream 两条 log chunk、`MAX(events.sequence)+1`、event/descriptor/result content 和 request 更新。

Inference：终端主线程/PTY 消息与高频 SQLite、文件监视和 Extension Host 工作竞争 CPU/I/O，令原本没有前台资源优先级、可等待 reveal、取消和背压隔离的终端链路跨过延迟阈值。这是“版本不变、状态变大后突然恶化”的高相关解释，但现有证据尚不能量化每项负载的因果贡献。数据库增长和并发负载是现场触发条件；没有前台 QoS 是独立成立的架构缺陷，而不是已经证明的 84 秒唯一根因。

Evidence gap：没有 Terminal/Pty Host trace，不能从现有数据证明延迟具体发生在 main thread 接收 `$createTerminal`、terminal instance 建立、pty host 收到 create、node-pty fork，还是 fork 后 processReady IPC 回传中的哪一个队列。系统进程时间只进一步证明：约 71 秒发生在 shell fork 前，另约 17 秒发生在 shell 已存在到 Extension Host 收到 PID 之间。

## 9. Shell 初始化不是这 84 秒的主解释

- code-server 通过 `--init-file .../shellIntegration-bash.sh` 启动 bash，该脚本在 `VSCODE_INJECTION=1` 时 source `~/.bashrc`。
- 当前 `.bashrc` 确实包含 dbus/keyring、`secret-tool lookup` 和 grok completion，可能影响 shell 可交互时间。
- 但 `processId` 表示宿主收到 shell 进程身份，不要求 `.bashrc` 完成；本次 shell 进程已经在 16:30:22 出生，而 PID 到 16:30:39.255 才到 Extension Host。

所以 shell 配置可以作为后续独立性能审计对象，但不能用来解释 shell fork 前约 71 秒，也不能替代终端宿主链路根因。

## 10. 观测链路审计

### 已覆盖，但只覆盖部分入口

- Sidebar 白名单动作入口，以及进入共享处理后的项目捕获、Runtime、resume、session、Prompt、prepare、delivery。
- delivery claim、identity persist、`processId` wait/slow、`sendText` 调用、submission persist、runner watchdog。
- runner start/claim、包装器 spawn 和 fd 3 启动门放行。
- 受控 project/terminal 哈希标识，不记录用户正文、命令或凭据。

### 当前记录有误导性

- `terminal.startup.focus=ok` 和 `terminal.delivery.focus=ok` 只表示 `show(false)` 没有同步抛错。
- focus 的 `activeTerminalId` 是 show 前快照，却被跟随的 `ok` 原样复用。
- `sidebar.action.*` 完成事件的 `durationMs` 固定为 0；只能依赖 `elapsedMs` 判断端到端耗时。
- `sendText=ok` 只表示 Extension Host API 调用没有同步抛错，不代表 shell 或 runner 已接收；runner start/claim 才是后续强证据。
- `terminal.delivery.agent.spawn/launch` 的命名会误导为真实 Agent CLI 已启动；实际只覆盖 `script`/Shell 包装器和启动门。

### 已存在但尚未接入门禁的真实任务收据

- Codex：`RunNativeObserver` 在已确认 transcript 身份后读取 `event_msg.task_started`。当前活动 turn 只 patch `codexNativeTurnId/StartedAt/StartOffset/...` 与 `turnStartedAt`；只有上一轮已经完成时，才用 native timestamp 调 `checkpointRun(start)` 创建新 turn。测试覆盖了终端直接输入产生新 user row + `task_started` 后恢复为新轮次。
- Claude：`native-event` 经 `taskCheckpointProcess` 到 Runtime 后，先持久化 event document/head，再同步触发 observer；`native-ready` 与 `native-append` 只写状态/日志，本身不触发 observer。transcript/recovery 路径可以把已识别用户请求转换为同一 native start 语义。
- MCP：Prompt 要求 Agent 在处理前调用 `solomap_conversation_status({action:"start"})`。实际调用到达是 Agent 内信号。初次 prepare 虽提前 Running，但没有 `checkpointEventId=:start`，所以首次 MCP start 仍进入普通 checkpoint 分支，并在 Git HEAD 与 workspace snapshot 之后递增事件；Host 续轮会在发送前先 checkpoint start，随后 MCP start 才会命中幂等快路径而不写独立调用事件。
- `turnStartedAt`、`checkpointEventId=:start` 和 `Running` 同时承载 Host 预登记、prepare 投影与部分真实 Agent start，不能单独作为权威门禁收据。可复用的强来源是带 Provider 原始时间和身份的 native start，以及修复后专门持久化的 MCP 调用到达 receipt。
- Codex 常规发现依赖 `RunRecovery` 的 5 秒 poll，并先等待 input materialization、再与其他 run 串行；MCP start 依赖模型遵循提示；Claude 即时事件只覆盖具备对应 native contract 的会话。三条路径都没有保存入口 `interactionId/acceptedAt`，也没有产生统一 5/10 秒 verdict。

### 完全缺失

- `onDidOpenTerminal`、`onDidChangeActiveTerminal` 与 show 后活动终端复核。
- main thread 接受 create/show/send 的时间。
- terminal instance / panel reveal / active terminal 变化的时间。
- pty host 收到 create、调用 node-pty、fork 完成和 processReady IPC 的时间。
- 从每个生产者动作的不可重置 `interactionId/acceptedAt` 到 Provider native start / 实际 MCP start 调用 receipt 的统一关联、逐段延迟和发布 verdict。
- 对 7 类 Provider 官方生命周期/持久机器状态的即时 adapter 关联；独立进程树只验证 executable 身份，terminal bridge 只负责输入 transport，二者都不能回退充当 task-start。
- `processId` 等待的 terminal close/cancel 结算。
- reservation 的创建、消费、丢弃、陈旧和跨动作复用事件。
- UI 输入的 accepted/delivered/failed 三态；当前 Solo/Flow/步骤输入 post 后立即清空。
- Roadmap、Sidebar 非白名单动作、Telegram、智能内核、定时器、复核/维护和 recovery 与同一不可重置入口时间的贯通。
- runner 的 Git/snapshot/数据库准备和每一次 preflight 的独立阶段类型；当前通用 `agent.spawn/launch` 不能区分 preflight 与正式任务。

### 诊断持久化自身的限制

- `trace.record` 的数据库 append 是 fire-and-forget，事件保留自己的 `occurredAt`，但落库顺序可能与发生顺序交错。
- Extension 内存只保留最近 200 个 operation；数据库读取默认只取最近 250 个。在 0.0.621 的恢复风暴中，很容易把最初触发事件挤出用户可见诊断。
- 诊断与正式 run log 共用当前高负载 Runtime/SQLite，因此故障最严重时诊断持久化本身也会受同一资源压力影响。

## 11. 已确认的不变量与审计后修复契约

本节记录由事故现场审计确认的完整目标契约。第 14 节明确本轮已经落地和真实验收的主线子集；尚未列为已落地的条款仍是后续实现门禁，不能由设计文本冒充现状。

1. 用户动作必须始终绑定接受时的项目、数据根、Agent CLI 和模型；不得因等待期间切换项目或设置而漂移。定时任务在 occurrence claim 时固定这些身份；需要用户确认的维护动作在最终确认被接受时固定。
2. 每次用户发送只能拥有一个目标终端；UI 上显示哪个终端与命令实际投给哪个终端必须分别可证。
3. 若仍向普通终端 Shell 投递文本，正式命令不得在该 PTY 未就绪时发送；但真实 runner/Agent CLI 启动不能继续依赖这个无界 Shell PID 门闩，等待辅助终端也不能让用户输入无收据地消失或永久 pending。
4. 宿主变慢不得触发自动创建第二个终端；0.0.621 的 timeout/retry 行为不得恢复。
5. 用户关闭/停止必须能终止尚未完成的终端等待和 delivery lease，不能留下永不清除的 Promise。
6. 每个预创建 reservation 必须有且只有一个结局：被同一次动作消费，或由同一次动作释放；不能留给后一次动作碰巧消费。
7. 对话主路径不得被 growth capture、全库维护、诊断持久化或其他后台写入拖过 10 秒发布硬上限；5 秒仍是正常目标，5—10 秒必须记录为体验退化。隔离方式需由后续实现设计决定，不能在审计阶段预设。
8. focus、PTY、command、runner、preflight、包装器与真实 Agent CLI task-start 必须用各自真实事件确认，不能再用同步 API 返回、Host 预登记 checkpoint、`Running` 投影、包装器/CLI spawn、进程树、terminal bridge、普通输出或 fd 启动门伪造成功。task-start 只接受 7 类 Provider adapter 的官方生命周期/持久机器状态；MCP start 必须先新增独立实际调用 receipt，但只作补充。
9. “用户对话最高优先级”必须落实为可验证的运行时调度契约：前台请求到达后，所有可延后的后台数据库写入、衍生计算和诊断必须让行；不能继续依赖操作系统在平权进程和不可抢占同步事务之间碰巧及时调度。
10. 发布硬门禁：所有插件可触发的对话入口都必须在真实宿主、后台负载存在时，从生产者动作被接收时建立并贯穿同一 `interactionId`，到对应 Provider adapter 从官方生命周期/持久机器状态确认本次 user message 进入 run/turn，不超过 10 秒；正常目标仍为 5 秒，5—10 秒必须记录为体验退化。任一入口超限即整版失败，重置起点、超时中止、提前报错、只出现终端、进程树、terminal bridge、普通输出、runner/包装器/CLI 启动或 fd 启动门放行都不算达标。
11. 已有原生 CLI 的 Continue Turn 和终端直接输入不以新进程 spawn 或 bridge 投递为终点；插件 UI Continue 在 Host 接受动作时建立 pending，bridge 只传输输入；终端直接输入则由 Provider 官方 submit-accepted 候选建立 pending，bridge 原始按键不具备 TUI 语义。两者都必须由绑定 Provider adapter 的更后官方机器状态确认本轮进入 task。`sendText()`、PTY write、Enter 和 bridge 返回都不算收据。
12. 任何 single-flight、项目动作队列、进程 cleanup、成长汇报动作去重、terminal input queue、recovery poll 或 effect poll 都必须继承原动作起点并避免队头阻塞；同一 run 去重不能变成同 data root 其他前台对话的全局串行门。
13. Telegram `/run` 必须在消息接收时固定目标项目并只在获得权威 task-start 后确认启动；`/stop` 必须使用项目、run、generation 和 delivery 身份停止真实任务与未完成启动，不能靠终端标题前缀猜测。
14. 智能内核同一 launch reservation 同时最多一个 live dispatch；`acknowledged`、命令提交、`deliveryPending=false` 或账本 `Running` 都不能回复 `started`，只有绑定同一 launch interaction 的真实 task-start 才能确认。
15. Roadmap 路线图调整等本地入口必须由 sender 显式携带 `projectPath`；Host 不得用接收时的活动/选中项目补全。全局提示词复盘必须进入同一 delivery lease，不得与 recovery 并行争抢 pending run。
16. 所有 terminal binding、复用、关闭、续轮、cleanup、停止、恢复和 task-start receipt 都必须使用完整身份 `(data root, normalized project path, run id, execution id, generation, delivery/turn-attempt id, turn id, interaction id)`；不允许任何控制面只用其前缀或数字 conversation id。切换数据根后不得用当前设置去控制旧根会话，也不得复用旧根 flight。
17. 身份必须两阶段原子升级：run 创建前使用 `(data root, normalized project path, interactionId, launchIntentId/turnAttemptId)`，prepare 成功时补齐完整 run 身份；pending 和迟到结果必须至少按 interactionId 隔离，不能再用 `(projectPath, conversationId)` 释放状态。
18. 所有 prepare 调用都必须进入统一 ownership guard；创建 run 后到 runner claim 移交前的任一失败、终端关闭或取消必须释放 delivery lease，release 失败持久重试，不能让 live owner 永久遮蔽 recovery。
19. scheduled occurrence 在首次 due claim 时写不可变 `acceptedAt/budgetOriginAt/interactionId` 和完整配置快照；reclaim 复用，不能用 `updated_at` 或新 claim 时间重置。Telegram 以 durable inbox accept 为 acceptedAt，并在该时刻固定项目/data root/config。
20. 自动 effect 在可执行时建立父 `eligibleAt/parentInteractionId/budgetOriginAt`；claim 冻结完整配置。retry/custom prompt 使用确定性子 interaction、各自 acceptedAt，但硬门禁继承父 eligibleAt 且并行独立启动，不能由前一个阻塞或由 reclaim 重置。
21. 全局提示词复盘必须使用实际 workspaceRoot，并进入和普通任务相同的 delivery lease、完整身份、受控 runner 与真实 task-start 门禁。
22. `formal` 受控子树只用于排除 preflight 和 wrapper，不能自行生成 task-start 收据。Codex `task_started`、Claude 根 `turn.start`、Cursor 在全部 submit hooks 放行后持久化的 generation user row、Copilot 同一 Session/root agent 且位于提交前 offset 之后的匹配 `user.message` 与同 `interactionId` 的 `assistant.turn_start`（user event 含 `turnId` 时还必须相等，中间允许 system/hook events）、OpenCode 在提交前 message/event 基线之后 ID 未见且完整 text 摘要匹配当前 attempt 的同 Session user message + 随后 busy、Grok 原生 `turn_started → waiting_for_model/loop_started`、Antigravity pending 建立后首个同 conversation/workspace/transcript 身份的 `PreInvocation`（不假设 `invocationNum`）等不可再被 prompt hook 否决的 Provider 机器状态，才可按完整身份原子认领唯一 pending turn attempt。Cursor `beforeSubmitPrompt`、Copilot `userPromptSubmitted/userPromptTransformed` 与 Grok `UserPromptSubmit` 单独都只是候选关联点；阻断、直接响应或 hook 后崩溃不得产生 receipt。任意 stdout/stderr、键盘回显、spinner、历史 replay、控制帧、进程存活和 wrapper/CLI banner 都不算。所有已验证支持 Provider 必须具备不依赖模型调用工具的 adapter；MCP 只做幂等补充。10 秒后的迟到收据只能认领旧 attempt，MCP receipt 仍必须先于 Git/snapshot/checkpoint 持久化，幂等快路径也不能跳过。
23. 10 秒只产生发布失败 verdict，不负责清槽。旧 attempt 必须由同 Provider 身份/提交 fence 后的官方负终态、用户停止或终端退出结束；无终态时旧 terminal binding 继续隔离，新的插件入口创建新 binding，不能靠提示符、输出或时间推断 idle。每类 Provider 的具体负终态与乱序/历史事件拒绝测试以终端设计为准。
24. 自动复核当前只读命令只覆盖 Codex、Antigravity、Cursor、Claude 与 Grok。Copilot/OpenCode 在补齐并真实验证只读 argv/权限沙箱前，必须在设置保存、effect claim 与手动动作接受前拒绝作为 reviewer；reviewer 留空时也不能从这两个主 CLI 隐式继承。不得先创建 run，再由 runner 的空命令失败。
25. 主 Agent `cliPath` 当前允许任意字符串，但统一门禁只能覆盖具备正式 adapter 的七类 Provider。修复后未知自定义 executable 必须在设置保存和动作接受前拒绝，不能保留为可触发但不参加验收的兼容入口。
26. 跨 Extension Host/Runtime 重载的 10 秒预算必须保存 wall、boot identity、boot uptime/monotonic sample 和只增不减的 `elapsedFloorMs`；同 boot 续计 uptime，跨 boot 使用非负 wall delta，wall 回拨或连续性不可验证时产生 `clock_untrusted` 发布失败，任何新进程都不能重置预算。
27. OpenCode 1.19.2 的插件投递合同固定为 `loopback serve -> POST/GET session -> 首轮 run --attach --session --dir --interactive -> 同 Session 强收据 -> exec attach -> 现存 attach PTY 输入续轮 -> 同 Session 强收据`。隔离真实探针证明首轮可在预建 Session 完成并留在原生 TUI，随后同一 PTY 输入桥提交的第二条提示在同一 Session 产生第二组 user/assistant message，user text 与实际写入内容逐字及 SHA-256 相等，过程中 attach 持续存活且没有第二个 `run`；也证明 attach 后过早调用 `/tui/append-prompt` 和 `/tui/submit-prompt` 会在接口返回 `true` 时静默丢失消息。因此插件续轮必须复用现存 attach binding，TUI 控制接口、第二个续轮 run、固定等待和接口布尔返回值都不得作为正式路径或 ready/task-start 收据。每个插件 attempt 还必须保存提交前 message/event 基线和实际写入内容摘要；并发用户输入摘要不匹配时不得认领插件 pending。

## 12. 审计闭合状态

- 用户与自动入口：生产者集合、当前生产 sender 与兼容 handler、入口特有的首个异步边界及现有信号语义已识别；运行观测尚未实现。
- 项目与设置捕获：Telegram `/run`、Roadmap 路线图调整、scheduled occurrence 与 effect claim 后重读 settings，以及 stop 时重读当前 data root 都存在确定缺陷；其余已审入口闭合，缺陷进入修复契约。
- 终端 reservation、正式创建与投递：已闭合。
- 状态写入、lease、runner claim、runner preflight、Host/MCP/native start 的不同语义已闭合审计；已确认 prepare 写 owner 后失败不释放的通用失联窗口，缺失的是实现 ownership guard、专用 receipt 并贯通 interaction。
- 恢复、重试、关闭、停止和排队：已闭合审计，并标出 prepare owner 失联、delivery/global prompt 竞争、input materialization、scheduled batch、intelligence dispatch、原生 observer 队头阻塞及 Telegram `/stop` 缺口。
- 多项目/多数据根选择：当前初次投递没有“任选活动终端”证据；但 Telegram `/run`、Roadmap 路线图调整、scheduled settings 重读和 stop/continuation 身份缺 data root 均是独立缺陷。
- 版本回归：已闭合；0.0.621 为放大回归，0.0.622 仅撤销放大机制。
- 无版本更新的状态触发：资源与数据增长证据已闭合到系统层；VS Code 内部精确排队子阶段仍是明确 evidence gap。
- 观测能力：审计已闭合；列出了会产生假阳性或无法定位的当前空白，包括入口 interaction 到现有真实 task-start 的关联、preflight/正式任务区分与非白名单入口。
- OpenCode 身份与投递：已用本机 1.19.2、隔离 XDG/配置目录、loopback 临时端口和空工作区关闭接口组合风险；指定 Session 的首轮、完成后原生 attach、现存 attach PTY 上的第二轮及同 Session 消息摘要均已实证，存在丢消息竞态的 TUI 控制路径和续轮第二个 run 已明确否决。

审计完成后，才允许基于第 11 节契约设计测试和最小修复；任何新 Terminal/Pty Host trace 若推翻上述边界，必须冻结实现并更新本审计。

## 13. 审计后主线修复与真实验收

### 13.1 已落地

- 所有进入共享 `launchAgentConversationTerminal` 的正式 Agent 新任务，统一改为 `Custom Pseudoterminal + ForegroundAgentTerminalBridge`。Extension Host 直接以 `spawn(process.execPath, [runAgentProcess.js, ...])` 启动唯一 runner，`shell=false`，不再等待普通集成终端的 `processId`，也不再通过 Shell `sendText()` 启动正式任务。
- 终端先创建并显示；PTY surface 的打开、焦点和渲染只影响显示，不再成为 runner 启动门。早到输出在 bridge 内有界缓存，输入按字节帧串行送给 runner。显式 trash/关闭终端会停止该 run；Extension Host deactivate 只断开显示，不主动发送停止。
- 正式 delivery 只尝试一次；runner claim watchdog 与 task-ingress 门禁分开。调用方不能在 spawn、command submitted 或 runner claim 后伪造“Agent 已启动”。到 10 秒仍未观察到收据时先写入 `taskIngressVerdict=deadline_exceeded|clock_untrusted`；若唯一正式 runner 已提交且仍受控，不把 observer 迟到转换成用户可见的“暂时无法回答”，也不释放 lease、不关闭终端、不创建第二个任务。后到收据以 Provider 原始开始时间重新裁决：真实 `<10s` 清除观察超时，真实 `>=10s` 仍是版本失败。
- 交互式 runner 在正式 CLI 前建立可撤回边界：Git 使用独立临时 index，先以 HEAD 初始化 tracked 集合，再用单次 `add -A` 扫描工作树并执行 `write-tree`，因此“已跟踪但后来被 ignore”的文件也不会丢失。内容变化时用确定性的 `commit-tree` 生成隐藏提交，内容未变时直接复用 HEAD；两者都必须先通过 `update-ref --no-deref` 写入 `refs/solomap/backups/<hash>` 持久保留。全过程不移动 HEAD、不污染用户暂存区；相同 HEAD 与相同工作树复用同一提交和 ref。已有 `baseGitHash` 也必须重新验证 commit 并补齐受控 ref，不能绕过硬门。快照失败时不得启动 Agent；次级工作区元数据 baseline 在快照成功后开始，并与原生 CLI 初始化重叠，不能反过来把辅助 I/O 串行压在用户对话前。
- runner 自己持有 Agent stdin。Extension Host 输入 EOF 不再关闭 Agent stdin；stdout/stderr 先进入权威 run log，可选显示通道断开或背压不能阻止生命周期收口。
- 用户入口创建不可重置 `interactionBudget`，并随 run 状态持久化 wall、boot identity、uptime 与单调 `elapsedFloorMs`。Codex/Claude native start 生成 `provider_native` 收据；从正在执行本轮任务的 Agent loop 发起、经 run proof/session/generation/turn 核对的真实 MCP start 生成 `agent_acknowledged` 收据。原生收据可升级同 interaction 的较弱收据，反向覆盖禁止。verdict 使用 Provider 原始开始时间，observer 轮询延迟独立保存为 `observerDelayMs`，不能把晚发现误判为晚启动。
- Runtime data socket 增加三级 admission scheduler：run prepare/claim/state/checkpoint/stop 等前台控制优先于普通读取，run log、diagnostic、growth 与 capture 等可延后写入最后准入。已经开始的同步 SQLite 事务仍不可抢占，因此该调度只声明真实边界，不冒充数据库级抢占。
- Codex 交互任务在启动前把精确 Git 根写入 Codex base config 的 `projects.<path>.trust_level=\"trusted\"`。写入保留无关 TOML 字节和注释，支持 base config symlink、CAS 冲突重试与最终 TOML 解析；不再使用 Codex 明确忽略的 runtime/profile `-c` 覆盖。共享 daemon 曾在真实跨项目场景产生约 26.681 秒队头等待，已否决；随后尝试的每 run 独立 app-server 又因 TUI 仍冷启动完整插件/MCP 而未达标，不能把 socket ready 当成任务 ready。
- 侧边栏“继续”不再只执行 `codex resume` 打开空闲 TUI；它创建正式 continuation turn，把多行提示和唯一 Enter 作为一个原子 frame 写入 live bridge，并等待写入结算及新 task-ingress 收据。broken pipe 会直接形成可定位失败；不能以复用 Session、PTY write 或窗口出现冒充新一轮成功。
- Host 预登记续轮先为本轮生成同样的独立 Git 快照，再使用 `foregroundStart` 轻量 checkpoint 提交 turn、interaction、用户消息和权威 `baseGitHash`；输入写入前不执行项目投影、侧边栏刷新等非必要 I/O，也不重复遍历工作区。Agent 每轮收到精确 `turnId + interactionId`，MCP `start` 必须同时匹配当前 run-scoped session、generation、turn 和 interaction，旧轮迟到调用不能确认新轮。
- Host reload 后只按终端名找到、但没有当前 Host live bridge 的旧 TUI 不再复用。续聊会启动新的正式 resume runner，避免把输入送进其他项目或失去管道的旧终端；跨 Host UI 重新附着旧 pipes 仍不在本版能力声明内。
- 可复用终端必须同时匹配数据根、规范化项目路径、execution、run、generation/delivery 和当前 Host 的 live bridge；仅标题相同或数据库里仍保存 terminalName 均不足以取得输入控制权。路线图调整 sender 与 Telegram `/run` 也显式携带用户动作发生时的项目，Host 不再用稍后变化的活动项目补全。
- 现场 CPU profile 最终把“版本未变但使用数日后突然恶化”闭合到原生日志恢复的增长型写放大：`RunNativeObserver` 对同一 Codex 增量区间读取两遍，并逐 JSONL 行提交 `codexNativeCursor`。真实 2 MB native log 已把单 run revision 推到 602，旧 Runtime 主线程持续占用约 70%—77% CPU。修复后同一增量只读取一遍、按 1 MiB 分页，并在整批处理完成后只提交一次 cursor；任务语义事件仍逐条处理，不牺牲原生 turn 身份和结算正确性。
- task-ingress 的 10 秒边界只记录 `deadline_exceeded|clock_untrusted`，不再释放已经提交的 delivery、关闭唯一 runner 或触发第二次投递；deadline 状态改为等待持久化完成并在 revision 冲突时重读重试，避免 UI 已报失败但审计账本没有 verdict。
- 已有 Agent 的插件续轮在 Git 快照和 checkpoint 后立即写入 bridge并等待本轮 task-ingress；项目 journal 读取、节点 Running 投影和侧边栏刷新移到收据之后，不再占用进入 Agent CLI 前的预算。交互式 runner 在 Git 快照成功后只 spawn 一次正式 CLI，workspace metadata baseline 与原生初始化重叠并在 runner 收口前完成；Claude/Copilot/Grok 的 `--help/--version` 能力探针不再作为每次用户任务的前置子进程。
- 全局提示词复盘修正为使用真实 workspaceRoot，并进入与普通任务相同的 delivery/runner 路径。仍需普通 Shell 的 GitHub 登录、CLI 检查和安装命令继续使用兼容就绪门，但不再与正式 Agent 启动共享门闩。

### 13.2 真实候选包证据

最终候选为 **0.0.625 / r13**。它在隔离 code-server、两个持续 CPU 负载和真实 Codex CLI 下，从持久化 `acceptedWallMs` 到 Codex rollout 的 `event_msg.task_started` 为 **7.569 秒**，通过 `<10s` 硬门；observer 在 Provider 已开始后 3.173 秒完成归档，该延迟没有被误报为用户启动失败。更早候选的 7.862 / 8.938 / 6.191 秒是历史新对话、续聊和 r12 证据，r6 的 13.398 秒是修复前失败证据，均不再冒充最终候选结果。

验收使用完整 VSIX 安装到隔离 code-server 用户目录，并在两个持续占满 CPU 的 Node 进程下执行；计时起点来自 run 中持久化的 `acceptedWallMs`，终点来自 Codex rollout 的 `event_msg.task_started` 原始时间，不采用终端显示、runner PID、CLI 进程或普通输出。

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| 全新工作区首次 Solo 对话 | 7.862 秒，`degraded`，未越过 10 秒 | 新 Session `01a174bc-7cf4-78a3-84f5-a50d884294c6`；native turn `01a174bc-8bbf-75b2-a95d-7f7165cbf1cb`；observer 晚 4.962 秒发现，但 verdict 使用 Provider 原始开始时间 |
| 同一原生 Session 的侧边栏“继续” | 8.938 秒，`degraded`，未越过 10 秒 | `agentLaunch.direct=false`；`previousNativeSessionId === nativeSessionId`；新 native turn `01a174cb-8d84-7180-bc1f-b4384ee29b7a`；observer delay 2.828 秒 |
| 用户显式关闭续聊终端 | runner、`script`、Node/Codex 子进程全部退出，run 结算为 `Processed` | execution 3 最终 exit/sessionExitCode 143；已有 `candidate_complete` checkpoint 和上述 task-ingress receipt 未丢失 |
| 最终 r13 全新工作区 Solo 对话 | **7.569 秒，通过 10 秒门禁** | 0.0.625 VSIX；两个 CPU burner；真实 Codex/MCP 往返完成并返回 `REAL_CODEX_GATE_OK`；observer delay 3.173 秒 |
| Git 可撤回边界 | 通过 | dirty 工作树生成隐藏提交 `64963bfb762c0e80a8998913d6a4ec1787efd2c9`；受控 ref 可解析；HEAD 与用户文件保持不变；MCP start 未再覆盖该 hash |
| 项目配置隔离 | 通过 | 本次数据根使用 `solomap-66a1f900eeff883c` profile；没有复用其他项目最后写入的共享 `solomap` profile |
| 正式升级重载 | 0.0.625 候选接管 0.0.624 Runtime 后正常运行 | 新 PID 3884064；control endpoint 指向 0.0.625 build `478320a9fe985551aca581ca52e368d93dae9420f8b0db21daab2546f94eeb17`，状态 `running`、health `ok`；旧 PID 3700738 已退出 |
| 完整回归 | 2679 项，2678 通过、0 失败、1 跳过 | 661.762 秒自然退出；webview 压力单跑另为 563/563 |

最终 0.0.625/r13 候选包为 6335 个文件，压缩 11.48 MiB、解压 38.78 MiB；包内结构审计通过。实现提交 `f4128e8` 后，既有发布工作流已通过自动发布提交 `13db58d` 将同一源码发布为 0.0.625，CI `40272156144` 与 Publish `40272156120` 成功，Open VSX 可用性回读通过。其他 Provider 仍没有被 Codex 实测外推为账号级真实通过。

### 13.3 当前明确边界

- 0.0.627 基线上的修复把显示所有权从 Extension Host 直接管道扩展为 runner 内的认证 loopback 重连端点。Host reload 后由现有 5 秒恢复轮询接管 owner，先从数据库回放最近 1 MiB 权威输出，再按 offset 接入同一 runner 的有界实时流；不会启动新的 Agent，也不会走 `processId`/`sendText()` 或原生 resume。端点同时校验 run/generation/delivery/PID/nonce，跨项目同名终端不能认领。非交互任务不创建端点。
- 修复之前已经启动的交互 runner 没有端点，不能在不替换进程的前提下热补。实现明确保持这些任务运行，不自动停止、不补发提示词；它们在下一次用户正常续聊创建新 runner 后自然使用新协议。跨 Host 恢复结论只适用于安装该修复后创建的交互会话。
- Runtime scheduler 能优先准入尚未开始的操作，不能抢占已经进入同步 SQLite 的大事务。最终 r13 在本机隔离宿主和两个 CPU 负载下通过 Codex 新对话门禁；这证明本次候选和该压力模型达标，不能外推成所有数据库规模、硬件和 Provider 账号上的绝对实时保证。
- `taskIngressReceipt` 的 `provider_native` 强收据当前由 Codex/Claude observer 提供；其他已支持 CLI 当前依赖绑定本次任务的 `agent_acknowledged` 收据。逐 Provider 官方事件适配属于后续增强，不能把本轮 Codex 数字外推为其真实账号验收结果；OpenCode serve/attach 也没有冒充本版已实现能力。
- 原生 TUI 内由用户直接键入的消息尚没有由插件创建的可信 `acceptedAt/interactionId`，因此不纳入“插件动作接收后 10 秒”计时承诺；插件 UI 发起的首轮、继续、路线图调整、步骤和受治理远程入口都必须使用同一门禁。该边界不能用 bridge 的原始按键或 Enter 推断消除。

## 14. 主要证据索引

- Webview 发送与即时清空：`src/sidebarWebview.ts:10088`、`src/sidebarWebview.ts:10442`、`src/sidebarWebview.ts:12446`。
- Webview Host trace：`src/sidebarProvider.ts:12`、`src/sidebarProvider.ts:548`。
- Roadmap Webview 共享入口：`src/extension.ts:4917`。
- Roadmap 路线图调整 sender 缺失项目与 Host fallback：`src/roadmapWebview.ts:4882`、`src/extension.ts:1805`。
- Sidebar 卡片类 Agent 生产者：`src/sidebarWebview.ts:12011` 附近的交付、安全、PR、能力和 Issue 动作。
- Telegram `/run`：`src/telegramService.ts:574`。
- 智能内核 `start_conversation` reservation/editor bridge：`src/runtimeDataOperations.ts:1075`。
- 智能内核 launch reservation、dispatch owner 与死亡恢复：`src/conversationTracking.ts:29`、`:46`、`:69`、`:85`。
- 智能内核重复 dispatch 与早期 started 投影：`src/conversationTracking.ts:33`、`:58`、`:136`，`src/runtimeDataOperations.ts:1089`。
- Telegram `/run`、`/stop` 与 Host 命令：`src/telegramService.ts:574`、`:589`，`src/extension.ts:966`、`:1015`。
- 全局提示词复盘直投终端：`src/extension.ts:6280`、`src/extension.ts:6327`、`src/extension.ts:6347`。
- 全局提示词复盘与 delivery recovery 竞争边界：`src/extension.ts:6327`、`:6342`、`:11180`，`src/runAgentProcess.ts:78`、`src/db/unifiedDataStore.ts:6555`。
- 已有原生会话续轮直投：`src/extension.ts:8372`、`src/extension.ts:8413`。
- 项目成长汇报继续及动作去重：`src/extension.ts:5032`、`src/extension.ts:5056`、`src/extension.ts:5101`、`src/extension.ts:5113`。
- 项目动作、续聊与进程 cleanup single-flight：`src/extension.ts:653`、`src/extension.ts:654`、`src/extension.ts:1312`、`src/extension.ts:7753`。
- 终端 binding / continuation key 缺 data root 与 stop 重读设置：`src/extension.ts:631`、`:7623`、`:2003`、`:7180`、`:8648`。
- 非对话终端维护入口：`src/sidebarProvider.ts:1138`、`src/sidebarProvider.ts:1142`、`src/sidebarProvider.ts:1146`、`src/sidebarProvider.ts:1151`。
- 自动 retry/custom prompt：`src/extension.ts:9790`、`src/extension.ts:9837`。
- 项目/设置快照：`src/extension.ts:1357`、`src/extension.ts:1369`、`src/extension.ts:8672`。
- 预创建、reservation、focus：`src/extension.ts:7296`、`src/extension.ts:7353`、`src/extension.ts:7364`。
- delivery、lease、processId、runner watchdog：`src/extension.ts:7413`。
- 终端关闭：`src/extension.ts:897`、`src/extension.ts:7819`。
- delivery recovery：`src/extension.ts:11180`。
- recovery/status/effect 串行队列：`src/extension.ts:11180`、`src/extension.ts:11137`。
- 原生状态恢复与 observer 串行边界：`src/runRecovery.ts:17`、`:21`、`:31`，`src/runNativeObserver.ts:13`、`:42`。
- recovery 前置 input materialization：`src/runRecovery.ts:21`、`:23`。
- scheduled batch claim 与逐项串行：`src/extension.ts:9670`、`:9674`、`:9677`。
- scheduled claim 后重读 settings/项目/CLI：`src/extension.ts:9671`、`:9694`、`:9722`、`:9744`，`src/pluginContracts.ts:60`。
- effect consumer 前置 owner/list/claim/apply 与 engine 查询：`src/extension.ts:11137`、`:10901`。
- effect claim 后设置漂移：`src/extension.ts:11143`、`:10923`、`:9829`、`:10963`、`:11048`。
- maintenance 前置 store/registry/capability 与迁移确认：`src/extension.ts:8158`、`:8187`、`:8236`，`src/migrationSettingsActions.ts:11`。
- Codex/Claude `task_started` 转换：`src/runNativeObserver.ts:228`、`:328`、`:410`、`:443`。
- MCP/native event 入口与 checkpoint 入账：`src/unifiedMcp.ts:358`、`src/runtimeDataOperations.ts:570`、`:958`、`src/taskCheckpointProcess.ts:24`、`src/db/unifiedDataStore.ts:5241`、`:5445`。
- 共享就绪门：`src/terminalCompatibility.ts:27`、`src/terminalCompatibility.ts:38`、`src/terminalCompatibility.ts:75`。
- Runtime 无优先级 socket dispatch：`src/autonomousRuntimeControl.ts:145`、`src/autonomousRuntimeControl.ts:221`。
- Runtime 同步 store 路由：`src/runtimeDataOperations.ts:55`、`src/runtimeDataOperations.ts:635`、`src/runtimeDataOperations.ts:666`。
- 高频 run-log 同步事务：`src/db/unifiedDataStore.ts:6682`。
- growth snapshot 大事务：`src/db/unifiedDataStore.ts:6945`。
- runner 包装器 spawn 与 fd 3 启动门：`src/runAgentProcess.ts:248`、`src/runAgentProcess.ts:284`。
- runner Git/snapshot/数据库与 Provider preflight：`src/runAgentProcess.ts:313`、`:327`、`:332`、`:345`、`:352`，`src/agentRunPreflight.ts:34`、`:59`、`:74`。
- VS Code Terminal API 的 `processId`、`sendText(): void`、`show(): void`：`node_modules/@types/vscode/index.d.ts:7684`、`:7733`、`:7740`。
- 产品体验基线：`docs/ui/local-first-loading-interaction-baseline.zh.md:51`、`:125`、`:278`、`:408`。
- 现场诊断：`/home/ubuntu/project/.solomap-global/solomap.db` 的 `diagnostic_events`，trace `71e9dc9cdae5ec69`；0.0.621 回归窗口为 2026-10-25 14:06—14:18 UTC。
- 宿主：code-server `4.131.0` / Code `1.131.0`；当前 Extension Host PID 2742433、Runtime PID 2742590、file watcher PID 2742349、pty host PID 651。
