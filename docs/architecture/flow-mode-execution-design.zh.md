# Flow 模式执行设计

## 这份文档解决什么判断

这份文档固定 SoloMap 是否应该新增与 Solo、路线图推进并列的 Flow 模式，以及 Flow 如何承接微观执行循环和执行轨迹面板。

核心判断只有一句：**Flow 是用户给出目标后，由插件拉起 Planner 规划微观循环、驱动非交互式执行、采集证据并持续滚动的 Pro 执行模式。**

## 决策正确性判断

Flow 的成立前提不是“多展示一个执行轨迹面板”，而是让用户给出目标后，系统尽可能自动完成目标。

因此以下决策成立：

- 新增 Flow 模式是必要的。它避免把微观执行控制继续塞进路线图对话，保持“行动目标”和“行动轨迹”两套心智。
- 第一版不兼容旧 Agent run / run digest 是正确的。旧数据迁移会把第一版拖入脏数据解释和历史状态修复，偏离 Flow 主目标。
- skill + validator 是必要基础。只靠 prompt 契约无法保证 Planner / Builder / Verifier 稳定产出结构化事实。
- 非交互式执行和多重证据采集是必要基础。没有充分事实证据，Flow 无法自动滚动。
- 第一版应把核心契约一次到位。这里的“到位”指 Flow 入口、trace source of truth、状态、证据、评分闸门、Pro 边界和恢复机制到位，不等于所有高级 UI、审计模式和查询优化一次全做。
- Flow Tab 独立承接微观执行是必要的。路线图保持宏观目标，Flow 承接微观循环和执行轨迹。
- Flow 作为 Pro 专属是正确的。Free 保留基础状态，Pro 解锁可靠自动执行流，心智统一。
- 灾难恢复必须服从用户目标完成。trace、索引、validator 和审计都是增强手段，不能反过来阻碍 Flow 完成目标。

## Flow 与既有入口的关系

SoloMap 第一版已有两类入口：

| 入口 | 用户心智 | 适用 |
| --- | --- | --- |
| Solo | 直接对话、探索、纠偏、讨论 | 尚未进入可靠执行流的开放问题 |
| 推进 | 按路线图环节执行当前任务 | 用户已经选定某个宏观环节 |
| Flow | 给一个目标，让系统规划并滚动多个微观循环 | 用户希望系统持续推进到目标完成 |

Flow 不替代 Solo，也不替代路线图推进。它承接的是更高自动化程度的 Agent Task Flow：

```text
用户目标
  -> Plugin 创建 Flow
  -> Planner 规划需要多少微观循环
  -> Builder 非交互式执行
  -> Plugin 采集证据
  -> Verifier 复核
  -> Plugin 闸门裁判
  -> 不闭环则生成下一微观循环
  -> 达成目标后向上归因到路线图或产出完成结论
```

Flow 的成败标准是：用户给出的目标是否被尽可能自动完成。执行轨迹、微观循环、评分闸门和证据采集都是为了扫清自动化障碍，而不是制造新的人工审批点。

## Flow 的入口约束

Flow 启动时，用户只需要输入目标。

用户不应被要求手动选择：

- 需要多少微观循环。
- Planner / Builder / Verifier 角色如何拆分。
- trace 文件如何写。
- scoring gates 如何配置。
- SQLite 或 JSON 索引如何维护。

这些由插件内部处理。

## Flow 与 Run Digest 的边界

Run Digest 是执行经验层的一部分，属于全局学习机制。微观循环是 Flow 的执行事实单元。

第一版不改造 Run Digest，也不兼容旧 Agent run 数据。

边界：

- 新 Flow 运行会产生 micro execution trace。
- 旧 `.solopreneur/agent-runs/` 和 run digest 不回填为微循环。
- Run Digest 仍可作为历史经验被召回，但不是微循环 source of truth。
- 后续稳定后，可以提供 best-effort 转换工具，但不能作为第一版目标。

这样做是为了避免兼容旧数据把第一版实现拖向数据迁移、脏数据解释和旧状态修复。

## 技能与校验工具

Flow 不能只依赖提示词契约来产出稳定 JSON。

每个 Agent 角色都应有对应 skill 和校验工具：

- Planner skill：产出五看三定 JSON。
- Builder skill：产出 actions、commandsRun、knownGaps JSON。
- Verifier skill：产出 checks、H/I/J、recommendedStatus JSON。
- Scoring validator：校验 scoring gates。
- Trace validator：校验 trace JSON。

Agent 在提交结构化结果前，应先调用校验工具自检。插件收到后仍要再次校验，不能把 Agent 自检当最终事实。

推荐链路：

```text
Agent 生成 JSON
  -> Agent 调用 validator 自检
  -> 修正到 schema 通过
  -> Plugin 接收
  -> Plugin 再校验
  -> Plugin 结合真实证据裁判
```

校验失败时，Flow 不应直接失败为终态；应优先生成修复结构化输出的下一步，除非用户停止或触发高风险确认。

这里的“高风险确认”只指用户授权不可替代的动作，例如发布、付款、删除、外部消息发送、凭证或生产数据写入。普通规划不足、验证失败、证据不足、范围偏差、JSON 不合法、实现未触达目标，都应由四分工继续化解，而不是默认停下问用户。

## 非交互式执行与证据采集

微观循环默认为非交互式执行。

证据采集不能只依赖 Agent 输出，必须采用多重机制互相校验：

- `tee` 捕获命令输出。
- 命令哨兵记录命令、退出码、开始/结束时间。
- 文件哨兵记录 touched files。
- git diff / status 二次确认文件变化。
- 测试、构建、lint、typecheck 结果结构化落账。
- completion decision 只能作为候选信号，不能替代事实证据。

证据原则：

> 宁愿采集超过最小边界，也不能缺少闭环所需证据。

但超范围采集只进入内部证据层，不应泄漏成用户前台负担。

## 第一版完整落地原则

第一版应尽量把 Flow 的数据结构、状态、证据、评分、索引和 UI 主路径一次性落稳。

可以后续小修小补，但不要把核心数据模型做成临时版。原因：

- 微循环 trace 一旦开始写入，就会成为后续经验和索引事实。
- 后期迁移 trace、lessons、scoring 和索引的成本可能不低于一次到位。
- 第一版数据结构不稳，会污染后续项目经验和跨项目学习。

允许后续迭代的是：

- UI 展示密度。
- 审计模式深度。
- SQLite 查询优化。
- 更多 skill / validator 类型。
- 更丰富的自动推进策略。

不应后置的是：

- trace source of truth。
- scoring gates 基本结构。
- Flow / Solo / 推进的入口边界。
- Pro 权限边界。
- 灾难恢复策略。

## Flow Tab

执行轨迹已经是微观层面的执行控制面，不应继续塞进现有路线图对话区域，避免路线图心智继续变重。

第一版应新增 Flow Tab 承接：

- Flow 目标输入。
- 当前 Flow 运行状态。
- 微观循环推进控制台。
- 执行轨迹面板。
- 证据下钻。
- 审计模式入口。

路线图仍然显示宏观目标、环节状态和下一步建议。Flow 负责微观循环和执行轨迹。

两者关系：

```text
Roadmap Tab = 行动目标
Flow Tab = 行动轨迹与执行控制
Solo = 开放对话
```

## Pro 边界

Flow 不对 Free 用户开放。

Free 保留基础任务状态、最近一次结果摘要、失败提示和手动继续入口。Flow 作为 Pro 功能保持一套心智：

```text
Free：看见基础结果，手动推进。
Pro：用 Flow 让微观循环基于证据可靠滚动。
```

未付费用户不应看到半套 Flow 配置、半套微循环字段或受限的内部对象。付费墙应围绕“开启 Flow”和“查看完整执行轨迹”表达，而不是把用户带入内部机制后再阻断。

## 灾难恢复原则

Flow 的首要目标永远是完成用户目标，不是保护治理机制本身。

恢复原则：

- JSON 是事实源，SQLite 可重建。
- trace 写一半时，应优先保留可恢复草稿，不阻断主任务继续。
- trace 损坏时，插件应隔离损坏文件，继续允许 Flow 或普通任务执行。
- 索引损坏时，重建索引；不能因为索引失败阻断执行。
- validator 失败时，优先打回 Agent 修结构化输出；必要时记录 `implemented_unverified`，但不阻塞用户继续推进。
- 证据不足时，不允许假闭环；但应生成下一微循环补证据，而不是停死。
- 最坏情况下，允许丢失执行轨迹增强信息，也不能让任务主目标无法继续。

## 障碍化解原则

Flow 的意义是“流动”。遇见障碍时，系统应优先把障碍转化为下一轮微观循环，让四分工继续处理。

默认化解策略：

| 障碍 | 默认处理 |
| --- | --- |
| 计划不完整 | 回到 Planner 生成补充规划循环 |
| JSON 不合法 | 调用 validator 反馈并重写结构化输出 |
| 没有动作证据 | 生成重新实施或重新规划循环 |
| 缺少验证 | 生成补验证循环 |
| 验证失败 | 生成修复失败循环 |
| 部分完成 | 生成补齐剩余目标循环 |
| 偏离原意 | 生成重新规划和纠偏循环 |
| 无法归因路线图 | 生成重定归因或重定目标循环 |
| 工程判断不足 | 生成方案重评估循环 |

只有当继续执行需要用户独有授权、真实外部不可逆动作，或用户明确停止 Flow 时，系统才应停下等待用户。

一句话：

```text
治理机制增强可靠性，但不能反过来阻碍目标完成；障碍默认由四分工化解，而不是交给用户裁判。
```

## 相关入口

- `docs/architecture/micro-execution-loop-flow.zh.md`
- `docs/architecture/micro-execution-loop-scoring-gates.zh.md`
- `docs/ui/execution-trace-panel-guidelines.zh.md`
- `docs/product/roi-pricing-guidance.zh.md`
