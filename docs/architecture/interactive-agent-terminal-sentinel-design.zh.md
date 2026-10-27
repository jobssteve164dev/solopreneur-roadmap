# 交互式任务终端与任务哨兵解耦设计

> 决策更新（2026-10-17）：Solo、路线图环节对话和续聊统一使用 Agent CLI 原生交互终端，并通过 `solomap_conversation_status` MCP 工具上报每轮结果。下文的 `SOLOMAP_TASK_COMMAND`、自建 Chat UI 与 ACP 方案只作为已退役或已否决的历史调研保留，不再是 Agent 正式入口。
>
> 身份绑定更新（2026-09-01）：各 Agent CLI 首次交互如何取得可验证的会话 ID，以[交互式 Agent 会话身份稳定绑定设计](./interactive-agent-session-identity-design.zh.md)为准；本文件继续负责终端、轮次和任务检查点边界。

## 文档状态

- 状态：原生交互终端 + Agent 检查点账本首版已落地。
- 当前覆盖：Codex、Cursor Agent、Antigravity CLI、Claude Code、GitHub Copilot CLI 和 OpenCode 的用户主动对话入口。
- 当前运行边界：用户对话使用原生交互终端；Flow、复核、定时任务、时间计划、自动重试和其他无人值守任务继续使用非交互命令。
- 当前结论：不增加自建 Chat UI 或 ACP 运行时依赖；任务轮次结算依赖显式检查点，不依赖进程退出、终端空闲或输出文案匹配。

> 2026-10-25 落地状态：正式 Agent 新任务已统一由受控 runner 直接启动，并通过 Custom Pseudoterminal 显示和转发输入；启动不再等待普通 VS Code Terminal `processId`。Codex/Claude native start 与实际 MCP start 已写入 interaction-bound `taskIngressReceipt`。当前 bridge 使用 Extension Host 到 runner 的直接 pipes，尚未实现跨 Extension Host 的显示重连；下文的本地 IPC endpoint/nonce/re-attach 是后续耐久化目标，不得当作已实现事实。

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

- 用户主动发起的首次任务由数据库 launch plan 经 `buildDatabaseAgentCommand` 最终构造原生交互命令；后台 Flow、复核和维护任务仍可构造非交互命令（`src/agentRunPreparation.ts`、`src/agentDatabaseLaunch.ts`、`src/agentCli.ts`）。
- 当前实现不再在项目内生成 `.solopreneur/runtime/task-checkpoint.cjs`；该文件只属于 legacy migration。run、turn、binding、prompt、日志和 checkpoint 都写入统一数据库（`src/legacyProjectFileMigration.ts`、`src/agentRunPreparation.ts`、`src/db/unifiedDataStore.ts`）。
- runner 通过环境变量暴露扩展内的 `taskCheckpointProcess.js` 给 Claude native hook 等受控入口；普通 Agent 对话的显式状态协议是数据库 MCP `solomap_conversation_status(start|complete)`，不要求 Agent 执行项目内检查点脚本（`src/runAgentProcess.ts`、`src/taskCheckpointProcess.ts`、`src/unifiedMcp.ts`）。
- Codex transcript 的 `task_started/task_complete/turn_aborted`、Claude native event/transcript 和 MCP checkpoint 进入同一数据库状态管线；start 建立/更新轮次，complete 进入结算，交互 Session 可在本轮完成后继续存活（`src/runNativeObserver.ts`、`src/runtimeDataOperations.ts`、`src/db/unifiedDataStore.ts`）。
- 侧边栏通过统一投影把已结算但终端仍存在的会话显示为可继续，不要求数据库记录长期保持 `Running`（`src/conversationPresentation.ts`）。

### Inference

现有任务哨兵已经不只依赖进程退出：native observer 与 MCP checkpoint 可以在交互式 TUI 仍存活时建立和结算轮次。事故版本 0.0.622 的对话唤起耦合发生在更早的启动链：正式 runner 仍通过普通集成终端 Shell 的 `processId` + `sendText` 才能启动，而且入口计时没有贯穿到已有真实 task-start 收据。2026-10-25 修复已经移除这条正式任务门闩；完整前后证据见现场审计第 14 节。

### 对话唤起观测与恢复契约

对话唤起不能再用单个 `delivery` 耗时代表整条链路。下列是事故版本 0.0.622 的实际事件链：

```text
delivery.claim
  → delivery.focus
  → delivery.identity.persist
  → delivery.process.wait
  → delivery.process.slow（仅在超过 5 秒时记录，不中断）
  → delivery.command.send
  → delivery.submission.persist
  → delivery.runner.start
  → delivery.runner.claim
  → Git/工作区基线与 Agent 数据库准备
  → Provider preflight（部分 Provider；只产生 preflight.spawn/launch/first-output）
  → 正式任务 agent.spawn（只标识 formal wrapper spawn）
  → 正式任务 agent.launch（仍是 wrapper gate release）
  → Provider adapter 从官方生命周期/持久机器状态确认 task ingress
  → Agent 实际调用 MCP conversation_status(start) 时幂等补记辅助 receipt
```

现有数据库能保存 Codex/Claude native start 的 Provider 身份与原始时间，但 Host 也会在发送前 checkpoint start，prepare 更会提前把 run 投影成 Running；因此普通 `turnStartedAt`、`checkpointEventId=:start` 和 `Running` 不是 task-start 收据。MCP start 若命中 Host 已登记状态会直接返回，当前不会保存独立调用到达记录。修复复用 native 强信号，并把入口创建的 `interactionId` 贯穿 Webview、Host、terminal delivery、runner 与 Provider 收据；诊断事件同时绑定创建 trace 时的数据根，避免切换项目后串写。仍不能另造平行任务真相，也不能沿用混合语义字段。

- `process.wait` 只表示 VS Code PTY 已返回可用 Shell PID；终端对象已创建或已经显示不算就绪。
- `focus` 必须选择本次请求对应的终端标签，不能用 `show(true)` 保留另一项目的活动终端。code-server 可能延迟创建未选中终端的 PTY，因此“面板已经打开”不能代替“目标终端已经选中”。
- `command.send` 只表示正式命令已交给已就绪 Shell；它不等于 runner 已启动。
- `runner.claim` 是 `runAgentProcess` 已启动并成功认领运行的权威信号。只有从这里开始，运行才不再属于“待投递”。
- `agent.spawn` 只表示 formal `execute()` 已创建 `script`/Shell 包装进程并持久化其 PID；`agent.launch` 只表示 formal 执行的 fd 3 启动门已放行。preflight 虽复用 `execute()`，但必须显式传入 `executionKind=preflight` 并只写 `preflight.*`，不得污染 `agent.*`。两类事件都不是 task-start。
- 新 CLI 的 `agent-cli.task-start` 与已有 CLI 的 `agent-cli.turn-start` 都必须来自下文 7 类 Provider adapter 的官方生命周期/持久机器状态；独立进程树只证明 formal CLI 身份，terminal bridge 只负责输入 transport，二者都永远不能生成 task receipt。Host 预登记 checkpoint 与 MCP 自报也不算主收据。Provider adapter 收据分别是对应入口 5/10 秒计时的唯一完成事件。
- 阶段事件只保存 trace、阶段、耗时、受控进程字段、不可逆的项目/终端标识和分类错误，不保存用户输入、命令正文、路径或凭据。`focus` 同时记录请求项目、目标终端、原活动终端、是否要求选中以及终端归属是否匹配，使“显示了错误项目终端”和“正确终端 PTY 未启动”可以直接区分。

terminal binding、复用、关闭、续轮、cleanup、停止、恢复和 task-start receipt 必须共同使用完整身份 `(规范化 data root, 规范化项目路径, runId, executionLogId, generation, deliveryId/turnAttemptId, turnId, interactionId)`；任何控制逻辑都不得只使用该身份的前缀或数字 conversation ID。切换 data root 后同一项目可能产生相同数字 ID，也只能操作发起动作固定的数据根和整组持久身份。

身份采用一次动作内不可分叉的两阶段升级，而不是要求 run 创建前凭空存在 runId：

- 生产者接受动作时先持久化启动身份 `(dataRoot, normalizedProjectPath, interactionId, launchIntentId/turnAttemptId)`，其中 `interactionId`、`acceptedAt` 和时钟锚点此后不可覆盖。时钟锚点不是单独的 `Date.now()`：同一宿主进程使用 `performance.now()`；持久记录同时保存 `acceptedWallMs`、当前系统 boot identity、boot uptime/monotonic sample 与 `elapsedFloorMs`。每次跨进程阶段先把已消耗时长单调并入 `elapsedFloorMs`。
- `prepare_run` 成功创建 run 时，在同一幂等动作下原子补齐为 `(dataRoot, normalizedProjectPath, runId, executionLogId, generation, deliveryId/turnAttemptId, turnId, interactionId)`。任何恢复、重试或重载只能读取并升级原身份，不能生成新 interaction 或重置预算。重载后若 boot identity 未变，使用 boot uptime 差与 `elapsedFloorMs` 的较大值继续计时；boot 已变化时使用非负 wall delta 并保留 floor；若 wall 回拨、boot identity/uptime 不可验证或出现相互矛盾的样本，直接产生 `clock_untrusted` 发布失败，绝不能给新进程一份新的 10 秒预算。
- Webview pending、成功/失败确认和迟到回包至少携带 `interactionId`；只有完整身份与当前 pending interaction 同时匹配，才允许释放或覆盖状态。旧动作的迟到结果不能解除新动作的 pending。

同一身份规则也适用于前台动作状态和异步刷新：

- “正在续聊”和动作完成确认使用上述完整身份；UI 在 run 尚未创建时使用其前置启动身份。`(projectPath, conversationId)` 只能用于只读展示索引，不能继承或释放 pending，也不能控制进程、终端、续轮或恢复。
- 终端等待期间即使用户切换项目，命令投递后的历史刷新仍写回发起动作的项目；不得读取或刷新切换后的活动项目。
- 所有对话历史刷新都必须显式携带发起项目，禁止在异步完成时回退到当时的 `activeProjectRoot`；新对话、续聊、重试、停止、关联步骤和结算副作用遵守同一规则。
- 项目卡片继续、命令面板发起、消息续聊和时间计划同样属于对话入口：在第一次异步等待前捕获项目路径；终端显示后只能用该路径创建独立执行目标，不能再调用“切换到请求项目”来夺回用户后来选择的项目。
- Webview 的每一个对话生产或控制入口都必须随动作发送当时可见的 `projectPath`，包括步骤运行、Flow 发起/暂停/放弃、关联步骤和项目卡片继续；Host 不得用收到消息时的全局选中项目补全缺失身份。
- 当前 Roadmap 的路线图调整 sender 未发送 `projectPath`，Host 会回退活动/选中项目；这是待修复的确定缺陷，不得把其他入口已固定项目外推到该入口。
- Telegram、定时任务和其他远程/自动生产者同样必须在动作被接受时持久化目标项目；当前 Telegram `/run` 只传 `nodeId`、Host 事后读取活动项目的行为必须移除，未取得真实 task-start 不能回复“已启动”。Telegram `/stop` 必须按持久项目/run/generation/delivery 身份取消，不能按终端标题前缀猜测。
- scheduled occurrence 在首次 due claim 时必须原子写入不可变的 `acceptedAt/budgetOriginAt/interactionId` 以及项目、data root、CLI、模型、权限和 prompt policy 快照；reclaim 复用同一记录，不得以 `updated_at`、claim 时间或恢复时间代替 acceptedAt。当前逐项执行时重读 settings 的行为必须移除，且同批前一个 occurrence 不能阻塞后一个跨过 10 秒。
- 发起动作按项目路径分别排队，不使用跨项目全局队列。排队结束后若用户已经切换项目，只允许原项目动作继续后台执行，不允许旧动作把界面导航回原项目。
- 独立执行目标同时固定项目数据引擎、数据根和 Agent 设置。项目与设置快照必须在启动终端的第一个 `await` 前同步捕获；运行时准备、CLI/模型解析、进程清理、终端复用和后续刷新都读取这份快照，不能在任一 `await` 之后重新读取当前项目设置。
- OpenCode 等需要供应方凭据的终端环境也属于 Agent 设置快照：最终命令投递必须用发起时捕获的供应方和密钥选择，Flow 恢复必须优先使用持久动作携带的数据根，不能因当前选中项目变化改写目标根。
- 后台项目可以更新自己的数据库、缓存和侧边栏卡片；只有发起项目仍是当前项目时，才允许刷新路线图主视图。后台项目完成不能借一次无条件 `sendNodesToWebview` 重建用户正在操作的另一个项目。
- 非当前项目的快照、动作成功确认或失败结果可以更新该项目缓存和动作账本，但不能触发当前项目 DOM 重建或显示成当前项目错误；只有路径与 generation 同时匹配的结果才能提交当前界面。
- 原生续聊在项目准备完成后持有独立的项目执行目标；用户随后切换项目只能改变可见界面，不能取消原续聊、关闭其数据引擎或把它重新绑定到新项目。
- Continue Turn 复用已存在的原生 CLI 时，不以新进程 spawn 为完成；terminal bridge 只负责把本轮输入和 run/turn 身份送到已绑定 CLI，随后仍由对应 Provider adapter 的官方机器状态确认本轮进入 task。`sendText()`、PTY write 和 bridge 自身返回都不算 5/10 秒终点。
- 用户在 SoloMap 创建并维持的原生 Agent 终端中直接提交下一轮输入，同样是正式对话入口，但 Custom Pseudoterminal 的 `handleInput` 只传输原始按键，不能把 Enter 猜成对话提交。该入口的动作接受点由 Provider adapter 的官方 submit-accepted 候选确定：Codex/Antigravity 使用绑定 transcript 的新 user message；Claude 使用当前 observer 已接入的根 `session.append(door=prompt, message.type=user, !isMeta)` 及其 user UUID；Cursor 使用 `beforeSubmitPrompt` 候选（只定起点，全部 hooks 后的持久 user row 才是强终点）；Copilot 使用 `userPromptSubmitted` 候选；OpenCode 使用同 Session 的 user `message.updated`，随后仍须等 `session.status=busy`；Grok 使用 `UserPromptSubmit` 候选，随后仍须等持久 user row 与原生 phase。adapter 在候选到达的首段以 Provider 原始时间和当前宿主接收时间建立不可重置 interaction/turn 身份；随后只有更后的 task-ingress 强事件能回传 `agent-cli.turn-start`。从 Provider 接受提交到强收据正常目标 5 秒、硬上限 10 秒。此前原始按键仍记录为无语义 input hint，用来诊断 CLI 接受前延迟，但不创建 attempt；普通键盘回显、PTY write、换行、空 Enter、审批/提问回答、slash command、本地命令、bridge 输出或进程状态都不算对话接受或完成。
- 项目动作队列、同对话 single-flight、进程 cleanup、成长汇报动作去重、terminal input queue、delivery recovery 与 run-effect consumer 都必须保留原始动作起点；去重只合并同一逻辑动作，不能让一个未就绪终端或未完成 cleanup 成为同 data root 其他前台对话的队头阻塞。
- `RunRecovery` 的 5 秒整轮 single-flight 在观察任何 run 前还先等待全局 input materialization，随后才逐 run 调用 `RunNativeObserver`；observer 自身又 per-run 串行。它们属于 task-start 收据链的一部分，必须被前台新收据唤醒或让行，不能让输入物化、恢复分页、workspace snapshot 或其他 run 把本轮收据推迟到 10 秒之后。
- 智能内核同一 launch reservation 同时最多一个 live dispatch；当前重复 reserve 会新增 dispatch，且 acknowledged/命令提交/`deliveryPending=false` 就可返回 `started`，必须改为绑定 task-start receipt 后才确认。
- `prepare_run` 本身会在创建 run 时写入 live delivery owner，随后 binding、policy、prompt 和状态 patch 的任一步失败都可能在调用方取得 prepared result 前抛出；普通首发路径和全局提示词复盘都可能因此留下 recovery 持续排除的 pending run。所有 prepare 调用必须执行统一的 ownership guard：创建/取得 run 后，只有成功移交给已认领 runner 才 commit owner；任一失败、终端关闭、显示接入失败或取消都按完整身份释放 lease。释放暂时失败进入持久幂等重试，不能只依赖调用栈 finally 或内存 timer。
- 全局提示词复盘当前绕过显式 delivery claim 直接投递，但 prepare owner 存活时 recovery 会排除该 run；真实风险是活 owner 卡死时 recovery 永久压住，以及 owner 死亡后旧 Shell/命令迟到并与恢复投递竞争。它还把已解析的 `workspaceRoot` 丢掉，调用 `createAgentTerminal(context.extensionPath, ...)`，导致终端 cwd 和 ownership key 错绑到扩展安装目录。它必须使用目标 workspaceRoot，并进入与普通路径相同的 delivery identity/lease/ownership guard，确保一个终端、一次命令、一个 runner owner。
- 自动 effect 在持久化为可执行时建立不可变的父 `eligibleAt/parentInteractionId/budgetOriginAt`；claim 原子固定项目、data root、规则、CLI、模型、权限和 prompt policy。每个 retry/custom prompt 使用确定性的 childInteractionId，保留各自 acceptedAt 供追踪，但硬门禁共同继承父 effect 的 `budgetOriginAt=eligibleAt`，不能因派生、排队、claim 或 reclaim 重置。两个子动作独立启动、独立结算，前一个不得阻塞后一个。当前 claim 后重读 automation settings、`taskPermissionMode` 和 `globalPrompt` 的行为必须移除。

恢复规则：

- 普通终端 Shell/PTY 只能是显示与原生输入输出表面，不能再充当 runner/Agent CLI 启动门。新任务必须通过不依赖普通 Shell `processId` 的受控进程路径启动；目标终端仍应立即显示，并在自身就绪后接入同一个 runner，而不是创建第二份任务。
- 当前最小桥接实现使用 VS Code Custom Pseudoterminal：Extension 先以 `child_process.spawn(process.execPath, [runAgentProcess.js, ...])`、`shell=false` 和 `ELECTRON_RUN_AS_NODE=1` 直接启动唯一 runner；这一步不等待 `Pseudoterminal.open`、普通 Terminal `processId` 或焦点完成。Extension 与 runner 通过直接 stdin/stdout/stderr pipes 传输输入和显示输出；正式输出同时先写权威 run log。用户 trash/dispose 这个终端实例或点击显式“停止”才发起 stop；隐藏 panel 不停止任务。runner 退出只结束本轮并写入结束提示，不关闭 terminal surface；surface 由用户明确关闭。
- 已注册项目的前台入口先从宿主现有注册快照同步固定项目与设置；只有快照确实缺失时才刷新注册表。Custom PTY 的创建、展示和启动预留不等待重复的 Agent CLI 环境解析，正式 runner 仍在唯一启动路径中按同一快照解析完整环境并接管已展示 surface。
- Extension Host deactivate 只断开交互展示订阅，不主动 stop runner；交互 runner 自己持有 Agent stdin，Host pipe EOF 不会被转译为 Agent EOF。非交互任务遵守相反且明确的所有权：Agent fd 0 从启动起立即 EOF，不创建重连 listener。每个新交互 runner 在 `127.0.0.1` 随机端口提供本机 IPC，端点同时绑定 run、generation、delivery、runner PID/birth 和 256-bit attach nonce；任何字段缺失或不符都在输入抵达 Agent 前拒绝。新 Host 先通过数据库 owner CAS 取得显示所有权，再回放权威 `output` 日志最近 1 MiB，并从持久 offset 接入 runner 的 4 MiB 有界实时缓冲；attached/replay/ready 严格有序，回放缺口会重新读取数据库而不是静默丢字节。输入只有在 Agent stdin 写回调成功后才 ACK，同一 request ID 在 runner 生命周期内有界去重；异常断线立即取消 live 状态，下一轮恢复复用原 terminal surface。未认证连接还有 1 MiB 单帧上限、5 秒认证时限和连接数上限。重连只重建 terminal surface，不 spawn runner、不 resume Provider、不提交提示词。旧版本已经启动且没有端点的 runner 不做有损热迁移，保持运行并在下一次正常原生续聊后进入新协议。
- runner 内部可以继续用 `script` 为配置的 CLI 提供 TTY，但 `script` 是 runner 的唯一正式子树且不得充当 task-start 收据。正式执行和 `--help`、`--version`、`create-chat` preflight 必须传入明确 `executionKind=formal|preflight`；只有 formal 子树可产生 task ingress receipt。
- 如果兼容路径仍需向普通 Shell 发送文本，该文本必须等待真实 PTY PID，且不得以超时后重建终端的方式恢复；但这段等待不能阻塞真实 Agent CLI 在 10 秒硬上限内进入本次任务。
- 用户关闭或停止必须同时终止未完成的显示接入、runner 和 delivery lease；扩展宿主重载时，已启动 runner 依靠持久 run 身份恢复，不能因显示终端重建而重复启动 Agent。
- runner 受控启动后若在认领预算内仍未出现，记录 `runner_claim_timeout`，校验 run、generation 和 delivery ID 后释放投递租约并关闭失效显示。迟到的旧进程因 delivery ID 不匹配不能认领运行，避免重复执行。
- 释放租约若恰逢 Runtime 切换或短暂断连，按同一 generation、owner、delivery ID 和幂等键后台重试；活着的 Extension Host 不得因为一次释放 RPC 失败而永久挡住持久投递队列。
- 准备提示不再作为一条 Shell 命令排在正式命令之前；终端可见性由 `show` 保证，runner 只允许按持久 delivery 身份启动一次，显示接入不能生成第二份命令或第二个 Agent。

上述预算只界定一次基础设施尝试，不缩短 Agent 任务执行时间，也不把慢任务改成提前失败。

### task ingress 收据与测试 oracle

正式子进程被创建只能形成 `formal_process_spawned` 诊断事件，不能结束 5/10 秒计时。当前实现只接受两级收据：

| authority | 当前来源 | 发布含义 |
| --- | --- | --- |
| `provider_native` | Codex 已绑定 rollout 的 `event_msg.task_started`；Claude observer plugin 的根 `turn.start` | Provider 自身已进入本轮任务，是最高权威 |
| `agent_acknowledged` | Cursor、Copilot、OpenCode、Grok、Antigravity 或原生 observer 暂不可用时，正在执行本轮任务的 Agent loop 调用受治理 `solomap_conversation_status(start)` | Agent 已进入工具可用的本轮执行循环；Runtime 必须核对 run proof、session binding、generation、turn 与 interaction |

`provider_native` 可以升级同一 interaction 先到的 `agent_acknowledged`；`agent_acknowledged` 不能覆盖已经存在的原生收据。普通 stdout/stderr、ANSI 重绘、spinner、键盘回显、历史 replay、进程存活、wrapper/CLI 启动 banner、模型普通文本、Host 预登记 checkpoint、`Running` 状态、runner spawn、PTY write 和 `sendText()` 均不是收据。

Runtime 在治理型 MCP 调用到达的第一段轻量事务中先核对提示中精确的 `turnId + interactionId`，再保存收据；旧轮迟到调用不得认领当前轮。Host 的前台续轮 checkpoint 不读取 Git HEAD 或 workspace snapshot，完成阶段再收集这些证据；幂等 fast path 也不能跳过收据。该调用不是 Shell 自报，也不是由提示文本直接宣称成功，而是从已开始执行的 Agent 工具循环经 run-scoped MCP 通道返回的受控状态。它仍弱于 Provider 原生事件，因此保留明确的 authority 排序，便于后续原生 adapter 无缝升级。

接受对话的调用方必须等待与本次 interaction 匹配的收据后才能返回“已启动”。到 10 秒仍无收据时，调用方持久化 `deadline_exceeded` 或 `clock_untrusted` 并返回失败；门禁失败不杀死已经在运行的 Agent、不吞掉输入，也不启动第二份 CLI。10 秒后才发生的 acknowledgement 只保留诊断价值；只有带可信 Provider 原始时间、并证明任务实际在门禁前开始的原生事件，才可纠正观察器晚到造成的判定。

页面动作、Extension Host、Pseudoterminal bridge、runner 与 Provider observer 必须携带同一 `interactionId`；`traceId` 只标识一次局部 trace，不能冒充用户 interaction。至少持久化 terminal claim/focus、runner spawn/claim、Agent spawn/first-output、Provider task-ingress 及其耗时，保证一次慢唤起可以直接定位到唯一阶段。宿主等待持久收据只记录为 `terminal.delivery.task.ingress.observation`；Provider 原生事件或严格绑定的 MCP start 才记录权威 `terminal.delivery.task.ingress`。如果 observation 先超时、后到 Provider 事件的原始开始时间仍小于 10 秒，权威事件必须用同一 trace 写 `ok` 并标记已调和观察超时，不能让“观察迟到”继续伪装成“任务未启动”。Provider receipt 与诊断事件即使分两步落库，也必须允许从已持久化 receipt 幂等补记诊断，不能因首次 append 失败永久丢失权威阶段。trace 在创建时绑定其 diagnostic sink；创建时没有 sink 也必须显式绑定为 no-sink，不能让另一个窗口或数据根后来配置的 sink 接管迟到事件。

后台恢复属于低优先级修复面。某个 run revision 的恢复若失败，Runtime 把失败阶段、尝试次数、下次时间和对应 revision 持久化到同一 run，并按 30 秒起步、最长 5 分钟退避；若 observer 在失败前已推进同一 run/generation/turn，退避必须基于重读后的最新 revision 写入。相同 revision 的 5 秒 tick 与 Runtime 重启都不得重复扫描大 transcript、workspace 或 Git。外部 revision 变化立即让旧退避失效，确保新事实不会被旧失败延迟；实现不得依赖会泄漏或在进程重启后丢失的内存 Map。

“Continue Turn”和成长汇报中携带用户新要求的“继续”先创建新 turn，再把多行提示与唯一提交键组成一个原子 PTY frame；写入 Promise 必须真实结算，broken pipe 直接失败。frame 写入不是收据，调用方仍等待同一 interaction 的新 task-ingress。

对话卡片上的“续聊/继续”按钮是另一种动作：它只重新进入已确认的 Provider 原生 session，使用不含 `PROMPT` 位置参数的 resume 命令，不提交“继续当前 Agent 对话”、SoloMap wrapper 或任何其他合成消息，也不制造一个必然无法到来的新 task-ingress 等待。Host 可预建待填写的账本 turn，但必须显式标记为等待原生输入；用户在重入后真正提交新文本时，observer 把原文写回这个 turn，随后由 Provider 原生 start/complete 形成收据和结算，不能留下空 turn 或“等待本轮用户消息”合成正文。

Host reload 后不能按名字复用旧终端：恢复必须同时核对数据根、规范化项目、execution、run、generation、delivery、runner PID/birth、loopback endpoint 和 nonce，并先完成 owner 接管。验证通过后，新 surface 连接同一 runner；验证失败只记录 `terminal.reconnect.claim/connect` 故障并等待下一次恢复，不启动第二个 Agent。没有重连端点的历史 runner 不冒充可恢复，也不自动停止或重启。

当前 OpenCode 仍使用标准受控 CLI runner 和 `agent_acknowledged` 收据。`opencode serve`、`run --attach`、`exec attach`、Server 事件订阅与跨 Host 可重附着属于后续原生 adapter 设计，尚未在本版实现或作为发布结论。其他非 Codex/Claude Provider 的 transcript/hook 原生事件接入同样是后续增强；本版不得把这些目标状态写成已落地事实。

测试必须至少覆盖：无收据到 10 秒时调用失败并持久化门禁结果；MCP 收据与 interaction/run 身份不匹配时不能通过；后到原生收据可升级、反向不能降级；spawn、普通输出和 PTY write 不能通过；续轮 broken pipe 失败；多行输入只有一个提交键；Codex daemon 错误也只启动一份正式 CLI；Host reload 不复用无 live bridge 的同名终端；重连前后 runner PID 不变、输入可用、脱离期间输出只回放一次、错误 nonce 被拒绝、有界缓冲缺口可检测。真实 Provider 账号验收只能报告实际可用并完成测试的 Provider，不能用 mock 或另一家 Provider 外推。

计时测试还必须覆盖 Extension Host reload、Runtime restart、同 boot 续计、跨 boot 恢复、wall clock 前跳/回拨。`elapsedFloorMs` 只增不减，同 boot 不以新进程时钟重置；无法验证时钟连续性时失败关闭，正常 Agent 任务本身仍继续运行。

自动复核是独立入口，但只读能力必须在动作接受前成立。当前生产命令只支持 Codex、Antigravity、Cursor、Claude 与 Grok；Copilot/OpenCode 在补齐并真实验证只读 argv/权限沙箱前，不得被设置为 reviewer。支持的 reviewer 一旦动作被接受，同样必须在 10 秒门禁前取得上述两级收据之一。

### 本地优先的运行资源边界

用户主动对话是最高优先级控制面，不只是调用图中的主路径。终端 create/show、PTY 就绪、run 登记、继续和停止不得与成长快照、后台智能循环、迁移、维护、诊断或外部刷新在同一无优先级队列中平权竞争。

- 共享 Runtime 或数据库必须能识别前台对话控制请求，并让可延后的后台工作在请求到达时让行。
- 同步 SQLite 大事务、持续 run-log 写入和批量衍生数据写入不得形成不可抢占区间，阻塞对话控制面超过本地体验基线。
- Runtime、Extension Host、terminal service 与 pty host 之间的资源竞争必须在后台满载的真实宿主环境验证；空载单元测试不构成优先级证明。
- 诊断属于辅助链路。慢路径产生的诊断写入不得继续放大被诊断的 I/O 竞争。
- 2026-10-25 的完整现场审计见 [SoloMap 对话终端发起链路完整审计](../ui/conversation-terminal-launch-audit-2026-10-25.zh.md)。事故版本 0.0.622 尚未实现上述资源优先级；修复版已经增加前台 run 控制优先于 log/diagnostic/growth/capture 的 admission scheduler，并完成满载 Codex 首轮与续轮验收。已经开始的同步 SQLite 事务仍不可抢占，因此本节的数据库级隔离仍是约束，不能由 admission 排序冒充全部完成。
- 正常目标仍为 5 秒；超过 5 秒但不超过 10 秒必须记录为体验退化，从入口动作接收到本次 Agent CLI 任务真实启动的发布硬上限为 10 秒。该上限覆盖所有插件可触发入口和后台满载宿主，不能用终端已创建、`show()`/`sendText()` 已返回、runner 已登记、`script`/Shell 包装层已启动、fd 启动门已放行或 10 秒时主动失败代替真实 Agent CLI 已进入任务。

### 已落地的检查点协议

Agent 每轮从插件提示词获得数据库 MCP 状态入口：

```text
solomap_conversation_status({action:"start", turnId:"本轮标识", interactionId:"本次交互标识", message:"当前要求"})
solomap_conversation_status({action:"complete", message:"当前要求", outcome:"...", summary:"...", next:"..."})
```

其中 `complete` 的结果只允许：`partial`、`candidate_complete`、`blocked_user`、`blocked_external`、`failed`。`candidate_complete` 只提交路线图完成候选，不能绕过完成标准或副 Agent 复核。Agent 不能直接编辑状态文件、完成文件或 SQLite 账本。

Codex 和 Claude 的 native observer 为同一账本提供独立恢复信号；Claude native hook 可调用扩展内 `taskCheckpointProcess.js` 传输 native event，但这不是面向 Agent 的项目脚本协议。用户通过 “Continue Turn” 明确提交新要求时，Host 会先创建活动轮次；这只能表示输入已被插件接受，不表示 Agent 已接收。对话卡片的 resume-only“续聊”则只预建 `Waiting` turn，直到 observer 看到真实原生 user message 才切换 `Running` 并建立该次提交的新 interaction。随后 native start 在当前 turn 写入 Provider-native 身份、原始时间和 `taskIngressReceipt`，或在上一 turn 已结束时补建新 turn；实际 MCP `start` 到达也会在幂等快路径之前补写同 interaction receipt。若只有 `complete` 到达，状态消费者不能覆盖上一条记录。`checkpointEventId` 继续保护账本顺序，但不得兼任 task-start 真收据；`Waiting` 必须先于对话历史刷新落盘。

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

交互式对话不接入、探测或回退到 ACP，也不修改用户全局 Hook。插件使用各 Provider 已公开的原生交互启动参数，并用自己的检查点命令取得 Provider 无关的轮次完成信号。

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

## 历史调研与验证记录（2026-07-29，已被后续决策取代）

> 本节只保留当时的研究证据，不再定义现行运行时。2026-08-30 已决定用户主动对话统一使用 Agent CLI 原生交互终端；2026-09-01 起，首次会话身份按[交互式 Agent 会话身份稳定绑定设计](./interactive-agent-session-identity-design.zh.md)处理。ACP 已被明确禁止，不能作为主路径、备选、兼容或未来评估项；下文关于“原生 TUI 不进入运行时”“只能使用 ACP 自建终端”或“remote TUI 未授权”的判断均已失效，不得作为实施依据。

### Codex ACP 自建对话终端（未实施）

#### 为什么采用 ACP，而不是直接复刻 app-server 适配器

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

#### 对话终端的界面边界

- 使用 VS Code Webview 承载终端式对话，不用 PTY/xterm 模拟聊天协议。PTY 继续只服务真实 Shell 终端。
- 主动作始终是输入下一条要求；状态只显示“正在执行 / 需要你确认 / 需要你回答 / 等待你继续 / 已停止 / 出错”。
- Agent 文本流式追加；工具执行默认折叠为单行进度，审批、问题选项和文件变化使用可操作卡片。
- 不展示 ACP、JSON-RPC、app-server、adapter、turnId 等内部术语。
- 同一个主对话只有一个对话终端；侧边栏“打开终端”只 reveal 既有界面，不创建第二个 Session。

### Kanna 的借鉴边界

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

### 原生 TUI 备选支线的信号设计

#### Hook 信号

- `SessionStart`：绑定 SoloMap run 与根 Codex Session。
- `UserPromptSubmit`：建立新轮次并标记执行中。
- `Stop`：表示根 Agent 当前轮次准备结束。

Hook 只写入生命周期事件，不负责路线图状态、数据库结算、Git 操作或 UI 刷新。所有副作用继续由插件宿主在 lease 保护下执行。

上述三个 Hook 已验证能够覆盖正常多轮会话，但不能单独覆盖用户中断。`Stop` 只代表正常结束路径；用户按 Esc 中断时，不能等待一个不会到达的 `Stop`。

#### 恢复信号

Codex rollout 中以下事件用于恢复和交叉校验：

- `task_started`
- `task_complete`
- `turn_aborted`
- `error`

在 Hook 已获得可信授权的前提下，Hook 是低延迟信号，rollout 是强制恢复信号；终端关闭、进程退出和心跳是异常兜底。不得解析 ANSI 输出、提示符或自然语言文案判断完成状态。

`turn_aborted` 不是可选交叉校验。当前 Codex 在用户中断时会写入它，但不会触发 `Stop`，所以任何正式适配器都必须消费 rollout，或使用另一个经过同等验证的中断事件源。

#### 根会话过滤

Codex 根 Agent 与子 Agent 可能都触发生命周期 Hook。SoloMap 必须记录第一个与当前 run 绑定的根 Session ID，后续只接受该 Session 的轮次完成事件；其他 Session 只能作为子任务证据，不得结算主轮次。

### 事件存储

现有单个状态快照继续用于侧边栏快速读取，但不能承担多轮事件队列职责。

新增 append-only 生命周期事件日志，要求：

- 每条事件一行 JSON。
- 包含唯一事件键和单调序号。
- 写入使用追加或原子替换，不依赖轮询恰好观察中间状态。
- 插件处理成功后记录消费游标。
- VS Code 重载后可以从游标继续。
- 跨窗口仍通过现有 lease 保证只有一个实例执行结算副作用。

原始终端录制只作为本地诊断材料。对话展示的权威内容仍是用户输入、Agent 最终回复、文件变化摘要和明确错误，不直接展示 reasoning 或完整工具输出。

### Hook 配置所有权

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

#### `notify + rollout` 不构成等价替代

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

### 终端与侧边栏行为

- 当前轮执行中：显示“正在执行”，主动作是“打开终端”。
- 等待审批或回答：显示“需要你确认”，主动作是“打开终端”。
- 当前轮完成且终端仍在：显示“等待你继续”，主动作是“打开终端”。
- 终端关闭且 Session 可恢复：显示“继续”。
- Agent 进程自然退出只结束本轮，不关闭 PTY surface；终端保留最终输出和结束提示，只有用户明确关闭终端才销毁该 surface。
- 关闭对话终端视图：只隐藏界面，不停止活动轮次，也不关闭可恢复 Session。
- 用户点击“停止”：向当前 Session 发送取消；收到 `cancelled` 后把当前轮记为已停止。
- Adapter 进程在执行中异常退出：当前轮记为异常中断，保留 Session 身份用于恢复。

终端内后续输入自动成为同一主对话下的新轮次，不创建新的顶层 Solo 对话。

### 失败与降级

- ACP bridge 启动失败或能力探测不通过：不创建交互 Session，不显示伪造的“正在执行”；保留现有非交互兼容入口并给出恢复动作。
- Adapter 在活动轮次中退出：先将当前轮标为异常中断，再以已持久化的 `sessionId` 尝试 `session/load`；不得自动重发用户 Prompt，避免重复副作用。
- Webview 重建：从持久快照恢复完整对话，再从事件游标接续增量；UI 重建不得创建第二个 Session。
- 原生 TUI 备选支线若未来启用：Hook 漏发时使用 rollout 恢复；Hook 与 rollout 冲突时优先采用带同一 Session/Turn 身份的持久完成或中断事件。
- Provider 不具备可验证的轮次信号：继续使用现有非交互兼容模式，不以终端空闲或文本匹配伪造精确监控。
- 等待用户确认时停止普通失联计时，避免把人工等待判为 supervisor 丢失。

### 分阶段实施

#### 阶段 A1：原生 TUI + Hook 可行性验证

- 验证 Codex 当前版本支持运行级 Hook 配置。
- 验证 `SessionStart`、`UserPromptSubmit`、`Stop` 的载荷字段和触发顺序。
- 验证同一交互终端中的第二轮继续触发完整生命周期。
- 验证 Hook 处理器可以静默、快速、无提示词落盘地写入隔离事件文件。
- 验证根 Agent 与子 Agent 的 Session 身份是否足以过滤。
- 验证退出、打断、限额或 Hook 漏发时的 rollout 恢复证据。

阶段 A1 通过前不得沿原生 TUI 路线修改运行时代码。

### 阶段 A1 验证记录（2026-07-29）

验证环境：Linux、Codex CLI `0.145.0`，本机 `hooks` 功能标记为 stable/enabled。验证使用仓库内的 `scripts/validate-codex-hook-event.cjs`，Hook 只向隔离 JSONL 写入事件名、Session/Turn 身份、字段名和时间，不保存提示词或 Agent 回复正文。

#### 已通过

- 运行级注入有效：通过 CLI `-c` 注入 `SessionStart`、`UserPromptSubmit`、`Stop`，没有改写 `~/.codex/config.toml`；验证前后该文件修改时间保持在测试开始之前。
- 正常首轮顺序成立：`SessionStart → UserPromptSubmit → Stop`。
- 同一 TUI 多轮成立：第二轮复用同一 `session_id`，产生新的 `turn_id`，并再次触发 `UserPromptSubmit → Stop`；首轮完成后终端保持可交互。
- 载荷身份足够：`SessionStart` 提供 `session_id` 和 `transcript_path`；`UserPromptSubmit`、`Stop` 同时提供 `session_id`、`turn_id` 和 `transcript_path`。
- 内容最小化成立：Provider 载荷虽然包含 `prompt`、`last_assistant_message`，探针没有写入这些正文，只记录字段名。
- 中断恢复证据成立：Esc 中断的轮次只触发 `UserPromptSubmit`，没有触发 `Stop`；同一 transcript 中出现同一 `turn_id` 的 `task_started → turn_aborted`，`reason` 为 `interrupted`。
- 验证终端均正常退出；测试启动的等待进程已停止，隔离事件文件和两份测试 rollout 已删除。

#### 未通过或尚未验证

- **Hook 信任体验未通过**：验证依赖 `--dangerously-bypass-hook-trust`，Codex 会在终端显示安全警告。OpenAI Codex 当前公开实现与 issue 记录表明，普通本地 wrapper 尚无受支持的程序化批准接口。
- 子 Agent 的 Hook 触发与根 Session 过滤尚未做真实验证。
- 限额、Provider 错误、Hook 处理器失败和进程崩溃的恢复矩阵尚未逐项验证。
- 幂等消费与 VS Code 重载恢复属于 SoloMap 适配器行为，只能在阶段 B 代码存在后通过测试验证；不能用本次 Provider 探针替代。

#### `notify + rollout` 补充验证

同一环境下另行使用运行级 `notify` 配置验证，未加载 SoloMap Hook，也未使用 Hook 信任绕过参数：

- **正常多轮通过**：同一原生 TUI 连续两轮均收到 `agent-turn-complete`；`thread-id` 保持不变，`turn-id` 每轮不同，并与 rollout 的 `task_started → task_complete` 一致。
- **交互体验通过**：终端没有出现 Hook 信任警告，用户全局 Codex 配置未被改写。
- **已绑定后的中断恢复通过**：后续轮次按 Esc 中断时不触发 `notify`，rollout 记录同一 `turn-id` 的 `task_started → turn_aborted(interrupted)`。
- **首次中断绑定未通过**：新原生 TUI 在首轮开始后立即中断，rollout 在约 150ms 内记录 `task_started → turn_aborted(interrupted)`，但没有 `notify`；SoloMap 在此之前拿不到该 TUI 的根 `thread-id`。
- **空线程预创建未通过**：app-server `thread/start` 返回了线程 ID，但尚未开始 turn 时没有形成原生 TUI 可 `resume` 的持久会话。
- **MCP 身份桥未通过**：运行级 stdio MCP 启动时观测到的 `CODEX_THREAD_ID` 为空，不能在首轮前把根身份带回 SoloMap。

这组结果说明 `notify + rollout` 能降低 Hook 在正常完成路径上的依赖，但没有解决最关键的首次身份绑定，不能据此放行阶段 B。

#### A1 当时判定（已失效）

Hook 事件模型在技术上可行，正常多轮和中断恢复链已经得到真实证据；`notify + rollout` 的正常多轮与中断恢复也得到真实证据，但它无法在首次轮次结束前可靠绑定原生 TUI。由于“无需破坏用户信任边界且不污染首次交互体验”的接入条件仍未成立，阶段 A1 不通过，原生 TUI 不进入运行时实现。

原生 TUI 支线只可在以下任一条件经用户确认后重新开启：

1. Codex 提供并验证了受支持的 Hook 授权/安装接口；
2. 产品明确采用一次性用户授权流程，并验证授权后升级与路径变化不会反复打扰。

此前列出的第三条替代路径——由 SoloMap 承担终端式对话界面——已经收敛为下面的 ACP 支线，不再属于原生 TUI 的放行条件。

#### 阶段 A2：ACP 自建对话终端可行性验证

验证环境：Linux、Node.js `22.21.1`、Codex CLI `0.145.0`、`@agentclientprotocol/codex-acp@1.1.7`、ACP v1。验证使用仓库内 `scripts/validate-codex-acp-lifecycle.mjs`，通过 stdio 直接实现最小 ACP Client，不修改 `package.json`，不接入扩展运行时，也不保存提示词与 Agent 回复正文。

真实验证结果：

- **首轮前身份绑定通过**：`session/new` 在任何 `session/prompt` 之前返回稳定 `sessionId`。
- **正常多轮通过**：同一 Session 连续两轮均收到 Agent 消息更新，并以 `end_turn` 结束。
- **审批等待通过**：Read-only 模式的 Shell 请求触发 `session/request_permission`，请求携带同一 `sessionId`；选择 `allow_once` 后本轮正常完成。
- **用户输入等待通过**：通过 ACP 会话配置切换到 Plan 协作模式后，Codex `request_user_input` 转换为 `elicitation/create`；回答后本轮继续并完成。默认协作模式不开放该工具，因此运行时必须消费正式 elicitation，不能假设每种模式都会产生输入请求。
- **取消通过**：探针等待当前轮真实工具状态进入 `in_progress` 后发送 `session/cancel`，`session/prompt` 返回 `cancelled`，没有用进程退出冒充中断。
- **跨进程恢复通过**：关闭首个 Adapter 进程，启动新进程并对原 `sessionId` 调用 `session/load`，后续 Prompt 在同一 Session 正常完成。
- **隔离与清理通过**：验证工作区位于本次会话专用临时目录；脚本关闭 Adapter 后仅在目录为空时删除该目录，没有改写项目文件、Codex 全局配置或扩展运行时。

#### A2 当时判定（已失效）

ACP 路线满足首轮身份绑定、连续多轮、审批、用户回答、中断和恢复六项核心门禁，阶段 A2 通过。Codex 首版可进入阶段 B，但只能按“SoloMap 自建对话终端 + ACP bridge”实施；这不是对原生 TUI + Hook 支线的放行。

#### 当时规划的阶段 B：Codex 用户主动对话（未作为现行方案实施）

- 增加独立 ACP bridge、Codex 生命周期适配器和 append-only 事件日志。
- 首次任务由 SoloMap 创建 ACP Session，并立即打开同一个对话终端。
- 将结算从进程退出迁移到每轮结束。
- 实现审批卡片、用户输入卡片、停止和 `session/load` 恢复。
- 保留现有非交互后台任务路径。
- 更新侧边栏“打开终端 / 继续”动作。

#### 当时规划的阶段 C：其他 Provider（未作为现行方案实施）

- Claude Code：Stop / SessionEnd。
- Gemini 系：BeforeAgent / AfterAgent / SessionEnd。
- GitHub Copilot CLI：agentStop / sessionEnd。
- OpenCode：session.status / session.idle。
- 其他 Provider 只有在生命周期信号通过同等验证后才启用交互监控。

### 阶段 A1 原生 TUI 支线历史通过标准

- 不修改用户现有 Hook 文件也能为一次测试运行注入 Hook。
- 首轮触发顺序可观察为 SessionStart、UserPromptSubmit、Stop。
- 同一 TUI 内第二轮再次产生 UserPromptSubmit、Stop，且 Session ID 不变、Turn ID 可区分。
- Hook 载荷可以稳定提供根 Session 与轮次关联所需字段，或者有经过验证的 rollout 补充方式。
- Hook 输出不污染正常对话，不记录测试提示词正文。
- Hook 重复事件不会导致重复结算。
- Stop 漏发或异常退出存在可验证的恢复路径。
- 验证产生的临时会话、事件文件和终端均已明确清理或保留原因。

任一关键标准不通过时，不得沿原生 TUI 支线进入运行时实现；文档必须记录阻塞、证据和替代方案。

### 阶段 A2 ACP 支线历史通过标准

- Session ID 必须在首轮 Prompt 前获得并可立即持久化。
- 同一 Session 至少完成两轮，且每轮有独立的 SoloMap Turn 身份与停止原因。
- 审批和用户问题必须是带 Session 身份的结构化请求。
- 中断必须在当前轮真实开始后得到 `cancelled` 确认。
- Adapter 进程重启后必须能够加载原 Session 并继续对话。
- 验证不得修改扩展运行时代码、项目业务文件或用户全局 Agent 配置。

上述标准已由 2026-07-29 的隔离探针全部满足；它只说明当时 ACP 探针可行。后续产品决策已明确不以 ACP 自建终端替代用户主动对话的原生 TUI，因此“阶段 B 放行”不再有效。

## 运行时代码验收标准

- 首次任务直接进入交互终端。
- 不退出终端即可提交第二轮。
- 每轮完成后侧边栏及时进入“等待你继续”。
- 多轮均归属于同一个主对话并保留独立执行记录。
- 子 Agent 完成不会提前结算根 Agent。
- 隐藏 terminal panel 或关闭对话视图不停止活动轮次；点击显式“停止”或 trash/dispose 该对话终端实例才取消当前轮，Extension Host reload/deactivate 仅断开展示并随后重连。
- VS Code 重载后能恢复尚未结算的活动轮次。
- 两个窗口不会重复写入执行记录、自动化动作或完成副作用。
- Adapter 重启后能通过持久 Session 身份与事件游标恢复；若未来启用 Hook 支线，Hook 漏发时持久事件能够恢复。
- 用户已有 Hook、设置和授权完整保留。
- 普通 Stop 不会修改路线图环节完成状态。

## 当前未授权范围

- 本文档不修改路线图、环节状态或完成标准。
- 本轮设计与阶段 A 验证不修改 Agent 启动、哨兵、账本、数据库和侧边栏运行时代码。
- 不引入 tmux、后台驻留或关闭终端后继续执行。Codex 官方 Remote terminal UI 只在身份绑定设计规定的本机、实验能力探测与真实验收范围内使用，不等于远程暴露服务。
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
