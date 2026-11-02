# SoloMap 交互与 Runtime 并发架构纠偏蓝图

更新：2026-11-02。本文以 SoloMap 当前已有的全部产品能力、真实 57 项目和 19GB 权威库为输入，重新设计插件的交互、数据、调度和后台执行架构。这不是在现有串行链路上减少几次查询或增加超时，而是建立新主链、完成整体切换并退役旧主链。

本文不改变《SoloMap 单一数据库实施与验收蓝图》定义的产品能力、数据语义和文件边界；它取代其中“一个 Runtime 同步执行所有操作”和“Webview 消费全量状态投影”的实施方式。

## 1. 最终用户结果

SoloMap 是用户推进项目和发起 Agent 工作的行动工具。目标架构必须保证：

- 从任何入口发起对话时，用户动作立即进入独立前台链路，不等待项目组合、日评、账户、统计、Git、远端信号、迁移、诊断或 UI 全量渲染。
- 一个项目的慢查询、Git 仓库、远端接口或后台 Agent 不能拖慢其他项目的打开、切换、输入和发起。
- 数据库保持一个权威写入者和提交后即时可读，但读取、投影、网络、Git、渲染和维护不再与写入者共用一个同步事件循环。
- 缓存、降级、诊断和超时只服务主结果；不允许用“更早失败”代替“真正启动”。

## 2. 现实负载与已观测事实

### 2.1 生产规模

2026-10-31 只读核对：

- 正式项目注册表包含 57 个项目。
- `solomap.db` 为 19,386,109,952 字节，WAL 约 16MB。
- 当前宿为 4 vCPU、23GiB 内存；采样时 Runtime 约占 48% CPU，Extension Host 约占 18% CPU，并存在多个 Git 子进程。
- Sidebar 可消费项目卡片、路线图、对话、Issue、PR、交付、安全、投入统计、日评、账户、设置、数据概览、Agent 影响、协作和迁移状态。
- 当前 Sidebar Webview 处理至少 55 类宿主消息，Extension 共享动作面约 86 类命令，Runtime 数据服务共有 237 类显式注册操作。

### 2.2 对话阻塞时序

`ui:mvwd2yvq:4db1efac-80ca-4b52-b994-36953e65d83a` 的正式诊断：

1. Webview 在 `12:12:33.686` 创建对话动作。
2. Extension Host 首次在 `12:13:35.675` 收到该动作，入口前已等待约 61.99 秒。
3. Host 收到后 8.25 秒启动 Agent 进程，首段输出随后约 0.59 秒到达。
4. 同一 interaction 每约 5 秒重试，后续成批到达 Host；持久幂等防止了重复 Agent，但没有修复用户入口延迟。

结论：Agent CLI 不是该次 62 秒等待的主阻塞点；主阻塞在 Webview 动作与 Host 处理之前的共享交互基础设施。

### 2.3 共享通道拥塞

最近 1000 条 operation 诊断中，最近 6 小时的 997 条包含：

- `sidebar.action.getDailyReview` 460 条。空闲时每 30 秒轮询，运行时每 2.5 秒轮询。
- `sidebar.action.conversation.runSolo` 104 条，包含同一动作的交通重试。
- `settings.delivery` 有 263–361 秒投递，`database.overview.delivery` 有 263–334 秒投递，`agentImpact.delivery` 有 240–489 秒投递。
- `agentImpact.read` 多次耗时 16–24 秒。

这些 `delivery` 阶段围绕同一 `webview.postMessage` 边界。因此“对话确认也走同一通道”是结构性错误，不是多等几秒可以解决的慢查询。

## 3. 现架构全链路审计

| 执行域 | Observed in code | 设计缺陷 | 直接后果 |
| --- | --- | --- | --- |
| Webview 用户动作 | 发送 `conversation.runSolo` 后同一 JS turn 立即调用 `renderPortfolio` | 发送与整个组合区重建耦合；消息离开 Webview 前可被同步渲染拖延 | 用户点击已发生，Host 长时间看不到 |
| Webview 入站消费 | 一个 `window.message` switch 同步合并数据、重算组合并重建 DOM | 没有消息优先级、帧预算、稳定键局部更新和输入抢占 | 背景投影可占用浏览器事件循环 |
| Webview 交通 | 前台确认、设置、统计、数据概览和所有项目数据都直接调用 `postMessage` | 没有统一 broker、队列上限、取消、合并、可见性订阅和前台保留容量 | 大负载形成队头阻塞，确认也无法越过 |
| Extension Host 动作分发 | Sidebar 先进入通用 async `dispatchSharedAction` | UI 入口、数据动作和长任务缺少独立网关 | 一个交互宿主同时承担业务、数据和 VS Code API 调度 |
| Sidebar 项目投影 | 选中项目后仍顺序读取其余所有项目对话；每个项目可发送 solo/project/flow/revision 四组数据 | 把“当前可见项目”错设成“全部项目预热”；无背压 | 57 项目引入 N+1 查询与消息放大 |
| 项目增强 | 每项目读投入、可复用源、文档和活动；四类外部信号另起队列 | 一次 Sidebar 打开发展成全组合后台重算 | CPU、DB、Git、网络和 UI 更新互相放大 |
| Runtime RPC | 每请求新建 TCP 连接；优先级调度器从队列选择下一项 | 没有长连接多路复用、取消、截止时间传递和资源隔离 | 调度标签无法保证真实资源优先级 |
| SQLite owner | `DatabaseSync` 和全部域操作在同一 Runtime 事件循环执行 | 虽然 RPC promise 可交错，任何同步 SQL/序列化/文件工作都会阻塞全 Runtime | 优先级不可抢占，长读和维护放大前台延迟 |
| 诊断 | operation/error 记录通过同一数据操作持久化 | 可观测性与被观测的前台工作竞争写入 | 负载越高，诊断越多，反过来继续放大负载 |
| 测试 | Webview `postMessage` 在回归中通常立即 resolve | 没有真实通道阻塞、大投影、浏览器长任务和 57 项目压力 | accepted/settled 状态机可全绿，真实用户仍等待一分钟 |

### 3.1 为什么会被设计成串行链路

这不是 SQLite 或单库天然要求，而是四个架构概念被错误合并：

1. 把“一个权威写入者”误解成“所有读写、投影、诊断和维护只能由一个事件循环执行”。单一权威约束提交顺序，不约束只读计算、外部 IO 和 UI 投影必须串行。
2. 把“一个统一产品状态”误解成“每次都构造并推送一个全量状态对象”。统一用户心智不要求全量快照；正确实现是稳定实体、revision 和按需 delta。
3. 把 JavaScript `async` 误当成资源并行。同步 SQLite、JSON/DOM 构造和同一 Webview 通道即使包在 Promise 中，仍共享一个不可抢占事件循环。
4. 用优先级标签代替物理隔离。只要前台与后台仍争用同一连接、同一线程或同一投递 promise，调度器只能决定“下一个开始谁”，不能让已经开始的长工作让路。

数据库架构升级扩大了权威库、查询和投影的覆盖面，却没有同时重划执行域；于是原本分散的成本被集中到一条宿主链上。根因不是“数据库太大”，而是把一致性边界扩大成了执行串行边界。

## 4. 目标拓扑

```mermaid
flowchart LR
  UI[Webview UI] <--> UIG[UI Gateway / Broker\nExtension Host]
  UIG --> INGRESS[Foreground Action Ingress]
  INGRESS --> LAUNCH[Conversation Launch Coordinator]
  LAUNCH --> TERM[VS Code Terminal Adapter]
  LAUNCH <--> RPC0[Foreground RPC Channel]
  LAUNCH -. detached .-> NATIVE[Provider Native Observer]

  RPC0 <--> SUP[Runtime Supervisor]
  SUP --> WRITER[Single Write Actor]
  SUP --> CPROJ[Versioned Control Projection]
  SUP --> IREAD[Reserved Interactive Reader]
  SUP --> BREAD[Background Read Pool]
  SUP --> INTEL[Intelligence Execution Worker]
  SUP --> TELEGRAM[Telegram Channel Worker]
  SUP --> CLI[Supervisor-owned Agent CLI processes]
  INTEL --> CLI
  INTEL --> IREAD
  INTEL --> WRITER

  BG[Projection / Schedule / Migration] --> BREAD
  BG --> WRITER
  EXT[Git / Network Workers] --> BG
  NATIVE --> WRITER

  WRITER --> DB[(solomap.db WAL)]
  WRITER --> CPROJ
  IREAD --> DB
  BREAD --> DB
  WRITER --> INVALIDATIONS[Durable Projection Invalidation Ledger]
  INVALIDATIONS --> BG
  BG --> INVALIDATE[Small Revision Invalidation]
  INVALIDATE --> UIG
```

### 4.1 进程与责任边界

#### Extension Host

只保留必须使用 VS Code API 的责任：

- Webview 创建与 UI 命令网关。
- 终端创建、显示、输入交付和宿主事件观测。
- 编辑器命令、本地文件选择和 SecretStorage 适配。
- 一份小型、只读、有 revision 的当前项目/设置路由快照，仅用于快速验证和路由。

Extension Host 不再执行：

- 全项目数据库聚合。
- 全项目 Git 扫描或远端信号刷新。
- 大对象快照构建。
- 数据库维护、迁移、诊断批量写入。

#### Runtime Supervisor

- 拥有 Runtime 发现、版本交接、身份、健康和子进程生命周期。
- 提供持久化多路 RPC，至少分为 foreground、interactive-read、background 三个逻辑通道。
- 持有由 Writer 在提交后发布的轻量、带 revision 的控制投影；控制面当前状态读取不再穿越 worker thread 和 SQLite，显式历史 revision 仍回到数据库权威读取。
- 除控制投影外只做路由、截止时间、取消和子进程健康管理，不执行同步 SQL 和长时间业务计算。

#### Single Write Actor

- 唯一可写 SQLite 连接，保留现有事务、外键、revision、幂等和即时回读合同。
- 只接受已验证的 command；query 不经过写 Actor。
- 前台 command 在队列中拥有保留容量。后台工作必须分块，每个事务有最大执行预算，块与块之间让行。
- 网络、Git、Agent 调用、全文序列化、备份压缩和大文件读取不得位于写事务内。

#### Read Processes

- 使用 SQLite WAL 上的独立 read-only 连接，不使用 active database 不适用的 immutable 模式。
- 4 vCPU 正式默认为一个保留交互读进程和一个后台读进程；不根据项目数量无界增长。
- 交互读进程只处理当前用户动作和当前可见作用域。后台读进程不能占用该席位。
- 查询必须有截止时间、返回上限、页面/实体键和 revision；超大全量结果改为分页或持久投影。

#### Projection / External Workers

- 从写事务原子推进的持久化 projection source revision 读取变化，合并重复失效并增量更新项目摘要、日评、统计和其他读模型。
- 不以 Sidebar 打开为触发全量重算的条件。
- Git 与网络使用分开的有界 worker；项目可见、用户手动刷新和后台刷新使用不同优先级，但不能占用前台 DB 读进程。

### 4.2 已落地的正式执行主链

截至 0.0.639，代码中的正式主链已完成以下切换：

- Runtime Supervisor 不持有 SQLite 连接；一个 Writer Actor 串行处理短事务，前台、交互和后台 Reader 使用独立只读连接池，Git、网络、维护计算和 Intelligence 各有物理隔离执行器。
- 公共 RPC 与 Worker 内部回流共用同一个优先级调度器；Worker 不能绕过准入直接占用 Writer、Reader、Git 或网络执行器。
- 项目注册表当前态由 Writer 在事务提交后、mutation 回执返回前发布到 Supervisor 的单调版本控制投影；Runtime 启动先从 Writer 权威水合。普通控制读取直接命中投影，条件读取保留，显式历史 revision 回到 Writer 查询，因此数据库仍是唯一权威而控制面不再承担一次额外跨线程 SQL 往返。
- 生命周期证据写入使用 `runtime-event` 保留域；前台控制读取持续到达时也不能饿死已接受动作的 launch、first-output 和 Provider ingress 证据。诊断读取仍属于后台域。
- `admit_intelligence_message` 只在 Intelligence Execution Worker 执行。Worker 在返回持久回执前先把 ingress 写入 Writer，并在自身取得自动执行责任；客户端后续 `await_intelligence_message` 只观察/加入同一 operation，不再负责触发执行。正常模型失败写入 durable `failed` 终态并推进同一对话下一条，Worker/Runtime 关闭留下的非终态由替代 Worker 恢复。同一对话按持久化顺序推进，不同对话并行。
- Intelligence 模型执行和 Agent CLI 调用分别使用双槽 FIFO permit；释放槽位时直接把许可转交给最早等待者，新请求不能插队。同一 conversation 仍由持久 lane 严格保序，不同 conversation 才并发。准备失败保留 durable `retry_at/last_error`，恢复调度始终选择每个 conversation 队头中的最早截止时间；取消未来队头后立即重算新队头，不等待旧 timer。
- Pi 会话批次使用持久化提交回执；Worker 在提交响应丢失后可以按同一提交身份重放，而不会重复追加会话状态。工具结果在模型看到前先跨过同一持久化 fence；MCP structured error 和 transport error 也写入 durable `isError` receipt，再作为 Harness 错误结果交回模型，因此重启恢复不会重放可能有副作用的工具。
- Agent CLI 进程由不可重启的 Supervisor 持有；可重启 Worker 只发送调用协议。stdout 使用调用专属 8MiB 环形磁盘 spool、异步 partial read/write、流式背压和有界尾部读取，不再在 Supervisor 堆中无界拼接；语义输出上限仍在进程自然完成后判定，不用提前杀死进程代替结果。临时目录携带 PID 与进程启动身份，下一 Runtime 只精确回收死亡 owner 且目录中仅含预期文件的产物。Worker 异常退出时 Supervisor 取消并等待实际子进程退出，再允许替代 Worker 接管。
- 版本交接使用可回滚的两阶段协议：第一阶段保持 Control Server 可服务，仅由执行域内部 `drain_intelligence` 停止新 Intelligence 准入并等待 detached active/submission/recovery；已经在远期 backoff、但尚未执行的 ingress 立即让给替代 Worker。第一阶段成功后才不可逆关闭控制面；失败时先恢复 Intelligence recovery，只有恢复成功才恢复原持久 pause 状态和 Runtime 调度器，补偿失败不得把控制面标成 running/paused，但仍保留控制端点供后续重试。只有内部排空及其余交接阶段全部成功才签发 compatibility drain proof；失败时旧 Runtime 不 interrupt、不关闭执行域、也不退出杀死活跃模型。`await_intelligence_message` 是可安全重放的观察 RPC，响应 socket 背压不参与交接完成条件。
- `start_conversation` 使用“Writer 预留 → External Worker/Runtime Supervisor 调用编辑器 → Writer 确认”的三段链路。编辑器调用、Agent 模型调用和 MCP 外部 I/O 不再占据 Writer 邮箱。
- Intelligence 保留/压缩属于 Maintenance lane，并在用户结果返回后异步执行；它不能延迟已完成回答。
- Solo 前台发起以数据库持久回执作为清空草稿的边界；仅收到内存接受通知不会丢失用户输入。
- Telegram 轮询、投递、Pi 会话和频道租约由独立 Telegram Channel Worker 持有；授权、绑定、停止等必须使用 VS Code API 的动作通过 Supervisor 内存端点转发，Worker 不复制也不读取另一线程的端点表。

这些是当前实现事实，不是后续蓝图。正式生产库负载门已于 2026-11-02 对冻结候选通过，容量和时延证据记录在第 12、13 节。

## 5. 数据和一致性模型

### 5.1 Command / Query 分离

所有 Runtime 操作必须分类：

- `command`：改变权威状态，由 Write Actor 事务执行。
- `interactive_query`：服务当前用户动作，由保留 Reader 执行。
- `background_query`：聚合、投影、迁移核对和后台分析，由后台 Reader 执行。
- `external_job`：Git、HTTP、Agent 分析和文件生成，由对应 Worker 执行；仅最终提交进入 command。
- `maintenance`：迁移、备份、存储回收和索引维护；文件哈希、规范化序列化等重计算由专用 Maintenance Compute Worker 分块执行，数据库提交只回到 Write Actor，不允许与前台争抢保留 Reader。

操作分类是显式注册表，不再用正则对操作名推测优先级。未分类操作不能启动 Runtime。

### 5.2 读模型

- Sidebar core 是正式增量读模型，不是视图级 JSON 快照。
- 项目列表只返回卡片摘要和 revision；当前项目的路线图、最近对话、Issue/PR 细节按可见作用域读取。
- 不在打开 Sidebar 时读取 57 个项目的全部对话、文档、投入和外部信号。
- 同一实体投影使用 `entityKey + revision`；旧 revision 可进入缓存，不得更新当前 UI。
- 对于日评、Agent 影响和数据概览，投影完成后发布 revision invalidation，Webview 在相应面板可见且空闲时拉取 delta；不再定时全量轮询。

### 5.3 提交与投影

- 权威 command 事务在业务表变化时，由数据库触发器原子推进对应投影的 `source_revision`；同一实体的重复变化在持久状态中自然合并。
- command 回执在事务提交后返回；回执携带 authority revision。
- 投影 Worker 只读取 `source_revision > projection_revision` 的待处理实体，幂等提交对应 `projection_revision`；异常退出后从这份持久差值继续，而不是重扫项目文件。
- UI 可立即使用 command 回执更新动作结果，不等待全组合投影。后续 projection delta 只合并衍生字段。

## 6. UI 协议与渲染架构

### 6.1 消息协议

每个消息都有：

- `protocolVersion`
- `messageId`
- `interactionId` 或 `subscriptionId`
- `lane`: `foreground | interactive | background`
- `entityKey`
- `revision`
- `deadlineAt` 或明确无用户截止时间
- `supersedesKey` 用于合并可被新版取代的后台更新

不再允许业务模块直接调用 `webview.postMessage`。所有 Host → Webview 消息经 UI Broker：

- foreground 回执和失败不合并，按 interaction 保序。
- interactive 查询结果按 `entityKey + requestId` 保序。
- background 更新按 `supersedesKey` 只保留最新 revision，只在无 foreground 待发且 Webview 有容量时投递。
- 不投递不可见面板的大负载，只投递小型 invalidation。

### 6.2 Webview 事件循环

- 用户点击处理器只构建已冻结输入、调用 `vscode.postMessage` 和对当前控件做 O(1) 的本地状态修改。
- 发起对话后不得在同一 JS turn 重建 portfolio、任务列表或对话历史。
- 入站 background delta 进入客户端调度器，每帧有 CPU 预算；检测到待处理输入时立即让行。
- 项目卡片、对话、Issue 和状态使用稳定键局部 patch，不再用整个 `portfolioList.innerHTML` 重建作为普通更新机制。
- 长列表只渲染可见窗口和必要缓冲区；用户草稿、焦点、选区和滚动状态归稳定实体节点所有。

## 7. 对话发起正确主链

```text
T0 Webview 点击/Enter
  → 冻结 project/input/agent/model/attachments/interaction budget
  → 立即 post foreground command
  → O(1) 标记本地“正在开始”

Extension Foreground Ingress
  → 同步验证协议和内存路由快照
  → 登记 interaction single-flight
  → 立即发 transport-received
  → 启动 Launch Coordinator，不经过通用 UI action 队列

Launch Coordinator（并发分支）
  ├─→ VS Code Terminal Adapter 创建并显示本次专属终端
  ├─→ Runtime foreground command 持久接收本次启动意图
  └─→ Interactive Reader 并行读取当前项目最小启动上下文

前台持久化与终端交付就绪
  → Write Actor 一个短事务 claim/prepare run
  → 共享 runner 向已有终端交付命令
  → UI 收到 started，用户动作返回

与前台返回并行
  ├─→ Provider 冷启动并产生真实 task-ingress
  ├─→ Native Observer 绑定官方会话和原生 turn
  └─→ Write Actor 短提交收据、诊断和后续生命周期状态
```

硬性不变量：

- 主链不读 portfolio、daily review、agent impact、database overview、其他项目对话或外部信号。
- 所有入口使用同一 `LaunchRequest` 和 `LaunchCoordinator`，入口不自建准备/终端/调度特例。
- 接收、持久化接受、终端就绪、runner claim、Provider ingress 是不同阶段，不能用前一阶段冒充后一阶段。
- 持久化接受和唯一 runner 正式命令提交闭合“发起”动作；Provider ingress 仍是必须最终取得的真实性证据，但外部 CLI、网络和模型冷启动不得占据同步返回链。
- 发起失败时原始输入可恢复；成功只启动一个任务；重试复用 interaction identity。
- 不通过提前超时、取消数据完整性或跳过启动准备来达到延迟目标。

## 8. 其他当前产品需求的路由

| 工作类型 | 正式执行域 | UI 数据方式 | 不得阻塞 |
| --- | --- | --- | --- |
| 项目切换 | Foreground Ingress + Interactive Reader | 当前项目 core delta | 全项目投影、外部信号 |
| 路线图与当前任务 | Interactive Reader | 当前项目 revision snapshot/delta | 投入统计、GitHub |
| 设置读写 | Interactive Reader / Write Actor | 字段 revision patch | 能力探测、账户刷新 |
| Issue/PR 动作 | Foreground command + External Worker | 动作回执 + 实体 delta | 其他项目信号 |
| 日评/战略/Agent 影响 | Background Projection / Agent Worker | 可见时拉取最新 revision | 插件打开、对话、项目切换 |
| 外部信号 | Network Worker | 最后成功投影 + 实体 delta | 本地卡片和任何输入 |
| Git 读取/证据 | Git Worker | 运行或项目级 revision | Extension Host 事件循环 |
| Telegram/调度/通知 | Runtime Background Workers | 持久状态和投递事件 | UI foreground lanes |
| 迁移/备份/回收 | Maintenance Compute Worker + Write Actor commit | 按需进度 delta | 所有前台动作和交互 Reader |
| 诊断 | Runtime Event → Write Actor；读取走 Background Reader | 仅明确打开诊断面时查询 | 任何被观测的业务工作；控制读取不得饿死生命周期证据 |

## 9. 资源、并发与背压

### 9.1 发布验收预算（4 vCPU / 16GiB cgroup）

- Write Actor：1 进程、1 写连接。
- Writer 同时最多接纳 8 项，其中辅助域最多占 6 项；至少 2 个活动席位结构性保留给用户前台、交互、订阅和 Runtime 事件。等待队列按用户域优先，不依赖辅助任务主动让行。
- 当前项目注册表等轻量控制读取由 Supervisor 版本投影完成；前台保留窗口不会因为这种 O(1) 读取持续到达而无限续期，已经接受的 Runtime 事件在同一窗口内仍可推进。
- Interactive Reader：1 进程、1 读连接，只服务用户动作。
- Background Reader：1 进程、1 读连接；Runtime 同时只接纳 2 个后台查询，其余请求保留在有界队列中，不能用调用方数量放大 CPU、I/O 或 SQLite 压力。
- Git Worker：全局最多 1 个活动 Git 重操作，用户明确动作可在队列前置，不中断已在写工作区的安全操作。
- Network Worker：默认 2 个并发，按 host 和 credential 另有限制。
- 后台 Agent：与用户交互 Agent 分开并发槽；后台 Agent 不占用用户启动槽。

这些是基于当前正式宿的起始值，必须通过压力测调整；不允许用项目数量直接扩大进程数。

### 9.2 背压和取消

- 每个队列都有显式容量、合并键、截止时间和溢出行为。
- 前台 command 或 interactive query 仍在排队等待准入时，新的 maintenance 先让出下一次准入；已经准入且可能跨域等待的前台工作不会冻结维护域，避免形成“前台等待维护、维护等待前台结束”的环形依赖。已接受的事务按合同完成。
- 后台刷新以 `project + signalKind` 合并；重复请求只保留最新意图，不累积为无界队列。
- UI background delta 以 `view + entityKey` 合并。用户离开面板时撤销订阅和未投递大负载。
- 取消只撤销尚未提交的读取/投影/外部工作；已接受的权威写入按幂等合同完成或明确失败。
- 队列溢出时先丢弃被新 revision 取代的后台投影；不丢弃用户 command、已提交回执或恢复必需事件。

## 10. 时限与可反证验收

### 10.1 对话主链

- click/Enter → Webview 完成 `postMessage`：p95 小于 16ms，单次小于 50ms。
- click/Enter → Host foreground ingress：p95 小于 100ms，发布硬上限 250ms。
- click/Enter → 持久接受与专属终端可见：正常目标 1s，发布硬上限 2s。
- click/Enter → 唯一 runner 正式命令持久提交并向用户返回：正常目标 5s，发布硬上限 10s。
- Provider task ingress：持续记录真实 Provider 开始时延与观察时延，必须最终与同一 interaction/run/turn 闭合；超过 10s 记录 Provider 冷启动 SLO，不得反向把已经完成的发起改判为失败。
- 在同时运行全项目后台刷新、日评、Agent 影响、数据概览、迁移检查和诊断持久化时，前三项前台上限不变。

### 10.2 资源断言

- 发起一次当前项目对话时，其他 56 个项目的 DB 查询数和 Webview 负载必须为 0。
- Sidebar 空闲 10 分钟不产生定时全量读取；只有状态变化事件或用户动作可触发查询。
- background 队列在重复不变输入下保持有界，同键任务不随时间累积。
- Write Actor 长任务分块后，任意前台 command 等待当前不可抢占事务的时间有明确上限。
- UI Broker 不存在无界待投递消息；后台更新可合并，前台事件可追踪且不丢失。

## 11. 故障、恢复与升级

- Supervisor 监测 Writer/Reader/Worker；某个 Reader 或外部 Worker 崩溃不影响权威写者和其他读者。
- Write Actor 失去时，新 command 保留原始输入并显式恢复；不退回旧文件写入或第二数据库。
- Reader 失去时可重建连接并从 authority revision 恢复；不会影响已提交 command。
- Projection Worker 重启后从持久化的 `source_revision > projection_revision` 差值幂等续读；不扫描项目文件来猜测丢失变化。
- Runtime 版本交接对控制端点使用有界 handoff：旧 Supervisor 立即停止新准入并释放 socket/lease，已耐久接受的 Intelligence ingress 保留为非终态，由替代 Worker 恢复；不能让一个外部模型调用无限占有旧端点。
- 数据库 generation 在创建时写入精确 reclaim manifest；启动期同时恢复有 cutover journal 的 generation，并按设备、inode、mtime 和清单逐项回收没有活动 journal 的孤儿 generation，硬崩溃不能永久遗留一份 19GB 副本。

## 12. 实施与旧链退役

这是一个目标架构切换，不是长期双轨。实施可在开发期分包，但发布候选必须只剩一条主链。

### 12.1 2026-11-02 实现审计状态

下表只记录代码中已经观察到的事实。所有发布阻断项都必须以新主链成立、旧链退役和对应验收证据共同判定为已切换。

| 架构面 | 当前状态 | Observed in code | 退役/完成条件 |
| --- | --- | --- | --- |
| Webview 发起动作 O(1) | 已切换 | Solo、Step、Flow、Continue 发送路径不再在同一 turn 重建 portfolio；附件清理由稳定 DOM 节点完成 | Chromium 回归持续证明发送不调用组合区渲染 |
| Host → Webview UI Broker | 已切换 | `panelMessages.ts` 统一协议封装；foreground 可越过未完成 background；同键 background 只保留最新 revision；声音投递也进入 broker | 生产代码不存在业务 `webview.postMessage` 直投 |
| 空闲日评轮询 | 已退役 | Sidebar 不再创建 2.5 秒/30 秒轮询；仅首次可见、状态失效或用户动作读取 | 10 分钟空闲压力下日评查询数为 0 |
| Runtime RPC | 已切换 | 数据 RPC 按执行域使用相互独立的认证长连接；同一域内按 `requestId` 多路复用并允许乱序回包，交互响应不再排在后台大帧之后；run-index 等大结果强制最多 200 条一页；断线后只重放安全操作，旧 Runtime 排空已接受工作后交接 | 重启、断线、单次子进程、分域并发、安全重放、旧版交接与认证回归全部通过 |
| Runtime 操作分类 | 已切换 | 237 个操作进入显式 registry；每项分别声明 kind、lane/domain、executor affinity、replay policy 和 authority；外部 RPC、Telegram、Intelligence、Conversation、Network、Autonomy 和 Sidebar 订阅遇到 Supervisor affinity 时统一进入同一个 Supervisor dispatcher，不再由各 Worker 维护特例；active Runtime 的独占 `VACUUM` 操作已撤出注册表，未注册操作在生产控制面拒绝 | 新增操作必须同时声明五维合同并通过完备性测试；所有 Supervisor 操作只能进入统一 dispatcher |
| Runtime 统一准入 | 已切换 | Supervisor 只创建一个 `RuntimeExecutionScheduler`，外部 RPC、Telegram、诊断、自治循环和内部 Writer 控制任务共享同一准入面；端点发布前先完成所有请求依赖的有界恢复，历史迁移、报表回填、存储回收和规划统计留在端点发布后的 maintenance；报表历史每 100 条释放 Writer，规划统计从自治主循环移除并在迁移完成后的 30 秒空闲窗口尝试 | 禁止新增绕过统一准入面的端点发布后 Writer 工作；不可抢占维护必须移出启动主链，可分片维护必须在每一片后重新参与准入 |
| 前台 Writer 保留 | 已切换 | Writer 仍保持单线程事务权威，但活动邮箱按用户域优先；辅助请求最多占 6/8 个活动席位，至少 2 个席位留给前台、交互、订阅和 Runtime 事件；内部子操作继承父 admission domain | 八个慢辅助请求同时跨域等待时，新的用户持久化准入仍可进入保留席位 |
| 交互读/后台读 | 已切换 | 两个独立 worker thread、两个 SQLite read-only 连接；交互读与后台读物理分开；依赖 Runtime 内存的 query 明确留在 Supervisor，不再误投只读 worker | 真 WAL 长读压力下交互读仍满足时限 |
| Supervisor 控制投影 | 已切换 | 项目注册表当前态由 Writer 提交后发布版本投影，mutation 回执不会早于投影；Runtime 启动从数据库权威水合；条件读取在投影内完成，显式历史 revision 回到 Writer；旧 revision 不能覆盖新状态 | 控制读取保持 O(1)，数据库继续是唯一权威，写后读与历史回读持续通过 |
| 外部/维护执行器 | 已切换 | Git 与网络分别由独立 Worker 承担，容量固定为 1/2；备份、导出与回收候选的大文件哈希及 canonical 序列化进入独立 Maintenance Compute Worker；所有数据库提交仍回到唯一 Write Actor | 拓扑、容量、维护期间前台提交和文件计算委派回归持续通过 |
| 唯一写入者 | 已切换 | Supervisor 运行期不持有 SQLite；独立 Write Actor 唯一持有可写连接并拥有 command、session/fence、智能对话、迁移、恢复和维护提交；Reader、External、Projection 均为 read-only | 持续以进程拓扑和真实 WAL 压力回归守住唯一写入者不变量 |
| Sidebar 首屏 | 已切换 | 立即投递无 IO placeholder；只恢复选中项目缓存对话；随后一次读取正式 core projection，不再在视图打开时扫描全部项目或路线图文件 | 真实 57 项目验收首屏只传卡片投影与选中项目数据 |
| Sidebar 增量读模型 | 已切换 | schema v58 的正式投影包含 foundation、reusable、investment、documentation、recent activity 与 learning；业务表和 `project_locations` 触发器原子推进 source revision；独立只读 Projection Worker 只重算变更项目，Write Actor 校验 revision 后提交；Sidebar 只消费投影；旧视图侧 projection pool 与 snapshot reserve/commit API 已不可调用 | 新增卡片字段必须先进入同一 projection/delta 合同，禁止恢复 Extension Host 逐项目读取 |
| 数据库总览计数 | 已切换 | schema v64 使用单例持久投影保存 `contents` 精确计数、扫描高水位和完成状态；新增/删除由事务触发器同步维护，历史 19GB 数据由 Writer 在前台空档按有界 rowid 页可恢复回填；设置页在完成前只显示“计算中”，读取路径不再执行 `COUNT(*)` 全表扫描 | 总览读取必须保持 O(1)；历史回填必须可中断续跑且不得抢占前台资源 |
| Git/网络执行域 | 已切换 | `resolve_project_repository` 固定进入单并发 Git Worker；`refresh_project_signal` 固定进入双并发 Network Worker；二者拥有不同 thread、队列和故障边界，最终缓存提交仍经 Write Actor | 新增外部项目读取必须显式选择 Git 或 Network affinity，不得回到 Extension Host |
| Launch Coordinator | 已切换 | Solo、Step、Flow、Continue、路线图调整、Retry、调度、自动化、经验复盘、Agent review/revision 与维护 Agent 均进入同一并发协调器；恢复投递复用同一准备/交付合同但不创建冗余预热终端 | 新增 Agent 入口必须复用 Coordinator、interaction identity、幂等和 task-ingress 阶段合同 |
| Launch / Provider 并行边界 | 已切换 | 唯一 runner 命令持久提交后同步发起立即返回；task-ingress 观察按 interaction/run/turn single-flight 后台执行，10 秒观察 SLO 只记诊断，不写交付失败、不释放 runner、不阻断续聊投影；后到原生收据继续闭合真实生命周期 | 所有入口都必须证明“同步交付不等 Provider、异步观察不丢真实结果” |
| Intelligence durable dispatch | 已切换 | admission、持久 ingress 和 Worker 自动执行责任在同一个 Runtime 请求内闭合；回执返回后客户端只 join；FIFO 双执行槽、conversation lane、持久 retry deadline 和取消后即时队头重算共同保证跨对话并发与对话内顺序；模型及工具错误均先写 durable terminal/receipt；交接由内部 drain 独立于响应 socket 完成并以成功证明为硬门 | receipt 后 Host 退出、模型失败、工具错误和 Worker 重启均不得留下永久队头、重复副作用或错误 drain proof |
| Telegram Channel Worker | 已切换 | 频道轮询、租约、投递和 Pi 对话在独立 Worker；数据库操作走统一 Runtime 准入，编辑器授权/绑定/停止经 Supervisor 端点执行，关闭时释放精确 inbox claim 与频道租约 | Worker 隔离后仍必须完成首次授权、编辑器命令、慢聊天期间停止、重启恢复和单次投递 |
| CLI 输出资源边界 | 已切换 | Supervisor 对每次 Agent CLI stdout 使用专属 8MiB 环形磁盘 spool、异步 partial I/O、流式背压和有界尾部物化；stderr 保持有界；成功、失败、取消精确回收，异常退出后的产物按 PID + 启动身份和唯一预期文件安全回收 | noisy/malformed CLI 不得形成 Supervisor 堆内无界字符串，也不得留下调用临时文件或误删活跃进程产物 |
| generation 崩溃回收 | 已切换 | generation 建立即登记精确清单；启动恢复同时处理 journal cutover 与无 journal 孤儿，清理前复核 manifest、设备、inode 和 mtime | SIGKILL/OOM/机器重启后不得永久遗留完整数据库副本；活动 journal 保护的 generation 不得误删 |
| Webview 增量渲染 | 已切换 | 发起动作只发送冻结输入并做 O(1) 本地状态；带 `updatedProjectPath` 的普通卡片更新按稳定项目键替换单卡，保留输入/焦点；整区构建仅用于首次装载、筛选集合或项目集合变化 | 普通实体 delta 不得重新进入整区 HTML 重建路径 |
| deadline/cancel/backpressure | 已切换 | UI background 最多 128 个实体键、单键最多 64 个 waiter；同键旧 revision、离开作用域的排队观察和未开始的超期任务会被撤销；Runtime 八个 domain 各自限并发/限队列，后台查询活动上限为 2，maintenance 对仍在排队的 foreground/interactive 让出下一次准入，但不会被已准入且跨域等待的前台任务冻结；foreground command 不因后台容量被拒绝；已接受的权威工作按合同排空而不被超时截断 | 持续验证前台无损、后台有界、同键合并、跨域无环、维护让行和“只取消未开始观察”不变量 |
| 旧文件兼容链 | 已退役为一次性导入 | Runtime 升级启动时仍显式发现并导入历史文件；启动完成后不再在自治周期递归扫描 57 个项目的 legacy run/status 目录，正式状态变化只走数据库事件与持久投影 | 历史 importer 可保留；生产周期不得恢复旧目录轮询 |
| 正式负载验收 | 已通过 | 0.0.639 冻结候选 16 对 19,386,109,952 字节源库建立 16,296,151,704 字节一致性隔离快照；57 个正式项目、8 个后台客户端、19 次后台读取、两路 CPU 压力与真实 Chromium → Webview → Host → Runtime → terminal → runner → Provider 同窗运行。4731 个交互样本 p95 5.811ms、max 60.356ms；4731 个前台样本 p95 5.768ms、max 146.369ms；Agent launch 4.459s、first output 5.419s；16GiB cgroup 内 `oom_kill` 前后均为 9；候选进程和完整隔离快照均自动回收 | 每个后续冻结发布候选仍须重跑真实库门禁、全量测试、最终脚本和 VSIX 验证；收据必须由本次压力窗口真实入口生成，任何 OOM delta、身份不符或夹具残留都判失败 |

因此，导致 62 秒阻塞的共享串行主链已经退役；发布候选只保留新的并发执行域、投影、协调器与增量 UI 主链。后续新增能力必须进入这些既有合同，不能以兼容为名恢复旧主链。

### 包 A：协议与负载基线

- 固化全部用户入口、Runtime 操作和 UI 消费者清单。
- 建立真实 Webview/Host/Runtime 端到端拥塞回归。
- 建立 57 项目、19GB 库、4 vCPU 的可重复资源基线，不修改生产库。

### 包 B：Runtime 执行域替换

- 落地 Supervisor、Write Actor、Interactive Reader、Background Reader 和显式 operation registry。
- 建立持久多路 RPC、取消、deadline 和健康交接。
- 将全部操作迁入显式 command/query/job 分类；未分类操作不得保留隐式旧路由。
- 退役原 `RuntimePriorityScheduler` 和每请求新建 TCP 连接的主路径。

### 包 C：UI Gateway 与读模型替换

- 所有 Webview 发送进入 UI Broker，所有用户动作进入 Foreground Ingress。
- 建立 Sidebar core 增量读模型、可见作用域订阅和 delta 协议。
- 替换全量 portfolio 重建、全项目对话预读和轮询刷新。
- 将 Git/网络/投影工作从 Extension Host 移入 Worker。

### 包 D：统一 Launch Coordinator

- 将 Solo、Step、Flow、Continue、Issue/PR/安全/交付、路线图调整、时间计划、远程、调度和维护入口收口为同一启动合同。
- 每个入口完成真实任务 ingress 计时和幂等验收。
- 退役入口自建的准备、终端和状态特例。

### 包 E：全量验收与单路切换

- 执行全部用户入口、并发、恢复、迁移、备份、多窗口、多 Agent、后台压力和 UI 渲染验收。
- 证明新任务不再进入旧 scheduler、全项目预读、直接 `postMessage` 或全量 DOM 重建路径。
- 删除被替代生产路径的代码和兼容开关；历史数据兼容仅保留 importer，不保留双主链。

## 13. 测试与发布门禁

### 必须先失败的回归

- 一个 background Webview 投递 promise 永不 resolve 时，用户 launch 仍在硬上限内进入 Host 并启动。
- 后台 Reader 运行 30 秒查询时，interactive query 在保留 Reader 上满足时限。
- Write Actor 有迁移/诊断批处理时，foreground command 在下一个短事务边界前置。
- 57 项目数据存在时，启动一次对话不读取其他 56 个项目，不投递任何其他项目负载。
- UI 正在处理大量 background delta 时，点击/Enter 仍先于下一个后台批次执行。
- 同一 interaction 重放 100 次仍只启动一个 Agent，且前台回执不被后台队列覆盖。

### 完整验收

- Runtime 执行域单元、真 SQLite WAL 集成、进程崩溃/重启、多窗口和多 Agent 并发。
- 最终生成 Webview 脚本语法和真实 Chromium/code-server 渲染。
- 57 项目和代表性 19GB 库的只读压力验收；不用小 fixture 外推生产成本。
- 后台外部信号、Git、日评、Agent 影响、数据概览、诊断和迁移同时运行的交互时限。
- 最终 VSIX 安装宿中的点击 → Host → 持久接受 → 终端 → runner 命令提交在 10 秒内返回，并以同一 interaction 继续取得 Provider ingress 与任务完成证据。

### 2026-11-02 冻结候选验收证据

- 候选：0.0.639，冻结候选 16，打包后 5730 个文件，10.11MiB 压缩、33.79MiB 解压，SHA-256 `fa3c0855da3da799d4602286ff025bb0c1ef232e994d323646df3a4f736230ae`。
- 数据：正式源库 19,386,109,952 字节、57 个项目；一致性隔离快照 16,296,151,704 字节，测试工作区加入后观察 58 个项目。
- 并发：8 个后台客户端覆盖投入、影响、总览、诊断、Sidebar 投影、迁移、Git、路线图、网络、日评和 Agent 影响，并叠加两路 CPU 压力。
- 交互：4731 个样本 p95 5.811ms、max 60.356ms；前台：4731 个样本 p95 5.768ms、max 146.369ms。
- 真实入口：Agent launch 4.459s、first output 5.419s；同一 interaction 的 Provider-native ingress 最终闭合，外部冷启动未反向阻断同步发起结果。
- 资源：16GiB cgroup 内 `oom_kill` 由 9 保持为 9；候选进程、CPU 压力进程、code-server 与隔离 gate root 均在验收后回收。

任一入口的持久接受与唯一 runner 命令提交超过 10 秒，或任一后台任务可阻塞 foreground 保留资源，或同步返回后最终没有取得真实 Provider/Agent 收据与结果，本架构都不得标记完成。

## 14. 非目标与边界

- 不改变用户的 SoloMap 入口、项目心智、Agent 选择和数据治理心智。
- 不引入用户需要理解的“快速模式”、“数据库模式”、“后台模式”或手动并发参数。
- 不为性能缩短日志、正文、附件、历史、恢复证据或任务生命周期。
- 不用更早超时、禁用后台功能、跳过数据库权威校验或新增用户等待确认来制造快速假象。
- 不在本架构任务中回收任何历史物理文件；该操作继续受精确清单和用户单独授权约束。
