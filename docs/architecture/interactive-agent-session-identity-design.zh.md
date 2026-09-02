# 交互式 Agent 会话身份稳定绑定设计

> 决策日期：2026-09-01
>
> 文档状态：实施基线；阶段一、阶段二运行时代码已落地，阶段三仍受真实 CLI 验收门槛约束
>
> 适用范围：SoloMap 中由用户主动发起或恢复的 Agent CLI 原生交互终端
>
> 关联文档：[交互式任务终端与任务哨兵解耦设计](./interactive-agent-terminal-sentinel-design.zh.md)

## 一句话决策

SoloMap 必须在首次交互开始时，将这一次运行与一个**唯一、可证明属于该运行的 Provider 会话 ID**绑定；优先使用各 CLI 官方提供的“调用方指定 ID”“先创建会话”或“官方回调”能力，只有原生 TUI 没有任何官方身份接口时才允许使用带强绑定证据的兼容关联，且绝不再把“同工作区最新会话”当作正确会话。

## 用户最终得到什么

用户从 Solo 或路线图环节打开 Agent CLI 后，可以一直在原生交互终端中对话。关闭窗口、重载 VS Code 或稍后点击“继续”时，SoloMap 恢复的是刚才那一段对话，而不是同目录下最近创建的另一段对话。

用户不需要：

- 查看、复制或选择会话 ID。
- 理解 transcript、hook、server、thread 或 Provider 缓存。
- 因不同 Agent CLI 使用不同的身份接口而学习不同的续聊操作。
- 在 SoloMap 无法证明会话归属时承担“试着恢复看看”的风险。

如果 SoloMap 无法唯一证明会话 ID，界面只说明当前对话暂时不能稳定继续，并保留原终端；系统不得偷偷复用旧 ID、猜测最新 ID，或把另一段对话接到当前任务。

## 设计边界

本设计只解决三个问题：

1. 首次启动原生交互式 Agent CLI 时，如何取得正确的会话 ID。
2. 如何证明该 ID 属于当前 SoloMap 运行，而不是同工作区中的并发或历史会话。
3. 如何持久化并用这个 ID 恢复同一段会话。

本设计不改变：

- 用户主动对话继续使用各 CLI 的原生交互终端。
- 当前的任务检查点、轮次结算、路线图完成判断与终端保留机制。
- Flow、定时任务、复核等无人值守路径继续使用非交互命令。
- 各 CLI 自己的登录、权限、模型选择和配置归属。

## 不可退让的不变量

1. **精确归属优先于“尽量可续聊”**：不能唯一证明时，状态必须是不可用或冲突，不能猜。
2. **会话 ID 必须在单次运行维度绑定**：项目、工作区、路线图节点或 CLI family 只能作为索引，不能作为身份依据。
3. **同一工作区允许并发**：A、B 两个交互终端同时启动时，任何一个都不能通过“最新记录”抢走另一个的 ID。
4. **启动与续聊使用同一 Provider 身份**：首次绑定为 Claude 会话时，不能由其他 Provider 或另一个可执行文件接管。
5. **用户输入不是内部 ID 载体**：不得要求用户粘贴 ID，也不得把实现字段暴露到普通界面。
6. **持久化顺序必须防错**：只在身份已确认后，才把 ID 提升为该环节可续聊会话；计划值和候选值不能覆盖已确认值。
7. **官方合同与兼容证据分层**：来自官方参数、创建接口或回调的 ID，与从 Provider 本地记录精确关联得到的 ID，必须记录不同的获取方式和可信级别。
8. **不接管用户全局配置**：需要 Hook 或状态回调时，只允许可审计的增量安装、作用域隔离和原配置保留；不能覆盖用户已有配置。
9. **能力探测优于名称猜测**：不同版本是否支持某个命令，运行时以实际帮助信息或无副作用探测为准，不仅靠静态版本号。
10. **不把失败变成串话**：身份获取失败只影响自动续聊，不得把错误会话当作降级结果。
11. **严禁 ACP**：交互式对话身份绑定不得引入、探测或回退到 ACP；官方参数、Provider 创建接口、官方回调和本文批准的精确兼容关联都失败时，结果只能是不可用，不能换协议绕过用户已确认的产品边界。

## 修复前实现事实与根因

### Observed in code

- 修复前，`src/agentCli.ts` 的 `buildInteractiveAgentCommandForPromptFile` 已为 Grok Build 生成新会话 UUID，但 Claude Code、GitHub Copilot CLI、Cursor、OpenCode、Antigravity 和 Codex 的首次原生 TUI 启动没有统一的稳定身份准备阶段。
- 同一文件中的续聊命令已经能为多数 Provider 接收明确的 session / chat / conversation ID。问题主要发生在**第一次对话如何得到正确 ID**，而不是续聊命令完全缺失。
- `src/extension.ts` 的 `buildSessionCaptureScript` 当前混合使用输出文本、最近 transcript、工作区缓存和通用 UUID 匹配。Antigravity 与 Codex 路径包含“最近记录”式推断，其他路径也缺少 Provider 级身份合同。
- 当前 `.solopreneur/step-sessions/<nodeId>.json` 更接近“环节到最近会话”的续聊索引，不能单独证明某个 ID 属于哪一次具体运行。
- 已有 Codex 真实终端模拟证明：同一次原生 TUI 的多轮记录具有稳定 ID；同工作区同时存在诱饵会话时，按工作区取最新记录会得到错误 ID，而按本次运行的唯一绑定标记、工作区和起始时间可以定位正确 ID。

### Inference

频繁回归的根因不是“各 CLI 都没有稳定 ID”，而是首次交互入口新增后，SoloMap 没有先建立统一的会话身份获取协议，就把多种临时捕获手段塞进启动后的扫描逻辑：

- 把 Provider 能正式指定的 ID，降级成启动后再猜。
- 把 Provider 能正式创建的会话，降级成枚举列表后找最新。
- 把工作区级缓存误当成运行级身份。
- 把 Codex 原生 TUI 的特殊限制扩散成所有 Provider 的通用方案。

因此修复方向不是继续增强一个“万能 UUID 抽取器”，而是按官方能力选择最强身份原语，并在内部收敛成同一个绑定结果。

## 官方能力矩阵与设计结论

| Agent CLI | 官方身份原语 | 原生交互终端是否可用 | SoloMap 设计方法 | 当前设计结论 |
| --- | --- | --- | --- | --- |
| Claude Code | `--session-id <uuid>` 指定新会话；`--resume <id>` 恢复；子进程可读 `CLAUDE_CODE_SESSION_ID` | 是 | 调用方预分配 | 代码已接入；真实 CLI 门槛待环境具备后补齐 |
| GitHub Copilot CLI | `--session-id <uuid>` 创建或恢复精确会话；`/session` 可显示当前 ID | 是 | 调用方预分配 | 代码已接入；真实 CLI 门槛待环境具备后补齐 |
| Grok Build | `--session-id <uuid>` 指定新会话；`--resume <id>` 恢复 | 是 | 调用方预分配 | 代码已接入；真实 CLI 门槛待环境具备后补齐 |
| Cursor Agent | `agent create-chat` 创建空聊天并返回 ID；`--resume <chatId>` 恢复 | 是 | Provider 先创建，再恢复进入 TUI | 代码已接入；本机真实双轮被登录门槛阻塞 |
| OpenCode | Server / SDK `session.create` 创建会话；`opencode attach ... --session <id>` 将 TUI 连接到指定会话 | 是 | Provider 先创建，再 attach TUI | 正式合同候选，首条提示投递需真实验收 |
| Antigravity CLI | Hook 事件包含 `conversationId`；状态栏输入也包含 `conversation_id`；`--conversation <id>` 恢复 | 是 | Provider 官方回调 | 正式合同候选，Hook 安装隔离需真实验收 |
| Codex CLI | App Server `thread/start` 返回 thread ID；CLI TUI 可通过 `--remote` 连接 App Server，`resume --remote <端点> <id>` 进入指定 thread | 是，但 App Server / remote transport 仍为官方实验能力 | Provider 先创建，再由原生 TUI 远程恢复；真实组合失败时用精确兼容关联 | 本机 0.151.0 实验组合失败；精确 nonce 兼容已接入 |

这里的“正式合同”只表示身份原语由 Provider 官方文档定义，不表示 SoloMap 实现已经通过真实 CLI 验收。每个 Provider 仍必须通过本文后续的并发和续聊验收，才能标记为生产可用。

## 2026-09-02 落地与真实验收状态

- 已落地统一 version 2 运行级绑定、revision compare-and-swap、`confirmed` 唯一可续聊、CLI 真实路径与版本复核，以及冲突/不可用后立即失效。
- 环节级派生指针在跨 Extension Host 文件 lease 内重读、比较并原子替换；旧运行晚结束不能覆盖较新运行，读取时仍必须回查对应 confirmed revision。
- 已落地 Claude Code、GitHub Copilot CLI、Grok Build 的调用方 UUID 路径和能力探测；Claude 首个检查点还会精确核对 `CLAUDE_CODE_SESSION_ID`。
- 已落地 Cursor `create-chat -> planned -> --resume <chatId> -> 首个检查点 confirmed`。本机 Cursor `2026.08.25-3e8eec8` 已真实返回 chat ID `f47dbf32-13f4-48eb-a10f-e49bc9f61f78`，但进入原生 TUI 时因本机未登录而在首轮前终止；该对象明确归类为“已创建、未产生消息并保留”，不能算双轮通过。
- 本机 Codex `0.151.0` 已真实执行 `app-server -> thread/start -> resume --remote <thread.id>`；TUI 返回 `thread/resume failed: no rollout found for thread id`，因此该版本不启用实验路径。当前生产路径只使用高熵 nonce、精确工作区、启动时间、首个 user 记录和唯一候选组成的兼容关联。
- 本机 Antigravity CLI `1.1.22` 的项目级 `PreInvocation` Hook 模拟在模型调用前被账号地域资格拒绝，没有产生回调；OpenCode、Claude、Copilot 和 Grok CLI 当前未安装。因此这些 Provider 不伪造真实验收结论：没有通过本文门槛的首次绑定只能保持 `unavailable`。
- 续聊本身也创建新的 version 2 运行级记录，先记录传入的精确恢复目标，再由本次原生 TUI 的首个检查点确认；不会因 direct command 重新落回旧格式捕获。

## 统一身份模型

### 获取方法

```ts
type SessionIdentityMethod =
  | 'caller_assigned'
  | 'provider_created'
  | 'provider_callback'
  | 'transcript_correlated_compat';

type SessionIdentityContract =
  | 'official_stable'
  | 'official_experimental'
  | 'compatibility';
```

- `caller_assigned`：SoloMap 生成符合 Provider 要求的 ID，并通过官方启动参数交给 CLI。
- `provider_created`：SoloMap 调用 Provider 官方创建接口，取得 ID 后再打开指定会话的原生 TUI。
- `provider_callback`：CLI 创建会话，随后通过官方 Hook 或状态事件把 ID 回传给本次运行。
- `transcript_correlated_compat`：原生 TUI 没有官方身份入口时，用只属于本次运行的强证据定位 Provider 本地记录。它是明确标注的兼容路径，不得冒充正式协议。

### 运行级绑定记录

每次用户发起交互对话，都先建立一个运行级记录；建议把它作为当前 `.solopreneur/agent-runs/<scope>/<runId>/session.json` 的下一版结构，而不是只写环节级索引：

```ts
interface SessionBindingRevision {
  revision: number;
  sessionId?: string;
  supersedesRevision?: number;
  method: SessionIdentityMethod;
  contract: SessionIdentityContract;
  state: 'preparing' | 'planned' | 'confirmed' | 'conflict' | 'unavailable';
  createdAt: string;
  confirmedAt?: string;
  providerContext?: {
    codex?: {
      codexHome: string;
      threadSessionId?: string;
      transport: 'unix' | 'loopback_websocket';
    };
  };
  evidence?: {
    source: string;
    transcriptPath?: string;
    providerCreatedAt?: string;
  };
  errorCode?: string;
}

interface NativeSessionBinding {
  version: 2;
  runId: string;
  provider: AgentProvider;
  workspaceRoot: string;
  cliPath: string;
  cliVersion?: string;
  bindingNonce: string;
  createdAt: string;
  headRevision: number;
  resumableRevision?: number;
  revisions: SessionBindingRevision[];
}
```

约束：

- `bindingNonce` 是高熵、单次运行唯一的内部关联值，不等于 Provider session ID。
- revision 中的 `sessionId` 表示 Provider 要求的精确续聊目标；如果 Provider 另有会话树根 ID，应进入同一 revision 的 `providerContext`，不能从续聊目标推导。
- `bindingNonce` 只进入本次运行的环境或插件生成的完整任务包装提示，不进入普通用户界面。
- 不在记录中复制完整用户提示、模型回复、凭据或 Provider 全局配置。
- `cliPath` 和可获取时的 `cliVersion` 用于防止续聊被另一个同名可执行文件接管。
- `evidence` 只保存证明会话归属所需的最小来源，不保存 transcript 内容。
- `headRevision` 始终指向最后追加的 revision，不论其状态；所有 compare-and-swap 都以它作为单调比较基准。
- `resumableRevision` 只有在它等于 `headRevision` 且该 revision 为 `confirmed` 时才有效。追加任何 `preparing`、`planned`、`conflict` 或 `unavailable` revision 时，必须在同一次原子写入中移除 `resumableRevision`，旧 confirmed 只保留审计价值，不能继续恢复。
- 用户在 TUI 内切换或清空会话时追加新 revision，并通过 `supersedesRevision` 关联旧确认记录；历史 revision 不修改、不删除。
- 整份 `session.json` 在运行级 lease 下以 compare-and-swap 检查预期 revision，再通过临时文件替换原子写入；并发更新失配进入 `identity_index_conflict`，不能后写覆盖。
- Codex 的规范化绝对 `CODEX_HOME` 与 `thread.sessionId` 必须和对应 `thread.id` 写入同一个 revision。现有 `codex-home.txt` 只作为旧格式兼容输入；version 2 写入后即以 `session.json` 为权威，不能让 companion file 单独改变恢复目标。
- App Server endpoint、PID 和一次性回调票据属于易失运行状态，可以写入同一 run 目录的 `runtime.json`；它们不得决定 session ID，重载时必须先用 session revision 校验 Provider 存储，再重建 endpoint。
- 项目级 `.solopreneur/step-sessions/<nodeId>.json` 继续作为派生索引，并保存 `{ runId, revision, sessionId }` 指针；它不是本次运行的事实源。每次续聊都必须回读对应 `session.json`，确认 `headRevision === resumableRevision === revision` 且状态仍为 `confirmed`。因此即使两个文件之间发生崩溃，旧索引也只能造成入口暂时缺失，不能恢复旧会话。

## 统一生命周期

```text
创建运行
   │
   ▼
prepareSessionIdentity
   ├─ 调用方预分配 ───────► planned
   ├─ Provider 创建成功 ──► planned
   └─ 等待官方回调/兼容证据 ► preparing
   │
   ▼
launchNativeTerminal
   │
   ▼
confirmSessionIdentity
   ├─ 唯一且符合 Provider 合同 ─► confirmed ─► 提升到环节续聊索引
   ├─ 多个候选或证据冲突 ──────► conflict
   └─ 超出首次绑定窗口仍无证据 ─► unavailable
```

具体顺序：

1. 插件创建 `runId`、`bindingNonce` 和运行目录，原子写入 `preparing`。
2. 适配器按 Provider 能力准备 ID：预分配、调用创建接口，或创建本次运行专属的回调接收票据。
3. 如果启动命令需要明确 ID，必须先原子写入 `planned`，再打开终端。
4. CLI 接受官方指定 ID、Provider 创建结果通过读回验证，或回调/兼容证据唯一命中后，原子写入 `confirmed`。
5. 只有 `confirmed` 记录可以更新环节级续聊索引，并启用“继续”动作。
6. CLI 退出、VS Code 重载或状态刷新不能把 `preparing` 候选自动提升为 `confirmed`。
7. 恢复时同时校验 Provider、CLI family、工作区和运行级绑定；不满足时不执行续聊命令。

### `planned` 与 `confirmed` 的区别

- 对调用方预分配路径，官方参数已经定义了 ID 的含义。CLI 成功接受启动参数且产生本次会话的首个可验证事件后，可以确认。
- 对 Provider 先创建路径，创建响应必须包含 ID，并尽可能通过官方读取接口读回；只有创建成功不能证明 TUI 已进入该会话，仍需验证 attach / resume 成功。
- 对回调与兼容路径，只有收到与本次运行唯一关联的证据才能确认。

### 各 Provider 的确认权威

| Provider 路径 | 可以把 `planned` 提升为 `confirmed` 的机器证据 |
| --- | --- |
| Claude Code caller-assigned | 能力探测确认 `--session-id`；CLI 未拒绝该参数；本次包装提示触发的首个 SoloMap 检查点可同时读回 `CLAUDE_CODE_SESSION_ID`，且与 planned UUID 完全一致 |
| Copilot / Grok caller-assigned | 能力探测确认参数；CLI 未拒绝该参数；本次包装提示对应的首个 SoloMap 检查点已到达。Provider 提供 `/session` 或结构化事件时，再做精确 ID 交叉核验 |
| Cursor provider-created | `create-chat` 返回单一 ID；`--resume <id>` 未被 CLI 拒绝；该 TUI 中本次包装提示对应的首个 SoloMap 检查点已到达 |
| OpenCode provider-created | 创建响应和 `GET /session/:id` 一致；attach 就绪后，Server 上该 Session 出现本次首轮 message / status 事件 |
| Antigravity provider-callback | `PreInvocation` Hook 通过本次运行票据、精确工作区和时间窗口回传单一 `conversationId` |
| Codex provider-created | 控制连接上的 `thread/start` 响应、TUI `resume --remote` 目标和该 `thread.id` 的首个 `turn/started` 事件三者一致，且没有另建 thread |
| Codex compatibility | transcript 同时满足 nonce、精确工作区、启动时间、user 角色和唯一候选；零个或多个候选都不能确认 |

检查点只证明本次包装提示已经在该 TUI 中开始执行，不能单独生成或猜测 Provider ID。若 Provider 的官方参数语义与检查点冲突，以 Provider 的明确拒绝或官方事件为准，进入 `conflict`。

首轮由插件预登记，因此不会再发一次 `start`；首轮 `complete` 是该 TUI 的首个可验证检查点。后续轮次以 `start` 为首个检查点。两种事件都只能确认启动前已经写入的 planned ID，不能从检查点输出中抽取新 ID。

## 各 Provider 的首次绑定协议

### Claude Code：启动前指定 UUID

官方 CLI 提供 `--session-id <uuid>`，要求使用有效 UUID；`--resume <id>` 恢复指定会话。Claude Code 启动的 Hook、MCP 和工具子进程还会得到当前 `CLAUDE_CODE_SESSION_ID`。

首次启动：

```text
1. SoloMap 生成 UUID。
2. 先写入 planned 绑定。
3. 启动 claude --session-id <uuid> <现有交互参数>。
4. CLI 成功进入交互会话并出现本次首轮证据后，写入 confirmed。
5. 后续使用 claude --resume <uuid>。
```

`CLAUDE_CODE_SESSION_ID` 可以作为确认或诊断证据，但不应替代更简单、确定的 `--session-id` 主路径。`/clear` 会改变当前会话 ID，因此如果用户在原生终端内主动清空会话，SoloMap 需要从官方环境/Hook 事件更新运行级绑定；在没有可靠更新事件前，应把旧绑定标为不可继续，而不是继续恢复旧 ID。

### GitHub Copilot CLI：启动前指定 UUID

官方 `--session-id <uuid>` 的语义同时覆盖“指定 ID 不存在则创建”和“ID 已存在则恢复”。因此首次启动必须使用全新 UUID，续聊才使用已确认 UUID，不能把两种意图区分留给偶然的本地状态。

首次启动：

```text
1. 生成全新 UUID，并检查它没有出现在 SoloMap 本地绑定索引中。
2. 先持久化 planned。
3. 启动 copilot --session-id <uuid> -i <SoloMap 包装提示>。
4. 交互会话建立后确认；/session 或退出信息只作为附加核验。
5. 后续继续使用同一个 --session-id <uuid>。
```

非 TTY 下按名称或前缀恢复可能有歧义，SoloMap 只保存和传入完整 ID，不使用名称、前缀或“最近会话”。

### Grok Build：保留并正式化现有预分配路径

Grok Build 官方支持 `--session-id <UUID>` 创建指定会话和 `--resume <id>` 恢复。现有 SoloMap 已有预生成 ID 的基础，应把它纳入统一的 `planned -> confirmed` 生命周期，而不是保留成 Provider 特例。

首次启动和恢复规则与 Claude Code 相同。原生 TUI 已有直接的官方参数，不引入其他交互协议。

### Cursor Agent：先创建聊天，再进入原生 TUI

Cursor 当前官方参数文档提供 `agent create-chat`，用于创建空聊天并返回 ID；`--resume <chatId>` 恢复指定聊天。SoloMap 只使用这条原生 TUI 路径。

首次启动：

```text
1. 能力探测确认当前 agent 可执行文件支持 create-chat 和 --resume。
2. 运行 agent create-chat，严格解析其成功输出中的单一 chat ID。
3. 保存 planned，并把 Provider 创建响应作为证据。
4. 启动 agent --resume <chatId> <现有原生交互参数与包装提示>。
5. TUI 成功进入该聊天后确认。
```

如果旧版 Cursor 不支持 `create-chat`：

- 标记当前版本不支持稳定自动续聊，建议用户升级到具有官方 `create-chat` 的版本。
- 不得退回扫描最近 chat 或从混合终端文本中抽取任意 UUID。
- 不得探测或启用 ACP 作为兼容路径。

### OpenCode：Server 创建 Session，再 attach 指定 TUI

OpenCode 官方 Server 和 SDK 都能创建 Session；官方 CLI 的 `attach` 可以连接到运行中的 Server，并通过 `--session <id>` 打开指定会话。这给出了明确的“Provider 创建 + 原生 TUI 连接”路径。

设计流程：

```text
1. 启动只绑定 loopback 的、由本次运行或 SoloMap 管理的 opencode serve。
2. 通过官方 POST /session 创建 Session，取得精确 ID。
3. 通过 GET /session/:id 读回验证并保存 planned。
4. 启动 opencode attach <server-url> --session <id> --dir <workspace>。
5. 使用官方 TUI 控制接口投递 SoloMap 包装提示并提交，或证明当前版本支持等价的指定 Session 初始提示方式。
6. TUI 与 Server 都确认同一 ID 后写入 confirmed。
```

这里有一个必须在实现前通过真实 CLI 关闭的接口组合问题：官方分别定义了创建 Session、attach TUI、向 TUI 追加/提交提示，但文档本身不保证所有版本中“创建后立即 attach，再由控制接口提交首条包装提示”的时序完全一致。因此：

- 这条路径是正式 API 组成的设计候选，但不能仅凭静态文档宣布生产可用。
- 实现必须等待 attach 就绪事件，确认 TUI 当前 Session 与创建结果一致，再提交首条提示。
- 如果真实验收失败，保持原生 TUI 可用，但该版本不承诺自动续聊；不得改用 `session list` 取最新记录。

这与 [OpenCode 深度适配设计](./opencode-deep-adapter-design.zh.md) 中无人值守结构化运行并不冲突：本文只规定用户主动发起的原生交互终端如何取得稳定身份。

### Antigravity CLI：从官方 Hook 回传 conversationId

Antigravity 官方 Hook 的公共输入包含 `conversationId`、`workspacePaths` 和 `transcriptPath`；`PreInvocation` 在模型调用前触发，足以在首条实际请求时捕获当前原生对话 ID。官方状态栏输入也包含 `conversation_id`，恢复命令使用 `--conversation <id>`。

设计流程：

```text
1. 为当前运行创建只接收一次的本地绑定票据，并通过环境注入 runId / bindingNonce。
2. 使用增量、可审计、保留用户原配置的方式注册 SoloMap Hook。
3. Hook 只在存在本次运行环境票据时上报 conversationId、workspacePaths 和 transcriptPath；普通 Antigravity 会话直接放行。
4. 接收端同时校验票据、精确工作区、回调时间窗口和单一 conversationId。
5. 唯一命中后写入 confirmed；后续用 --conversation <id> 恢复。
```

配置约束：

- 不覆盖用户已有 `.agents/hooks.json` 或全局配置。
- 若需要永久安装辅助 Hook，必须有一次明确授权、可撤销入口和配置所有权记录。
- 优先使用项目级、增量命名的 Hook；只有 Provider 没有运行级或项目级安全入口时，才考虑全局安装。
- 状态栏只能作为次级官方回调：若使用，必须通过复用器保留用户原 status line 命令和输出，不能抢占其配置。
- 无法安全合并配置或无法证明回调属于本次运行时，结果是 `unavailable`，不是读取 `last_conversations.json` 的工作区最新项。

Antigravity 的 `-c` 依赖工作区最近会话，不适合作为 SoloMap 精确续聊命令；SoloMap 必须保存完整 conversation ID 并使用 `--conversation <id>`。

### Codex CLI：App Server 创建 Thread，原生 TUI 连接同一服务

OpenAI 官方 App Server 文档定义了两组可以组成完整路径的能力：

- `thread/start` 创建新对话并返回 `thread.id`，`thread/resume` 按记录的 `thread.id` 继续。
- Remote terminal UI 允许原生 Codex CLI TUI 通过 `codex --remote <端点>` 连接 App Server。

当前本机 Codex CLI 0.151.0 的官方命令帮助进一步确认，`codex resume [SESSION_ID]` 接受 `--remote <端点>`，因此可以让原生 TUI 在同一个 App Server 上进入预先创建的精确 thread，而不需要改成 SoloMap 自建聊天界面。

新版设计流程：

```text
1. 能力探测确认 app-server listener、TUI --remote 和 resume --remote 同时存在。
2. 在本次运行目录启动只对本机开放的 App Server；优先使用运行级 Unix socket，或使用 loopback WebSocket。
3. SoloMap 控制连接完成 initialize / initialized，再调用 thread/start，并保存返回的 thread.id。
4. 记录 provider_created + official_experimental 的 planned 绑定。
5. 启动原生 TUI：codex resume --remote <同一端点> <thread.id> <SoloMap 包装提示>。
6. 控制连接观察到该 thread 的首轮事件，且 TUI 没有另建 thread 后，写入 confirmed。
7. 当前终端关闭后，未来续聊可启动兼容的 App Server，并再次使用 resume --remote <端点> <thread.id>。
```

这条路径仍有三项必须通过真实模拟关闭的风险：

- App Server 与 remote transport 在官方文档中仍标为 experimental / unsupported for production workloads，不能仅凭命令存在宣布生产稳定。
- 必须证明 `thread/start` 创建的空 thread 能由连接**同一 App Server**的原生 `resume --remote` 接管；已有“创建后改用普通本地 `codex resume`”失败记录不能外推到 remote 路径，也不能被忽略。
- 必须证明 App Server 重启后能从同一 `CODEX_HOME` 恢复该 thread，并且 TUI、控制连接和落盘记录始终报告同一个 `thread.id`。

安全与生命周期约束：

- App Server 只绑定运行级 Unix socket 或 `127.0.0.1`，不能把无认证 listener 暴露到非 loopback 地址。
- 若使用 WebSocket，按官方要求使用本机连接；任何非本机连接都必须有 TLS 和认证，但 SoloMap 首版没有远程暴露需求。
- Server 是当前交互终端的运行依赖，终端仍活动时不得提前停止；终端关闭后必须明确收口该运行创建的 Server，不遗留监听进程。
- `thread.id` 是恢复目标；若同时返回 `thread.sessionId`，按官方说明将其作为会话树根单独保存，不能假定 fork 后二者仍相同。

如果当前 Codex 版本缺少上述 remote 能力，或真实验收证明接口组合不成立，才允许使用以下旧版兼容路径：

```text
1. 为本次运行生成高熵 bindingNonce，并把它放入插件生成的完整 SoloMap 任务包装提示。
2. 记录精确 workspaceRoot、CLI 启动时间和运行目录。
3. 启动原生 Codex TUI，正常提交该包装提示。
4. 只检查启动时间之后、精确工作区内、首个 user 记录完整包含本次 bindingNonce 的 Codex transcript。
5. 候选必须恰好为一个，并且 transcript 中的 session/thread ID 格式有效。
6. 唯一命中后保存 `transcript_correlated_compat` 和 transcript 路径；零个或多个候选都不得确认。
7. 后续使用完整精确 ID 执行 codex resume <id>。
```

禁止的关联条件：

- 同工作区最新 transcript。
- 最近修改时间最大的 session。
- 只出现普通任务文本、项目名或节点名。
- 从终端输出中发现的任意 UUID。
- 复用该环节上一次已确认 ID 作为本次新会话。

兼容路径的证据强度来自“不可预测的本次运行标记 + 精确工作区 + 启动后时间窗口 + user 角色 + 唯一候选”的交集。任何条件缺失都不能确认。兼容定位器只保留给缺少或未通过 remote 能力验收的版本。

关键纠偏是：App Server 不再被等同于“必须自建 Chat UI”。官方 Remote terminal UI 已能保留 Codex 原生终端体验；本设计直接连接该官方服务取得精确身份，不经过 ACP adapter，也不会复刻 Codex 的审批、流式输出和交互界面。

## 并发、重载与恢复规则

### 同工作区并发

每个运行都拥有独立的 `runId`、`bindingNonce`、运行目录和回调票据。任何 Provider 适配器都必须能通过以下场景：

```text
工作区 W
├─ 运行 A -> 会话 A
├─ 运行 B -> 会话 B
└─ 用户直接在 CLI 中打开的会话 C
```

A 只能确认 A，B 只能确认 B；C 不能被任一运行吸收。按工作区、修改时间或 Provider 最近会话列表做单条件选择一律不合格。

### VS Code 重载

- `planned`、`confirmed`、`conflict` 和 `unavailable` 都必须原子落盘。
- 重载后可以继续等待尚在有效窗口内的官方回调，但不能重新生成 nonce 或把旧候选当成新候选。
- 已确认会话直接从运行级记录恢复，再校验环节索引是否一致。
- 运行级记录与环节索引冲突时，以可验证的运行级 `confirmed` 记录为准，同时停止自动续聊并报告内部一致性错误；不能静默覆盖。

### 用户在 CLI 内切换或清空会话

如果 Provider 原生 TUI 允许用户在同一个终端中创建、切换或清空会话，启动时的 ID 可能不再代表当前终端：

- 有官方持续事件的 Provider 应更新绑定历史，并把最新已确认 ID 提升为续聊目标。
- 没有官方持续事件的 Provider 不能假设 ID 未变化；检测到 transcript 或 Provider 状态冲突时，关闭自动续聊能力。
- 不修改已经结算的历史运行记录；新 ID 作为同一运行中的后续确认版本记录。

## 失败语义

内部错误码应区分原因，普通界面只表达用户动作：

| 内部状态 | 示例错误码 | 用户动作 |
| --- | --- | --- |
| `unavailable` | `identity_capability_missing` | 保留当前终端；提示该 CLI 版本暂不能稳定继续，可升级后重试 |
| `unavailable` | `identity_not_observed` | 保留当前终端；提示尚未取得续聊信息，不创建错误续聊入口 |
| `conflict` | `identity_ambiguous` | 保留所有会话，不自动选择；允许从原终端继续 |
| `conflict` | `identity_provider_mismatch` | 停止续聊，提示当前会话与原 Agent 不一致 |
| `conflict` | `identity_index_conflict` | 不覆盖任一记录，进入可诊断状态 |

所有失败都必须保留足够的结构化诊断信息，但日志不得包含完整提示、回复、Token 或用户凭据。

## 旧数据迁移

迁移必须增量进行，不批量重写历史会话：

1. 已存在且能由 Provider 精确恢复的环节级 ID 继续保留，标记为 `legacy_confirmed` 来源；首次恢复成功后补充运行级证据。
2. 缺失 ID 的历史运行只在存在精确证据时修复。Codex 可以使用该运行保存的完整提示文件路径与 transcript 记录做一次性唯一关联；不能用普通节点标题或最新时间修复。
3. 多个候选、工作区不一致或 Provider 不一致时保持不可用，不替用户选择。
4. 新实现只对新运行强制 version 2 绑定；读取层兼容旧格式，写入层不再生成旧格式。
5. 环节索引只在新运行 `confirmed` 后更新，不能因迁移扫描覆盖用户最近正在使用的已确认会话。

## 实施拆分

### 阶段一：统一绑定内核，不改 UI 心智

- 新增 `SessionIdentityAdapter` 边界和 version 2 运行级绑定记录。
- 把续聊入口改为只消费 `confirmed` 绑定。
- 移除新运行对“工作区最新会话”“最近 transcript”和通用 UUID 输出抽取的依赖。
- 保留旧数据只读兼容，不做批量迁移。

### 阶段二：先落地确定性最高的官方路径

- Claude Code：生成 UUID + `--session-id`。
- GitHub Copilot CLI：生成 UUID + `--session-id`。
- Grok Build：将现有 UUID 路径迁入统一生命周期。
- Cursor：`create-chat` + `--resume <chatId>`，包含能力探测。

这四条路径都应在启动原生 TUI 前知道确切 ID，最适合作为内核验收基线。

### 阶段三：关闭官方接口组合风险

- OpenCode：真实验证 `serve -> POST /session -> attach --session -> 投递首条包装提示 -> 多轮续聊`。
- Antigravity：验证 Hook 的作用域、并发、原配置保留和首次 `PreInvocation` 回调。
- Codex：真实验证 `app-server -> thread/start -> resume --remote <id> -> 多轮 -> Server 重启后恢复`，并确认没有另建 thread。
- 只有完整验收通过后，才把相应 Provider 标记为稳定续聊可用。

### 阶段四：隔离旧版 Codex 兼容路径

- 只在能力探测不支持或 remote 真实验收不成立的 Codex 版本启用精确 transcript 定位器。
- 补充两个真实 Codex TUI 同工作区并发和第三方诱饵会话测试。
- UI 不暴露兼容实现，只在诊断记录中保留 `transcript_correlated_compat`。
- 官方实验路径稳定后逐步缩小旧版兼容范围，但不破坏已经保存的旧会话。

## 实现前模拟与生产验收

任何 Provider 不能只因单元测试构造出一个 UUID 就宣布完成。每个 CLI 都必须用当前受支持真实版本执行以下黑盒场景：

| 场景 | 必须证明的结果 |
| --- | --- |
| 首次启动 | SoloMap 最终保存的 ID 与 Provider 当前会话完全一致 |
| 连续两轮 | 第二轮仍是相同 ID，并能回答第一轮写入的唯一哨兵信息 |
| 关闭后恢复 | 使用保存 ID 恢复，第三轮仍能读到前两轮信息 |
| 同工作区并发 A/B | A、B 获得不同 ID，各自只能读到自己的哨兵 |
| 同工作区诱饵 C | C 比 A/B 更新得更晚，也不能被 SoloMap 捕获 |
| VS Code 重载 | 重载后仍从运行级绑定恢复同一 ID |
| CLI 提前退出 | 没有首轮证据时不产生 confirmed 绑定 |
| 当前版本缺少官方能力 | 若该 Provider 没有本文明确批准并通过验收的兼容路径，则进入 unavailable；一律不得扫描最新会话降级 |
| 旧版 Codex 兼容 | 唯一强关联候选必须成功绑定；零个候选进入 unavailable，多个候选进入 conflict，均不得改取最新 transcript |
| 错误 ID 注入 | Provider 不一致、工作区不一致或 ID 不存在时拒绝续聊 |
| 用户配置保护 | 运行前后配置逐字节等价，除用户已授权的增量 Hook 记录 |
| 命令生成 | 最终生成的 shell 命令可解析，路径、提示和 ID 引号正确 |

Provider 级上线门槛：

1. 官方参数或接口路径有对应的契约测试。
2. 真实 CLI 完成“新建—两轮—关闭—恢复”闭环。
3. 真实 CLI 完成同工作区并发和诱饵隔离。
4. 失败路径确认不会写入或提升错误 ID。
5. 运行结束后，测试创建的会话、Server、Hook 和临时票据已明确保留或安全清理。

## 明确不做

- 不引入、探测或回退到 ACP；这不是待评估方案，而是已禁止边界。
- 不为了统一实现而把所有 Agent CLI 改成 SDK 或自建 Chat UI。
- 不把工作区最近会话、最近文件或最近 UUID 重新包装成“智能兜底”。
- 不要求用户手工寻找、复制或确认 session ID。
- 不通过轮询完整 transcript 内容实现日常状态跟踪。
- 不因某一个 Provider 缺少官方入口而降低其他 Provider 的身份强度。
- 不把会话 ID 稳定绑定与任务轮次完成、路线图完成或终端进程退出重新耦合。

## 官方文档依据

以下能力判断只引用各 Provider 官方文档或官方仓库；访问日期均为 2026-09-01。

### Claude Code

- [CLI reference：`--session-id` 与 `--resume`](https://code.claude.com/docs/en/cli-reference)
- [Environment variables：`CLAUDE_CODE_SESSION_ID`](https://code.claude.com/docs/en/env-vars)

### GitHub Copilot CLI

- [CLI command reference：`--session-id`、`--resume`](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Chronicle：`/session` 与退出时的 Session ID](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle)

### Grok Build

- [CLI reference：`--session-id` 与 `--resume`](https://docs.x.ai/build/cli/reference)

### Cursor Agent

- [CLI parameters：`create-chat`、`--resume`](https://prod.cursor.com/docs/cli/reference/parameters)
- [Output format：stream-json 中的 `session_id`](https://docs.cursor.com/en/cli/reference/output-format)

### OpenCode

- [CLI：`--session`、`attach`、`serve` 与 `session list`](https://opencode.ai/docs/cli/)
- [SDK：`session.create`](https://opencode.ai/docs/sdk/)
- [Server：Session 与 TUI API](https://opencode.ai/docs/server/)

### Antigravity

- [Hooks：公共输入中的 `conversationId` 与 `transcriptPath`](https://antigravity.google/docs/hooks)
- [Status line：`conversation_id`](https://antigravity.google/docs/cli/statusline/)
- [Resume：`--conversation <id>`](https://antigravity.google/docs/cli/commands/resume/)
- [Headless：stream-json 的 `conversation_id`](https://antigravity.google/docs/cli/headless/)

### Codex

- [OpenAI 官方 Codex App Server：Remote terminal UI、`thread/start` 与 `thread/resume`](https://developers.openai.com/codex/app-server/)
- [Codex App Server 官方仓库实现](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex CLI 官方仓库](https://github.com/openai/codex)

## 完成判定

本设计只有在以下事实同时成立后才算实现闭环：

- 每个已宣称支持稳定续聊的 Agent CLI 都通过真实新建、并发、多轮和恢复验收。
- 新运行不再使用工作区最新会话或通用 UUID 抽取作为身份来源。
- 运行级记录能解释“这个 ID 为什么属于这次运行”。
- 任何歧义都停止自动续聊，而不是选择一个看起来最像的候选。
- 用户始终只看到一套“开始对话 / 继续对话”的心智，不需要理解 Provider 的身份机制。
