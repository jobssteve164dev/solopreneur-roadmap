# Pi Core 原生执行落地说明

本文记录 [`pi-core-native-execution-blueprint.zh.md`](./pi-core-native-execution-blueprint.zh.md) 的实现边界、发布门禁和容量验收。它描述当前代码，不替代蓝图中的架构合同。

## 已落地能力

- Runtime 是 `AgentHarness`、`StorageBackedSession` 和 Pi 私有数据库状态的唯一拥有者；侧边栏与 Telegram 只提交、取消和读取结果。
- `solomap.db` 内新增独立的 Pi session、entry、usage、value、list、operation、tool invocation、owner fencing、兼容发布和 conversation cutover 表；用户可见历史仍只由既有 conversation/message 合同管理。
- 受理时冻结 prompt、项目快照、模型、工具 schema、来源、revision 和 Telegram generation。恢复继续同一 operation，不重建动态上下文。
- conversation binding、完整旧历史 seed、branch tip 与首个 operation 受理在同一数据库事务完成，不存在“已绑定但只写入部分历史”的恢复状态。
- storage commit、operation mutation和工具受理都校验 Runtime fencing token；数据库内 MCP 业务的 fence 校验、dispatch 与提交处于同一个 `BEGIN IMMEDIATE` 写事务，并在提交前再次校验。新 owner 只能在旧事务结束后接管，旧事务若在同连接内失去 owner 则整体回滚。跨编辑器的对话发起边界见下方工具恢复合同。
- 只有数据库中可核验的 `kind=run && status=completed` 结果、从 `fromTipId` 可达的当前 lane tip、settled assistant entry 与非空 final assistant 完全一致，才在一个事务中写入可见 user/assistant 消息对；其他终态不写可见消息。
- Pi 原生 retry、abort、tool replay policy、compaction 和 terminal result 是执行状态机；Agent CLI 只保留为模型传输适配器。
- 同一 conversation 的后续动作先进入数据库持久队列；前一 operation 收口后按顺序晋升，并在任何模型/工具副作用前以当时真实 revision 生成不可变 acceptance。原始排队请求 hash 独立保留，因此晋升前后的网络重试仍返回同一 operation。取消请求先持久化，再传到当前 Harness operation。
- Telegram generation 变化会持久取消该来源的已受理 operation；Runtime 正常关闭或版本接管属于无损交接，不伪造成用户取消，下一 owner 恢复同一 operation。

## 渐进发布门禁

本实现不会在首个兼容发布中直接切流。

1. `0.0.605` 及后续首个被数据库观察到的兼容版本继续运行旧执行路径，但每次请求必须在模型或工具调用前登记 durable legacy operation，最终消息提交与 operation 结算在同一事务完成。
2. 升级服务向旧 Runtime 发出带目标 release/build 的 `drain`。旧 Runtime 停止新受理，等待已接受的 Telegram/控制请求完成，以 `stopped` heartbeat 释放租约，然后为这个精确目标写入结构化 handoff；普通 stop、SIGTERM、任意字符串或仅观察到第二个版本均不能激活。
3. 新 Runtime 只有在自身 release/build 与 handoff 完全匹配、前代 runtime/release/build 均有数据库观察记录、旧 legacy work 已排空时，才原子建立 rollout 状态并开放 Harness。
4. conversation 第一次进入 Harness 时，在事务内递增 cutover generation；存在 `running` 或 `unknown` legacy operation 时拒绝切换。
5. binding 建立后，迟到的旧链路受理和提交永久失败。已经由 Harness 受理的 operation 即使发生降级或重启，也只由 Harness 恢复，不回退旧引擎。

因此，代码能力已经完整落地，但生产切流仍遵守蓝图规定的跨版本兼容窗口；首个发布的职责是建立可证明的排空边界，不以版本号、启动次数或一次部署代替旧进程排空事实。

## Agent CLI 工具执行循环 v1

本轮修复不改变执行架构：Pi Core 仍拥有对话状态、工具生命周期、重试、恢复与终态；Agent CLI 仍是无状态模型传输层，MCP 仍是唯一工具入口。修复集中在 Pi 与 Agent CLI 之间的单轮协议，以及 MCP 结果返回 Pi 的投影边界。

每次模型回合使用两个互斥的 JSON envelope：

```json
{"kind":"tool_call","call":{"name":"工具名","arguments":{}}}
{"kind":"final","content":"给用户的最终回答"}
```

- Codex CLI 通过 `outputSchema` 在传输层约束该 envelope；其他 Agent CLI 由同一 system prompt 与运行时解析器约束。
- 解析器继续接受旧 `{"toolCall":...}` 和纯文本最终回答，保证旧会话与不同 CLI 家族平滑过渡；新 prompt 只教授 v1 envelope。
- 输出看起来是工具协议但 JSON 或字段不合法时，不执行工具。适配层携带原上下文追加一次协议纠错提示，并只重试一次；第二次仍不合法才把错误交回 Pi 状态机。
- 原生 Harness 工具调用 ID 使用 `tool:<operationId>:<sequence>`；兼容直调在没有 operation ID 时生成每请求唯一 scope，不再让不同请求共享固定前缀。数据库 admission 仍使用 Pi 生成的 invocation ID，两者职责不变。

MCP 结果被投影为一个有界的规范对象，完整保留 `content` 中的文本、嵌入资源等内容、`structuredContent` 与 `isError`。结果过大时仍沿用 Pi 的头部截断与明确截断说明；不会因为内容不是 `type=text` 而变成空结果。MCP 返回的错误内容和 transport 异常原因会进入 Pi 的错误 tool result，供下一轮修正参数或向用户解释。

循环保护按语义结果判断，不设置全局工具次数上限：同一 operation 内，只有同一工具、模型给出的同一参数、同一有界规范结果第三次重复时才产生 `tool_loop_no_progress`。MCP 错误与 transport 错误同样参与判断，任一工具、参数或结果变化都会重置连续计数；宿主补入的 invocation 幂等键不改变业务语义。合法的分页、轮询状态变化和长链路不会因为调用次数本身被中止。

工具序号与连续结果状态都从 Pi 已持久化的 tool call/tool result 重建，而不是只保存在当前进程变量里。因此，工具结果已经提交、但提交确认丢失或进程随后重启时，同一 operation 会从下一个序号继续，恢复前的连续重复也仍计入第三次保护。

恢复边界保持不变：Pi session 会持久保存已进入 Harness 的 tool call/tool result，写工具仍由 invocation admission、owner fence 和业务幂等键保护。MCP 外部副作用成功、但进程在结果进入 Pi session 前硬中断的窗口，仍按下方不可自动重放合同处理；本版没有用一份并不与外部系统原子提交的“结果缓存”冒充 exactly-once。

## 工具恢复合同 v1

| 工具 | 分类 | 自动重放 | 依据 |
| --- | --- | --- | --- |
| `list_projects`、`get_current_project`、`get_plugin_settings`、`get_today_review` | 只读 | 允许 | MCP annotation 为 read-only，不产生业务写入 |
| `solomap_search`、`solomap_read`、`solomap_context`、`solomap_memory`、`solomap_experience` | 只读 | 允许 | MCP annotation 为 read-only，读取固定数据库合同 |
| `set_time_schedule` | 写入 | 禁止 Harness 自动重放 | 业务层使用确定性 task ID 和数据库幂等写入；未知结果仍按不可重放收口 |
| `solomap_start_conversation` | 写入 | 禁止 Harness 自动重放 | TG 与侧边栏智能内核共用现有 Step、Solo、Flow 发起入口，保留项目授权、稳定 launch intent 和编辑器启动去重；返回 started 只表示任务已启动 |
| `solomap_get_conversation` | 只读 | 允许 | 按启动回执的 conversationRef 查询当前状态与正式结算结果；省略引用列出当前聊天最近发起的任务 |
| `solomap_write`、`solomap_link`、`solomap_export` | 写入 | 禁止 Harness 自动重放 | 调用参数含业务幂等键，键由稳定 invocation ID 派生；重复送达读取同一回执 |
| `solomap_conversation_status` | 写入 | 禁止 Harness 自动重放 | 由正式会话生命周期合同自行绑定身份；Harness 不猜测未知写入结果 |

工具 transport 错误统一作为 error tool result 返回给模型继续判断；MCP 的 `isError` 内容和实际异常原因会被保留，不会被当作成功结果。不可证明安全的写工具不会由 Harness 自动重复执行。

工具目录新增能力时，已受理 operation 仍只使用受理时冻结的工具集合；新增工具不会使旧 operation 失效，也不会扩大其权限。冻结工具缺失或合同改变时仍拒绝恢复。

每次工具调用由 Pi invocation ID 绑定数据库 admission。实际 MCP 请求携带 operation、invocation 与 owner generation；数据库内工具从最终 fence 校验到业务 dispatch 和数据库提交持续持有 SQLite writer lock，并在 commit 前复验。

`solomap_start_conversation` 在短事务内校验权限与 fence 并预留稳定启动身份，最终权限/fence 校验与同步 `socket.write` 共用另一个短写事务；等待编辑器启动时不持有 writer transaction。新任务沿既有入口拥有独立生命周期，来源聊天失败或取消不得回滚编辑器已确认的任务记录和其他并发写入。

发起与结果追踪共用同一稳定引用。原生调用从受理 operation/fence 绑定聊天，兼容调用端通过宿主传入的 legacy operation 绑定；模型不能选择来源聊天。普通项目 Agent 绑定自身会话，无 run 身份的连接按持久 MCP session 隔离。旧调用端仍可启动及使用原有通知，新聊天追踪由新版宿主传递身份；新增工具不改变旧 operation 冻结的启动工具合同。

查询直接读取当前轮、最新正式结算及固定报告；新轮或修正结果尚未结算时不会返回旧报告。交互会话等待输入与任务完成分别表达，Flow 读取整个流程的权威状态。通知按被结算轮次的固定来源生成，在原结算事务中幂等入队；后续关闭不重复回报，迟到结算不受当前轮变化影响。仅 TG 来源替换普通通知，原绑定失效或项目归档后不投递，也不阻断主结算。

schema 53 的宿主关联索引不进入项目导出，也不接受项目导入。每次启动仅保存一条关联；任务已创建的引用绑定原 run/Flow 对象并随其物理回收；没有创建任务的失败尝试每个来源只保留最近 20 条。容量进入现有数据库空间观测，包含任务关联与失败尝试计数；无新增轮询、周期写入或模型调用，重试与查询不得重复增长任务关联。

启动预留与临时投递登记原子保存，主对象与关联外键也在同一创建事务内写入，硬中断不会留下无法恢复的中间窗口。等待编辑器时只保存按进程出生身份绑定的临时投递占用；完成即释放，Runtime 启动和后续投递时按真实 PID 与出生身份回收死宿主的占用。查询保持只读，仍活跃的投递不受固定超时影响。失败尝试回收跳过仍有真实投递占用的记录，避免并发重试被回收；实际角色执行或流程终态始终优先于旧启动错误。

## 容量预算 v1

基准场景使用真实 `AgentHarness + StorageBackedSession` 连续执行 140 轮；每轮包含一次只读工具调用以及 user、assistant、tool result 和 usage 持久记录，并在每轮结算后执行与生产路径相同的自动保留维护，最后执行恢复扫描与完整数据库备份。

| 指标 | 实测 | 上限 |
| --- | ---: | ---: |
| 数据库与索引总增长 | 5,054,464 bytes | 16 MiB |
| 每个含工具调用回合平均增长 | 36,104 bytes | 以总增长门禁约束 |
| Pi entries / retained tool invocations | 560 / 128 | 工具明细自动裁剪 12 条并保持 128 条上限 |
| WAL 峰值 | 4,593,832 bytes | 32 MiB |
| 完整备份体积 | 5,058,560 bytes | 32 MiB |
| 维护临时空间（主库、WAL 与备份合计） | 14,710,952 bytes | 64 MiB |
| 140 轮总耗时 | 50,974 ms | 65,000 ms |
| 恢复扫描 | 1 ms | 1,000 ms |

验收由 `test/pi-capacity-budget.test.js` 执行，超过任一上限即失败。当前主库约 14.5 GB，验证时可用空间约 42.9 GB；本次 schema 是前向增量迁移，不复制主库，也不批量迁移旧会话。

未结算 operation、tool memo、恢复 checkpoint 和当前 branch 必需的 entries 永不参与回收。空闲 session 只有在 Pi 已写入包含 summary 与 retained tail 的原生 compaction entry 后，才把该 entry 安全重置为 branch 根并回收其祖先 entry/usage；没有 compaction boundary 时不删 transcript。settled operation 的 acceptance、terminal、settlement 与幂等 request hash 永久保留，工具 invocation 与 `pi.result` 明细滚动保留最近 128 个终态 operation。`pi_retention_runs` 记录每次边界和累计回收量；用户可见历史不参与该策略。

## 验证入口

- `test/pi-session-storage.test.js`：Pi 官方 Storage conformance 21 项、事务、序列化和重开。
- `test/pi-native-harness.test.js`：同 operation 重开、提交确认丢失后的工具循环恢复、原生模型重试、结构化回合协议、协议纠错、完整 MCP 结果投影、稳定调用 ID、工具错误恢复与语义空转保护。
- `test/pi-conversation-operations.test.js`：owner fencing 与业务事务竞态回滚、原子历史 seed、持久队列/取消、精确 drain handoff、legacy cutover、Pi terminal 路径结算和 compaction/128-operation 生命周期保留。
- `test/intelligence-database.test.js`：Runtime 单一入口与现有 conversation 合同。
- `test/telegram-background.test.js`：无编辑器后台、接管、代次撤销、重启与交付闭环。
- `test/pi-capacity-budget.test.js`：容量与恢复时间硬门禁。

