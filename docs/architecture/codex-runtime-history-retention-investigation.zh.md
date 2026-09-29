# Codex 运行时历史膨胀与陈旧回合调查报告

> 调查日期：2026-09-26
>
> 文档状态：问题基线；用于后续专项设计与验收，不代表优化方案已经实施
>
> 适用范围：SoloMap 发起或关联的 Codex CLI 运行，以及 Codex 在本机用户目录中维护的会话历史

## 这份报告解决什么判断

本报告回答三个问题：

1. Codex 运行时为什么会持续膨胀。
2. 历史库中的大量 `inProgress` 是否代表仍有大量对话在运行。
3. SoloMap 后续应从生命周期收口、历史保留和索引一致性中的哪一层着手优化。

核心结论：**当前空间增长的主体是历史事件被长期保留，而不是大量对话进程仍在运行；陈旧 `inProgress` 是另一项真实问题，主体来自非交互执行和子代理在任意阶段被硬中止后未写入终态。两者相关，但不能混为同一个问题。**

## 状态名边界

本报告中的 `inProgress` 指 Codex 全局历史数据库 `thread_history_1.sqlite` 中 `thread_turns.status` 的值。

它不等于：

- SoloMap 路线图节点的 `In Progress`。
- SoloMap `.agent_status.json` 中表示任务仍可续推的 `In Progress`。
- 操作系统中仍存活的 Agent 进程。
- 用户界面中仍打开的终端窗口。

后续实现和指标必须保留这层命名空间，不能用一个“进行中”字段跨层推断。

## 现场快照

### 磁盘构成

调查时 `~/.codex-runtime/coder` 占用约 17.17 GB：

| 数据 | 规模 | 说明 |
| --- | ---: | --- |
| `sessions/` | 11.92 GB | 2,086 个会话 JSONL 文件 |
| `thread_history_1.sqlite` | 3.63 GB | Codex 会话历史投影和可查询事件 |
| `logs_2.sqlite` 及 WAL | 约 436 MB | 317,617 条运行日志及当前写前日志 |
| `packages/` | 666 MB | 当前 Codex standalone 与 app-server-daemon 包 |
| `generated_images/` | 166 MB | 会话生成图片 |
| 其他缓存、插件与状态 | 约 350 MB | 插件缓存、临时目录和状态文件 |

会话文件的年龄分布：

| 年龄 | 文件数 | 占用 |
| --- | ---: | ---: |
| 超过 7 天 | 1,888 | 10.74 GB |
| 超过 14 天 | 1,699 | 9.60 GB |
| 超过 30 天 | 1,063 | 5.00 GB |

因此，即使所有回合状态都正确收口，只要历史保留策略不变，运行时目录仍会持续增长。

### 历史索引

`thread_history_1.sqlite` 的现场结构为：

- `thread_history_projection_state`：2,075 条。
- `thread_items`：383,864 条。
- `thread_turns`：7,196 条，覆盖 1,762 个线程。
- `thread_realtime_items`：0 条。
- 数据库无 freelist 空页可直接回收，当前 3.63 GB 不是一次简单 `VACUUM` 就能消除的空洞。

`thread_items` 保存事件 JSON 投影，原始 `sessions/*.jsonl` 同时保留完整事件流。两层分别服务原始记录和查询恢复，但也意味着一次长期会话会在原始文件层与投影层同时增长。

### 当前活动进程

现场只识别到两条真实 CLI 会话链：一条恢复中的项目会话和本次调查会话。其余 Codex 相关进程是 app-server、managed daemon、VS Code 扩展服务及其包装进程。

因此，2,086 个历史文件或 1,762 个索引线程不能解释为同等数量的活动进程。

## 陈旧 `inProgress` 调查

### 状态分布

`thread_turns` 的状态分布为：

| 状态 | 回合数 |
| --- | ---: |
| `completed` | 6,512 |
| `interrupted` | 516 |
| `inProgress` | 100 |
| `failed` | 68 |

100 条 `inProgress` 分布在 96 个线程中：

- 98 条超过一天。
- 95 条超过七天。
- 82 条超过三十天。
- 最早记录始于 2026-06-30。

所有 100 条记录都同时缺少：

- `completed_at`。
- `duration_ms`。
- `final_agent_item_id`。
- `error_json`。

这不是正常完成、正常失败或已确认中断后的状态，而是终态提交没有发生。

### 来源分布

按 96 个线程的 `session_meta` 聚合：

| source | 线程数 | 解释 |
| --- | ---: | --- |
| `exec` | 69 | 非交互执行入口 |
| 子代理 `thread_spawn` | 17 | 父任务派生的子代理 |
| `vscode` | 5 | VS Code 入口 |
| `cli` | 5 | 普通 CLI 入口 |

按 originator 聚合，85 个线程来自 `codex_exec`，其余为 TUI、VS Code 或 Desktop。陈旧状态的主体因此不是用户忘记关闭窗口，而是自动执行链。

### 最后事件分布

陈旧回合最后停留的事件类型并不集中：

| 最后事件 | 回合数 |
| --- | ---: |
| `agentMessage` | 38 |
| `commandExecution` | 22 |
| `reasoning` | 20 |
| `mcpToolCall` | 9 |
| `webSearch` | 3 |
| `fileChange` | 3 |
| `subAgentActivity` | 2 |
| `imageView` / `imageGeneration` | 各 1 |
| 尚无事件 | 1 |

如果问题来自某一种工具的业务失败，最后事件通常会明显集中。当前分布更符合进程在任意执行阶段被外层终止，Provider 来不及写入最终状态。

## 当前代码证据

### Observed in code

- `src/extension.ts:6725` 的 `terminateTrackedAgentProcess` 会对验证后的进程树发送 `SIGTERM`，等待 1.5 秒后对仍存活进程发送 `SIGKILL`。
- `src/localAgentCliEngine.ts:66` 的本地认知调用在取消或 60 秒超时时发送 `SIGTERM`，2 秒后可升级为 `SIGKILL`。
- `src/headlessExecutionBackend.ts:285` 和 `src/durableExecutionWorker.ts:91` 的取消、超时和授权撤销路径也采用 `SIGTERM -> 2 秒 -> SIGKILL`。
- `src/extension.ts:5514` 的 Codex app-server 续接 runner 在完成或失败后直接终止 app-server 子进程。
- 现有交互设计已经要求：用户停止应先获得 `cancelled`，Adapter 异常退出应标记为异常中断并保留恢复身份，见 `docs/architecture/interactive-agent-terminal-sentinel-design.zh.md:280`。
- 当前仓库没有读取或修复 Codex `thread_history_1.sqlite` 的实现，也没有对 Codex 全局 `sessions/` 执行保留期治理。

### Inference

这些停止路径证明 SoloMap 具备硬终止 Provider 进程的条件，但仅凭历史库不能逐条证明是哪一条路径制造了哪一个陈旧回合。

结合来源和记录形状，当前最可信的根因模型是：

1. Codex 在回合开始时写入 `inProgress`。
2. 自动任务、父代理或外层运行时取消、超时、退出或重启。
3. 子进程收到终止信号，部分场景随后被强制结束。
4. Codex 没有完成 `completed`、`interrupted` 或 `failed` 的最终写入。
5. JSONL 与 SQLite 投影继续永久保留这条未收口记录。

516 条正常 `interrupted` 说明 Codex 本身支持有序中断。陈旧 100 条的共同特征是收尾处理根本没有完成，而不是所有取消都会产生脏状态。

## 问题必须拆成三层治理

### 1. 生命周期收口

目标是让 SoloMap 发起的每个 Codex 回合最终落到可证明的终态。

需要解决：

- 用户停止、超时、父任务退出和子代理回收时，是否先请求 Provider 取消。
- 收到何种机器事件后才能认为 Provider 已完成收口。
- 何时允许升级到 `SIGTERM` 或 `SIGKILL`。
- 硬终止后如何记录“待对账”，而不是假装已经 interrupted。

### 2. 陈旧状态对账

目标不是把旧 `inProgress` 批量改成 `completed`，而是根据证据判断它们已经不再运行，并保留真实终止语义。

最低证据组合应包括：

- SoloMap execution ID 与 Codex thread / turn ID 的稳定绑定。
- 原执行进程身份已失效。
- Provider rollout 最后事件和文件更新时间。
- 父任务、子代理和用户停止记录。
- 是否仍是某个确认可续聊会话的当前回合。

没有完成证据时只能归为异常中断或陈旧待处理，不能改写为成功。

### 3. 历史保留与索引一致性

目标是让磁盘增长有界，同时不破坏用户恢复对话和审计历史的能力。

只删除 JSONL 会让 SQLite 投影继续占用空间并产生历史不一致；只压缩 SQLite 也不会回收 11.92 GB 原始文件。任何清理都必须把以下对象作为同一策略处理：

- `sessions/*.jsonl` 原始会话。
- `thread_history_1.sqlite` 投影。
- 生成图片和相关附件。
- SoloMap 保存的 session binding、运行记录与可续聊指针。

## 后续优化方向

### 阶段一：先补可观测性

- 在 SoloMap run 记录中稳定保存 Codex thread ID、turn ID、父子 Agent 关系和 Provider 版本。
- 对每次停止记录 `cancel_requested`、`provider_cancel_confirmed`、`sigterm_sent`、`sigkill_sent`、进程退出码和最终 Provider 事件。
- 增加只读健康统计：运行时总量、会话年龄、陈旧回合数、每周增长量和最大会话文件。
- 不把这些内部对象暴露给普通用户；治理面只表达“历史占用”“可安全清理”“仍需保留”。

### 阶段二：优先保证有序收口

- 能使用 Provider 取消协议时，先取消当前 turn 并等待 `cancelled` / `interrupted` 机器事件。
- 只有取消无响应时才发送进程信号，并把升级原因写入运行证据。
- 父任务结束前显式等待或取消其子代理，不让子代理随父进程树被无差别回收。
- `SIGKILL` 后登记待对账项，由下次启动的恢复任务处理。
- 收口逻辑失败不能阻断用户关闭窗口，但必须保留可恢复、可诊断的真实状态。

### 阶段三：增加受控恢复扫描

- 插件启动或维护任务中，只扫描 SoloMap 能证明归属的 Codex 线程。
- 对“进程已不存在、超过恢复窗口、仍为 `inProgress`”的记录生成诊断结果。
- 优先使用 Codex 官方或稳定接口完成中断/归档；没有受支持接口时，不直接修改 Provider SQLite。
- 无法自动修复时，至少让 SoloMap 自己的运行状态与真实异常终止一致，并避免后续继续把它当活动任务。

### 阶段四：设计保留策略

保留策略尚未最终决策，但必须满足：

- 当前活动会话、确认可续聊会话和用户明确保留的会话永不被自动删除。
- 先提供 dry-run 清单和预计释放量，再允许执行清理。
- 同时处理原始文件、索引投影和附件，清理后验证历史列表与恢复能力一致。
- 支持按年龄与总量双水位治理，避免仅靠一次性人工清理。
- Provider 全局历史可能包含非 SoloMap 会话；SoloMap 默认只能自动治理自己能证明归属的记录。
- 清理是辅助维护动作，不能反向阻断 Agent 主任务产出。

## 验收标准

后续实现至少覆盖以下回归：

1. 正常完成：Codex turn 最终为 `completed`，SoloMap run 同步收口。
2. 用户停止：先收到 Provider 取消确认，最终为 `interrupted`，不残留陈旧 `inProgress`。
3. 超时升级：模拟 Provider 不响应，验证 `SIGTERM`、`SIGKILL` 和待对账证据完整。
4. 父子 Agent：父任务结束时所有子代理都得到独立终态，不因父进程退出留下陈旧 turn。
5. Extension Host 或容器异常退出：重启后能识别孤儿运行，不误判完成，也不重复执行副作用。
6. 历史清理：活动和可续聊会话保持可用；被清理会话不再出现在索引；实际释放量与 dry-run 接近。
7. 长期压力：持续制造完成、中断、失败和硬终止运行后，历史目录在设定水位内稳定，不线性无界增长。

## 尚未确认的问题

- 当前 Codex 版本是否提供受支持的 thread 归档、删除或历史索引重建接口。
- Codex app-server 对取消、进程信号和 daemon 退出的终态保证是什么。
- `thread_history_1.sqlite` 是否允许按 thread 受控删除，还是只能由 Codex 自己重建。
- SoloMap 应采用时间保留、容量水位还是二者组合，以及默认阈值。
- 已有陈旧回合是否需要保留一次离线快照，供后续验证修复效果。

## 当前处置边界

本次调查没有修改 Codex 会话文件、历史数据库或运行状态。后续实施前应先完成 Provider 能力审计和清理 dry-run 设计，不能把直接删除全局目录作为优化方案。
