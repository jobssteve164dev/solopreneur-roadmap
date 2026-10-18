# Pi 原生对话上下文接入审计与实施交接

更新时间：2026-10-17

审计基线：SoloMap `v0.0.589`，提交 `e2a7c0f89218d7b568f57ed11854dbfa1a1b981b`

依赖基线：`@earendil-works/pi-agent-core@0.87.1`、`@earendil-works/pi-ai@0.87.1`

## 2026-10-18 实施状态

- 角色化历史已恢复到 Pi `AgentMessage[]`，当前 user 继续通过 `agent.prompt()` 进入；侧边栏与 Telegram 共用同一路径。
- 长上下文不再使用 SoloMap 的固定字符预算或自定义切点。`transformContext` 只承担适配：将数据库消息映射为 Pi Harness `Entry[]`，调用上游默认 `DEFAULT_COMPACTION_SETTINGS`、`estimateContextTokens`、`shouldCompact`、`prepareCompaction`、`compactWithRequest` 与 `buildSessionContext`；MCP 工具输出使用 Pi 上游 `truncateHead` 的行数/字节限界。
- 摘要仍通过用户已选择的 Agent CLI 模型管道生成。明确选择的模型从 Pi 模型目录读取 `contextWindow`/`maxTokens`；CLI 使用 `auto` 或目录中没有该模型时，有目录映射的 family 采用 Pi 目录最小能力，未暴露映射的 CLI 使用 65,536 token 的保守传输合同。未达到 Pi 阈值时不增加模型请求；达到阈值时才增加 Harness 摘要请求，摘要输出服从 Harness 下发的 `maxTokens`。
- 完整 user/assistant 历史仍只保存在 SoloMap 统一数据库。Harness checkpoint 是带来源消息数、来源哈希、源修订和 token 计数的派生投影，与最终回答在同一事务提交；失败、取消、撤销或 revision conflict 不会留下 checkpoint。
- 每个对话只保留一条当前 checkpoint 投影。替换下来的 content 会进入既有数据库存储清理队列，并由同一 Runtime 的有界后台维护回收，不要求重启；不引入 Pi SQLite、JSONL、第二数据库或 Agent CLI native session。
- Telegram 将 `replyGeneration` 作为事务提交守卫交给统一数据库；解绑或换绑与消息/checkpoint 提交在同一权威数据库边界竞争，旧代际不能留下整轮或半轮写入。
- 本文后续“已观察到的当前实现”保留的是 `v0.0.589` 实施前审计事实，用于解释根因，不再代表 2026-10-18 的代码现状。

## 最终目标

让侧边栏智能内核和 Telegram 共用的每个对话，真正以 Pi `Agent` 的原生消息状态运行：SoloMap 数据库继续作为唯一持久化对话账本，每轮开始把该对话的历史恢复为 Pi `AgentMessage[]`，本轮用户消息、工具调用、工具结果和最终回答由 Pi 原生 Agent 循环处理，最终用户可见消息再原子写回原对话账本。

这不是更换数据库、引入第二套会话文件、复用 Agent CLI 自己的会话，或重写智能内核产品边界。唯一增量是：**把已经持久化的对话历史交给 Pi 原生上下文接口，而不是把整段历史和项目快照序列化成一条 JSON 用户消息。**

## 执行契约

### 必须保持的不变量

- SoloMap 统一数据库是智能内核对话的唯一持久真源；现有 `conversation` / `message` 账本、对话 ID、并发修订和幂等写入继续生效。
- 侧边栏和 Telegram 继续共享同一套 `IntelligenceConversationStore` 实现、同一数据库账本与同一条智能内核链路；保持各自现有 Store 实例，不跨运行时合并实例。
- 每轮只在最终回答成功且提交权仍有效时，原子追加“用户消息 + 最终回答”；失败、取消、Telegram 解绑或修订冲突不得留下半轮消息。
- 当前项目快照每轮从权威数据重新读取，不由旧对话中的项目名称决定当前项目。
- Pi 当前轮内的工具调用与 `toolResult` 必须完整保留到最终回答结束，不能被上下文重载覆盖。
- 工具权限、只读沙箱、隐私过滤、时间安排工具、诊断链路、取消能力和现有产品 UI 均保持不变。
- 不修改路线图状态，不改变智能内核的用户可见对话模型，不把 Pi、session backend、compaction 等实现名词暴露给普通用户。

### 明确禁止

- 禁止继续把 `{ projectContext, messages }` 整体 `JSON.stringify` 后作为单条 `agent.prompt(...)`。
- 禁止新增 JSON/JSONL 会话目录、第二个 SQLite、Pi SQLite session backend 或 Agent CLI 原生会话作为另一份权威历史。
- 禁止用 `prepareRequest` 在每次 provider 请求前无条件用数据库历史替换 `context.messages`；这会在同一轮工具循环中丢掉尚未入库的 assistant tool call 和 `toolResult`。
- 禁止把当前项目快照写进用户对话账本，或把它伪装成用户说过的话。
- 禁止为了接入上下文而改写计划、战略判断、文件交付等非聊天 Pi 调用。
- 禁止只改提示词、只改序列化格式，或只证明 stdin 中仍能搜到旧文本，就宣称已经使用 Pi 原生上下文。
- 禁止以截断全部旧消息、提前失败或降低回答能力代替长上下文治理。

## 实施前观察到的实现

以下均为审计基线 `v0.0.589` 的代码事实，不是对 2026-10-18 实施结果的描述。

### 1. 数据库已经正确承担持久对话账本

- `src/intelligenceChat.ts:27-103` 的 `IntelligenceConversationStore` 在每次发送前读取完整对话，追加当前用户消息，调用回复函数，然后把用户消息与最终回答一起写回。
- `src/intelligenceChat.ts:62-100` 按对话 ID 串行化本进程内发送；数据库修订冲突时重新读取并重算，提交权撤销时拒绝写入。
- `src/db/unifiedDataStore.ts:7456-7487` 从统一数据库按 sequence 恢复消息，并通过 revision、历史前缀一致性和嵌套幂等键原子追加。
- `src/extension.ts:1007-1061` 与 `src/telegramRuntime.ts:126-165` 都将同一类数据库消息数组传入 `EmbeddedPiAgentEngine.chat(...)`。

结论：数据库链路不是需要替换的错误部分。它已经解决跨进程持久化、侧边栏/Telegram 共用、并发冲突和失败不落半轮记录。

### 2. Pi Agent 只被用于当前单次运行，没有接管历史语义

- `src/piAgentEngine.ts:180-205` 每次 `chat()` 都新建一个 Pi `Agent`。
- `initialState` 当前只设置 `systemPrompt`、`model` 和 `tools`，没有设置 `messages`。
- `src/piAgentEngine.ts:248` 将 `projectContext` 和包含最后一条用户消息在内的全部历史一起序列化为 JSON，再作为一条新的用户 prompt。
- `src/piAgentEngine.ts:69-75` 的 `transcriptPrompt()` 只是把 Pi 在当前调用中看到的消息转换成 Agent CLI stdin；因此模型看到的历史位于一条 JSON 用户消息内部，而不是 Pi 的 user/assistant 多轮 transcript。该转换还只提取 `text` content block，assistant `toolCall` 的 id/name/arguments 会变成空的 `ASSISTANT:`，后续请求虽然能看到 `TOOLRESULT:`，却看不到它对应的原始工具调用。
- `src/extension.ts:1023-1028` 和 `src/telegramRuntime.ts:131-132` 每次回复还会新建 `EmbeddedPiAgentEngine`，所以不能依赖内存中长期存活的 Agent 实例。

结论：当前能“看到旧对话”，但这是 SoloMap 自己把历史重新包装成文本，不是 Pi 原生上下文恢复。

### 3. 当前测试证明了内容存在，没有证明消息角色正确

- `test/intelligence-chat.test.js:150-173` 只断言旧问题、当前问题和项目名出现在 stdin。
- `test/intelligence-chat.test.js:240-280` 只断言 Telegram 第二轮 prompt 包含上一轮回答。
- 这些断言无法区分“真正的 Pi user/assistant transcript”和“一个包含历史 JSON 的新 user message”，所以当前错误实现仍可通过。

### 4. Pi Core 确实提供原生上下文能力

安装包的当前接口明确支持：

- `Agent` 是 stateful wrapper，并拥有当前 transcript：`node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:29-34`。
- `initialState.messages` 可恢复已有消息：`agent.d.ts:4-10`，实际构造时复制消息并补 leading system message：`dist/agent.js:30-35`。
- `prompt(AgentMessage | AgentMessage[])` 与 `continue()`：`agent.d.ts:113-117`。
- `transformContext` 用于裁剪旧消息或注入外部上下文：包 README 的 Message Flow 与 `agent.d.ts:10`。
- `prepareRequest` 可在 provider 请求前安装持久上下文，但它是替换请求上下文的低层接口，不等于应该在当前架构中每轮重读数据库。
- Pi harness 还导出 session context 与 compaction 能力；SQLite session backend 是另一个可选包，不是 Core 自动持久化的一部分。

结论：应该复用 Pi 的 transcript、角色、工具循环与上下文变换；SoloMap 数据库继续负责进程外持久化。两者职责互补，不应二选一。

## 根因

当前实现把两个不同责任合并错了：

```text
持久化恢复（SoloMap 数据库）
  被实现成
历史文本拼装（JSON）
  再作为
Pi 的一条新用户消息
```

正确责任边界应是：

```text
SoloMap 数据库：保存、读取、并发控制、跨入口共享用户可见对话
        ↓ 映射
Pi AgentMessage[]：表达 user / assistant 角色并驱动当前 Agent transcript
        ↓ 当前轮
Pi 工具循环：assistant toolCall → toolResult → assistant final
        ↓ 成功提交
SoloMap 数据库：只追加当前用户消息与最终用户可见回答
```

## 目标实现设计

### 1. 建立明确的消息适配层

在智能内核边界新增小而纯的转换函数，不改变数据库 schema：

- 历史 `user` → Pi `UserMessage`：保留原 content，补齐稳定 timestamp。
- 历史 `assistant` → Pi `AssistantMessage`：使用现有 `assistantMessage(...)` 结构补齐 api、provider、model、usage、stopReason 和 timestamp。
- 当前最后一条 `user` 不作为历史 assistant 之后的普通 JSON 字段；它必须作为 Pi 的真正 user message 进入本轮。
- 输入必须验证角色交替的最低合同：非空、最后一条为 user；不要静默改变正文。
- Agent CLI transcript serializer 必须覆盖 Pi 标准 content block：普通文本保持角色，assistant `toolCall` 明确序列化 id/name/arguments，`toolResult` 明确序列化 toolCallId/toolName/isError/content；不得继续用只抽取 text 的 `messageText()` 作为完整 transcript。

现有数据库消息没有逐条 timestamp。第一版不应仅为满足 Pi 类型而扩张数据库 schema；可以按对话顺序生成单调、稳定且不参与产品语义的运行时 timestamp。若实现者发现 Pi 的缓存或 compaction 必须依赖真实消息时间，再以证据提出独立 schema 变更，不能顺手扩大本任务。

### 2. 每轮从数据库恢复，再交给 Pi 原生运行

推荐的最小正式路径：

1. `IntelligenceConversationStore` 从数据库读取旧消息并追加本轮 user，保持现有事务边界。
2. `EmbeddedPiAgentEngine.chat()` 将“旧的已提交 user/assistant 消息”映射进 `initialState.messages`。
3. 将最后一条当前 user 通过 `agent.prompt(userMessage)` 加入，或者把全部消息装入 `initialState.messages` 后调用 `agent.continue()`；二者只能选一种，必须用测试证明没有重复最后一条 user。
4. Pi 在当前 `Agent` 内原生完成 model → toolCall → toolResult → model 循环。
5. 从本轮产生的最终 assistant message 提取回答，返回给 Store；Store 按既有规则原子写回用户消息与最终回答。

优先建议“历史进入 `initialState.messages`，当前 user 调用 `prompt(userMessage)`”，因为它直接对应 Pi 公共事件语义，也不要求 `chat()` 预先构造一个以 user 结尾的可继续 transcript。

### 3. 当前项目快照属于请求上下文，不属于对话历史

当前 `projectContext` 是每轮开始时从权威数据读取的快照。应把它放入本轮 system prompt 的命名段或等价的非持久请求上下文，而不是写入 user message 或数据库历史。

要求：

- Agent CLI stdin 中，系统规则、当前项目快照、历史 user/assistant 消息和本轮 user 能清楚分层。
- 数据库回读仍只出现用户和助手真正看到的对话正文。
- 下一轮切换当前项目后，新快照替换旧快照；旧 assistant 提过的项目名不取得当前项目权威性。
- 项目路径、Secret 和受保护字段继续沿现有过滤边界，不因上下文接入进入模型或诊断日志。

### 4. 不在 `prepareRequest` 中破坏当前工具循环

Pi README 展示了用 `prepareRequest` 加载 canonical persisted context 的例子，但当前 SoloMap 的账本只在最终回答成功后提交。本轮 tool call 与 tool result 在调用中途尚未写入数据库。

因此第一版应在 Agent 创建时只恢复一次数据库历史，让 Pi 自己拥有当前轮状态。若无条件在每个 provider 请求前执行：

```ts
context: { ...context, messages: await loadDatabaseMessages() }
```

第二次 provider 请求会丢掉刚产生的 toolCall / toolResult，工具链直接断裂。除非后续把 Pi 的完整当前轮事件也事务化持久化，否则不能采用这种写法。

### 5. 不把 Agent CLI 自己的 session 当作 Pi/SoloMap 上下文

`src/localAgentCliEngine.ts:25-43` 当前明确为 Codex 设置 `--ephemeral`，为 Claude 设置 `--no-session-persistence`；Copilot、Cursor 与 Antigravity 使用各自的 headless/print 调用参数，但源码中没有同名的无会话标志。

实施时必须逐个受支持 CLI family 验证 invocation 不会复用隐藏 session，且不得改成复用任何 Agent CLI 的 native session。模型管道仍然可以把 Pi 的标准 transcript 序列化为 stdin；需要消除的是“把历史塞进单条 JSON user message”，不是消除模型适配器本身。

### 6. 长上下文必须有有界且可验证的治理

切换到 `AgentMessage[]` 后不能继续无限注入全部历史，也不应由 SoloMap 平行维护一套截断策略。正式边界如下：

1. SoloMap 把数据库账本和可用 checkpoint 映射为 Pi Harness `Entry[]`，但不决定 token 阈值、切点、摘要格式或保留尾部。
2. Pi Harness 使用其默认设置完成 token 估算、阈值判断、compaction preparation、摘要生成和 session context 重建。
3. Agent CLI 只是 Harness 摘要请求与正常回答请求共用的模型传输边界，不保存隐藏会话。
4. 完整历史继续留在统一数据库；checkpoint 只能作为可校验、可替换的派生投影，不能覆盖原消息。
5. checkpoint 与成功回答原子提交；冲突重试必须丢弃基于旧修订生成的 checkpoint 并从新历史重算。
6. checkpoint 存储保持一对话一条当前投影，替换内容进入现有清理队列，避免派生摘要形成无界增长。
7. Codex、Claude、Copilot、Cursor、Antigravity 的聊天调用均从 stdin 接收完整上下文，并为每次 provider 请求启动新进程；Codex/Claude 显式关闭会话持久化，其他三类调用不携带 continue/resume/session-id 参数。SoloMap 从不读取或恢复 Agent CLI 会话，Agent CLI 不成为第二份会话账本。

Pi 默认阈值以下保持原消息并且不增加摘要调用；阈值以上的额外一次摘要调用（拆分超大 turn 时可能两次）属于 Harness 的正式 compaction 成本，不由 SoloMap 的字符预算提前触发。

## 影响面

### 必查生产代码

- `src/piAgentEngine.ts`：Pi 类型、消息适配、system/project context、Agent 初始化、prompt/continue、最终回答提取、工具循环。
- `src/intelligenceChat.ts`：数据库历史与当前 user 的分界、失败/冲突/撤销语义；除非证据要求，不改持久化模型。
- `src/extension.ts`：侧边栏创建 engine 并传入项目快照、MCP session 的正式入口。
- `src/telegramRuntime.ts`：Telegram 使用同一套 Store/engine 实现与统一数据库账本的独立运行时入口。
- `src/localAgentCliEngine.ts`：只验证仍保持 ephemeral/stateless provider 边界，非必要不改。
- `scripts/bundle-pi-runtime.cjs`：只有实际使用新的 Pi 导出时才改，并验证最终 bundle。

### 必查测试

- `test/intelligence-chat.test.js`
- `test/pi-agent-engine.test.js`
- `test/intelligence-database.test.js`
- `test/telegram-remote.test.js`
- 与 bundle/VSIX 产物相关的既有验证脚本

### 非本任务范围

- `plan()`、`judgeStrategyPyramid()`、`proposeDelivery()` 等一次性 Pi 调用。
- Solo/Step Agent CLI 的正式交互会话与检查点账本。
- 智能内核 UI 重新设计。
- 引入 Pi 的独立 SQLite session backend。

## TDD 与实施顺序

新会话必须先按 `test-driven-development` 技能工作，不能先改实现再补断言。

### 第一组 RED：证明当前错误语义

新增或改写测试，至少让当前实现因以下断言失败：

- runner 收到的 transcript 中，三轮历史是独立的 `USER:` / `ASSISTANT:` / `USER:` 消息，而不是 `{\"projectContext\":...,\"messages\":[...]}`。
- 历史 assistant 具有 assistant 角色；最后一条 user 只出现一次。
- 当前项目快照位于系统上下文，不出现在用户消息正文，也不写入数据库。

### 第二组 GREEN：完成原生 transcript 接入

- 添加最小消息转换层。
- `initialState.messages` 恢复已提交历史。
- 当前 user 通过 Pi `prompt` 或经验证的 `continue` 进入。
- 删除聊天路径的 JSON 历史包装；保留其他一次性 Pi 调用行为。

### 第三组 RED/GREEN：工具与生命周期

- 一轮内经过至少一次 MCP toolCall 后，第二次 provider 请求仍包含原 user、assistant toolCall 的 id/name/arguments，以及 toolCallId 与之匹配的 `TOOLRESULT`，最终回答正确。
- 下一轮只恢复用户可见历史，不伪造上轮内部工具消息，也不重复最终 assistant。
- 模型失败、取消、Telegram 解绑和提交权撤销不新增账本消息。
- revision conflict 重试不会重复或错序消息。

### 第四组 RED/GREEN：共享入口与长上下文

- 侧边栏首轮、侧边栏续聊、Telegram 续聊都使用相同角色化 transcript。
- Telegram 与侧边栏继续命中同一个 conversation ID 和数据库消息序列。
- 项目切换后使用新项目快照，旧历史不夺取当前项目语义。
- 超长历史在预算内按完整轮次收敛；保留当前 user、最近轮次和必要 system/tool contract，不出现半个工具调用。
- 重复读取与无变化重试不会新增数据库对象或派生 checkpoint。

## 验收矩阵

| 不变量 | 正向证据 | 负向证据 |
| --- | --- | --- |
| Pi 原生角色化上下文 | runner transcript 展示独立 user/assistant 轮次 | 禁止出现历史 JSON envelope |
| 当前 user 唯一 | 最后一条 user 在 Pi state 与 stdin 各一次 | prompt/continue 组合不产生重复 |
| 工具循环完整 | toolCall 后的 CLI stdin 同时包含 assistant toolCall 的 id/name/arguments、匹配的 toolResult/toolCallId、原 user，并得到最终回答 | 不允许只出现 `TOOLRESULT:`，上下文恢复不得覆盖本轮消息 |
| 数据库唯一真源 | 重启式新 engine 可从同一对话恢复 | 不产生 JSONL、第二 SQLite 或 CLI session |
| 原子持久化 | 成功后恰好追加两条用户可见消息 | 失败、取消、撤销时追加零条 |
| 入口一致 | 侧边栏与 Telegram 共用同一 transcript 行为 | 不出现 Telegram 专用上下文实现 |
| 动态项目快照 | 每轮使用当前权威项目 | 快照不入账本，旧项目不成为当前项目 |
| 长上下文有界 | 超长历史仍保留当前 user 与完整最近轮 | 不从工具组中间截断、不静默清空 |
| 隐私与诊断 | 现有脱敏测试继续通过 | 路径、Secret、正文不进入诊断事件 |

## 最低验证与发布门禁

实现完成后至少执行：

```bash
npm run compile
node scripts/run-node-tests.cjs test/pi-agent-engine.test.js test/intelligence-chat.test.js test/intelligence-database.test.js test/telegram-remote.test.js test/local-agent-cli-engine.test.js
npm test
SOLOMAP_CONTEXT_VSIX_DIR="$(mktemp -d -p "$PWD" .pi-native-context-vsix-XXXXXX)"
npm run package:vsix -- --out "$SOLOMAP_CONTEXT_VSIX_DIR/extension.vsix"
```

`mktemp` 在项目根内创建本轮唯一目录，`package:vsix` 会生成并验证其中的 VSIX。验证后只精确删除本轮创建的 `extension.vsix`，再用 `rmdir` 清除该空目录；不得用固定包名，不得覆盖或清理其他轮次的产物。若改动 `scripts/bundle-pi-runtime.cjs`，还必须直接检查新生成的 `out/piAgentRuntime.mjs`：所需 Pi export 存在、模块可导入、VSIX 中包含最终 bundle，且包体增量有解释。最终验收不能只看 TypeScript 源码或测试 mock。

提交前按仓库要求进行独立代码审查，审查范围必须包含完整任务 diff、调用链、所有共享入口和自动发布触发。源代码或测试推送到 `main` 会触发扩展发布工作流；只有本地门禁与审查通过后才允许提交和推送，并跟踪对应精确提交的 CI/发布终态。

## 完成标准

- 智能内核历史以 Pi `AgentMessage[]` 恢复，并由 Pi 原生 transcript 驱动模型和工具循环。
- 聊天路径不再存在 `JSON.stringify({ projectContext, messages })`。
- SoloMap 数据库仍是唯一持久真源，没有新建平行 session 存储。
- 侧边栏和 Telegram 的连续多轮、工具调用、项目切换、失败、取消、冲突和长上下文测试全部通过。
- 最终 bundle/VSIX 消费到实际改动，相关完整测试通过。
- 独立审查无 Critical/Important 遗留；提交、推送、CI/发布、临时夹具与工作树全部闭环。

## 新对话提示词

```text
请实现 SoloMap 智能内核对 Pi 原生对话上下文机制的正确接入。先完整读取并把以下文件作为执行合同：

1. 当前目录适用的所有 AGENTS.md 与 agent.md；
2. /home/ubuntu/project/solopreneur-roadmap/docs/qa/pi-native-conversation-context-handoff.zh.md；
3. 当前代码中的 src/intelligenceChat.ts、src/piAgentEngine.ts、src/extension.ts、src/telegramRuntime.ts、src/localAgentCliEngine.ts、src/db/unifiedDataStore.ts；
4. 当前锁定版本 @earendil-works/pi-agent-core 的 README、agent.d.ts、types.d.ts 和实际 agent.js / agent-loop.js；
5. 通过 solomap_data MCP 按当前目标检索的项目记忆与执行经验。

最终结果是：SoloMap 数据库继续作为智能内核对话的唯一持久化账本；每轮从数据库恢复已提交历史，将它映射为 Pi AgentMessage[]，由 Pi Agent 原生维护 user/assistant transcript 和当前轮 toolCall/toolResult，再把当前用户消息与最终用户可见回答按现有事务语义原子写回数据库。侧边栏与 Telegram 必须继续共享同一链路。

严格保持交接文件列出的不变量与禁止项。不要引入 Pi SQLite session backend、JSON/JSONL 会话文件、第二数据库或 Agent CLI native session；不要把项目快照或内部工具消息伪装成用户历史；不要在 prepareRequest 中每次用数据库历史覆盖当前 context；不要改变 plan、战略判断、文件交付等非聊天 Pi 调用；不要改变 UI 或路线图。对 Codex、Claude、Copilot、Cursor、Antigravity 逐个验证 invocation 和 session 行为并记录证据；任一 family 无法证明不会复用隐藏 session 时，不得宣称本任务完成，也不得静默启用 native session。

先按 test-driven-development 技能写能在当前实现上真实失败的回归测试，证明：历史是独立 Pi user/assistant 消息而非单条 JSON envelope；最后一条 user 不重复；项目快照不进入用户消息或数据库；toolCall 后的第二次 CLI stdin 同时保留原 user、assistant toolCall 的 id/name/arguments 和 toolCallId 匹配的 toolResult，不能只检查 `TOOLRESULT:`；侧边栏与 Telegram 共享同一恢复行为；失败、取消、解绑、revision conflict 不产生重复或半轮消息；超长历史按完整轮次有界收敛且不丢当前 user。

优先使用“已提交历史进入 initialState.messages，当前 user 使用 agent.prompt(userMessage)”的最小实现。只有证据证明不适用时才改用 continue()，并用测试证明最后一条 user 不重复。项目快照作为每轮非持久 system/request context 注入。数据库 schema 第一版保持不变；缺少逐消息时间戳时使用不参与产品语义的稳定运行时映射，不要顺手迁库。

长上下文必须闭环：先测量真实输入并建立预算，第一版使用 Pi transformContext 做不得同步 throw、也不得返回 rejected Promise 的确定性临时投影，保持 leading system、当前 user、完整最近轮次和当前工具组，且不修改 Agent state 或数据库。只有确认原消息未超预算时异常回退才可返回原消息；输入大小未知或已经超预算时必须回退到经过测试的保守有界投影。不要把 harness compaction 当作 AgentMessage[] 的直接替代；只有独立完成 session `Entry[]` 投影、harness `Context` adapter、兼容 Agent CLI 的摘要请求边界和可追溯 checkpoint 合同后才能接入。完整用户历史仍留在 SoloMap 数据库；任何摘要只能是可追溯派生 checkpoint，不能覆盖原消息。若增加 Pi runtime export，验证最终 out/piAgentRuntime.mjs 和 VSIX，而不是只验证源文件。

完成最窄测试后运行 `npm run compile`、通过 `scripts/run-node-tests.cjs` 运行相关聊天与 `test/local-agent-cli-engine.test.js`、`npm test`。在项目根内用 `mktemp -d -p "$PWD" .pi-native-context-vsix-XXXXXX` 创建本轮唯一目录，把其中 `extension.vsix` 作为 `npm run package:vsix -- --out` 的目标；无论成功失败都只精确清理本轮创建的文件和空目录，不得使用固定包名或覆盖既有产物。然后按 requesting-code-review 技能对完整 diff 做独立审查，修复所有 Critical/Important，复验最终候选。按项目规则提交并推送 main；仅当当前正式 SoloMap run 提供稳定 taskId 时才写对应 `SoloMap-Task` trailer，绝不猜测或虚构 taskId。跟踪该精确提交的 CI/自动发布终态。结束前精确清理本轮 VSIX、测试夹具和临时进程，确认工作树状态；任何门禁缺证据都保持进行中，不要宣称完成。
```
