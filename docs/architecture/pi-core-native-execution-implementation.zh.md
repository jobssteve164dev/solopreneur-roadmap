# Pi Core 原生执行落地说明

本文记录 [`pi-core-native-execution-blueprint.zh.md`](./pi-core-native-execution-blueprint.zh.md) 的实现边界、发布门禁和容量验收。它描述当前代码，不替代蓝图中的架构合同。

## 已落地能力

- Runtime 是 `AgentHarness`、`StorageBackedSession` 和 Pi 私有数据库状态的唯一拥有者；侧边栏与 Telegram 只提交、取消和读取结果。
- `solomap.db` 内新增独立的 Pi session、entry、usage、value、list、operation、tool invocation、owner fencing、兼容发布和 conversation cutover 表；用户可见历史仍只由既有 conversation/message 合同管理。
- 受理时冻结 prompt、项目快照、模型、工具 schema、来源、revision 和 Telegram generation。恢复继续同一 operation，不重建动态上下文。
- conversation binding、完整旧历史 seed、branch tip 与首个 operation 受理在同一数据库事务完成，不存在“已绑定但只写入部分历史”的恢复状态。
- storage commit、operation mutation和工具受理都校验 Runtime fencing token；MCP fence 校验、实际业务 dispatch 与提交处于同一个 `BEGIN IMMEDIATE` 写事务，并在提交前再次校验。新 owner 只能在旧事务结束后接管，旧事务若在同连接内失去 owner 则整体回滚。
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

## 工具恢复合同 v1

| 工具 | 分类 | 自动重放 | 依据 |
| --- | --- | --- | --- |
| `list_projects`、`get_current_project`、`get_plugin_settings`、`get_today_review` | 只读 | 允许 | MCP annotation 为 read-only，不产生业务写入 |
| `solomap_search`、`solomap_read`、`solomap_context`、`solomap_memory`、`solomap_experience` | 只读 | 允许 | MCP annotation 为 read-only，读取固定数据库合同 |
| `set_time_schedule` | 写入 | 禁止 Harness 自动重放 | 业务层使用确定性 task ID 和数据库幂等写入；未知结果仍按不可重放收口 |
| `solomap_write`、`solomap_link`、`solomap_export` | 写入 | 禁止 Harness 自动重放 | 调用参数含业务幂等键，键由稳定 invocation ID 派生；重复送达读取同一回执 |
| `solomap_conversation_status` | 写入 | 禁止 Harness 自动重放 | 由正式会话生命周期合同自行绑定身份；Harness 不猜测未知写入结果 |

工具 transport 错误统一作为 `isError` tool result 返回给模型继续判断；错误文本不会被当作成功结果。不可证明安全的写工具不会由 Harness 自动重复执行。

每次工具调用由 Pi invocation ID 绑定数据库 admission。实际 MCP 请求携带 operation、invocation 与 owner generation；Runtime 从最终 fence 校验到业务 dispatch 和数据库提交持续持有 SQLite writer lock，并在 commit 前复验，关闭 check-then-dispatch 接管窗口。

## 容量预算 v1

基准场景使用真实 `AgentHarness + StorageBackedSession` 连续执行 140 轮；每轮包含一次只读工具调用以及 user、assistant、tool result 和 usage 持久记录，并在每轮结算后执行与生产路径相同的自动保留维护，最后执行恢复扫描与完整数据库备份。

| 指标 | 实测 | 上限 |
| --- | ---: | ---: |
| 数据库与索引总增长 | 4,964,352 bytes | 16 MiB |
| 每个含工具调用回合平均增长 | 35,460 bytes | 以总增长门禁约束 |
| Pi entries / retained tool invocations | 560 / 128 | 工具明细自动裁剪 12 条并保持 128 条上限 |
| WAL 峰值 | 4,499,072 bytes | 32 MiB |
| 完整备份体积 | 4,968,448 bytes | 32 MiB |
| 维护临时空间（主库、WAL 与备份合计） | 14,435,968 bytes | 64 MiB |
| 140 轮总耗时 | 36,817 ms | 65,000 ms |
| 恢复扫描 | 0 ms | 1,000 ms |

验收由 `test/pi-capacity-budget.test.js` 执行，超过任一上限即失败。当前主库约 14.5 GB，验证时可用空间约 42.9 GB；本次 schema 是前向增量迁移，不复制主库，也不批量迁移旧会话。

未结算 operation、tool memo、恢复 checkpoint 和当前 branch 必需的 entries 永不参与回收。空闲 session 只有在 Pi 已写入包含 summary 与 retained tail 的原生 compaction entry 后，才把该 entry 安全重置为 branch 根并回收其祖先 entry/usage；没有 compaction boundary 时不删 transcript。settled operation 的 acceptance、terminal、settlement 与幂等 request hash 永久保留，工具 invocation 与 `pi.result` 明细滚动保留最近 128 个终态 operation。`pi_retention_runs` 记录每次边界和累计回收量；用户可见历史不参与该策略。

## 验证入口

- `test/pi-session-storage.test.js`：Pi 官方 Storage conformance 21 项、事务、序列化和重开。
- `test/pi-native-harness.test.js`：同 operation 重开、原生模型重试、工具错误恢复。
- `test/pi-conversation-operations.test.js`：owner fencing 与业务事务竞态回滚、原子历史 seed、持久队列/取消、精确 drain handoff、legacy cutover、Pi terminal 路径结算和 compaction/128-operation 生命周期保留。
- `test/intelligence-database.test.js`：Runtime 单一入口与现有 conversation 合同。
- `test/telegram-background.test.js`：无编辑器后台、接管、代次撤销、重启与交付闭环。
- `test/pi-capacity-budget.test.js`：容量与恢复时间硬门禁。

