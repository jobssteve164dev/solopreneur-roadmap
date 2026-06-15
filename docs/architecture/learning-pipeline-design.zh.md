# 学习管线设计

## 这份文档解决什么判断

这份文档固定 SoloMap 的学习管线如何从执行事实产生可复用经验，并被今日安排、Agent Prompt、Flow 和战略金字塔消费。

核心判断只有一句：**学习管线不是“多存几条日志”，而是把执行事实加工成能改变下一次行动质量的证据链。**

## 适用范围

本文约束以下能力：

- 路线图推进、Solo、路线图调整、review 和 Flow 微循环结束后的学习事件记录。
- `.solomap-global/learning/ledger/` 中的统一学习账本。
- `.solomap-global/learning/candidates/` 中的候选经验。
- Agent prompt 的按需召回。
- 侧边栏项目卡片、Daily Review 和战略金字塔对学习信号的消费。
- 未来候选审批、晋升和拒绝机制的设计边界。

本文不约束：

- 单次 Agent 输出原文如何展示。
- `.solopreneur/agent-runs/` 的运行日志结构。
- `.solopreneur/run-digests/` 的交接摘要结构。
- 用户主动写入的长期记忆内容本身。

这些可以作为证据来源，但不是学习管线的最终产物。

## 设计目标

学习管线必须做到：

- 有统一事实源，不让 step-memory、run digest、Flow trace、Markdown 候选各说各话。
- 从执行结果中自动提炼候选，但不把候选当成已确认事实。
- 在下一次执行前按需召回，不把所有历史学习塞进 prompt。
- 被战略判断吸收，但不能把未确认候选直接升级成战略结论。
- 学习存储失败不能阻断用户主执行链路。
- 前台只展示用户能行动的学习信号，不暴露账本、字段、目录和加工细节。

## 管线主线

```text
执行事实
  -> 学习事件
  -> 候选经验
  -> 按需召回
  -> 行动、验证、战略判断
  -> 用户确认或系统验证
  -> 晋升为长期记忆、模式、决策或战略信号
```

这条主线解决的是“学习如何生效”，不是“日志如何保存”。

## 事实源分层

### 1. 原始执行事实

原始事实来自已经存在的运行系统：

- 路线图环节执行状态。
- Solo 对话结果。
- 路线图调整结果。
- review 运行结果。
- Flow trace、Planner / Builder / Verifier 输出和 H/I/J 评分。
- run digest、touched files、changed files、验证命令和失败信号。

这些事实不可被学习管线改写。学习管线只引用和归纳它们。

### 2. 学习事件

学习事件是统一账本的最小事实单元。

它描述：

- 哪个项目发生了什么。
- 来源是 step run、Solo、Flow loop、review、roadmap revision 还是其他机制。
- 事件类型是 completed、verified、failed、deviated、partial、blocked、needs_confirmation 等。
- 有哪些证据引用。
- 哪些标签和元数据可用于后续召回。

学习事件保存在：

```text
.solomap-global/learning/ledger/events.jsonl
.solomap-global/learning/ledger/sources/<event-id>.json
.solomap-global/learning/ledger/index.json
```

### 3. 候选经验

候选经验是从学习事件中提炼出的可复用判断。

候选必须包含：

- 经验摘要。
- 适用条件。
- 下次应该做什么。
- 下次应该避免什么。
- 证据引用。
- 置信度。
- 状态：candidate、approved、rejected、promoted。
- 建议晋升目标：project memory、pattern、decision、domain、operating rule 或 strategy signal。

候选保存在：

```text
.solomap-global/learning/candidates/*.json
```

候选不是事实结论。它只是“值得审核和召回的加工产物”。

### 4. 长期记忆与战略信号

只有经过验证、确认或反复复用的候选，才能晋升为长期产物。

晋升目标包括：

- 项目记忆：当前项目未来必用的事实或边界。
- Pattern：跨项目可复用的实现、验证或排障套路。
- Decision：已确认且会影响后续方向的决策。
- Domain：领域知识。
- Operating rule：跨任务通用执行约束。
- Strategy signal：可影响加码、收缩、暂停或路线图调整的组合判断证据。

## 产物类型

第一版重点沉淀这些候选：

| 产物 | 来源 | 用途 |
| --- | --- | --- |
| 验证模式 | completed / verified 事件中的验证命令和证据 | 下次同类改动优先复用验证路径 |
| 风险模式 | failed、blocked、deviated、implemented_unverified、needs_confirmation | 防止重复失败、假完成或偏航 |
| 用户纠偏 | 用户明确指出偏航、边界、体验错误 | 约束下一次 Agent 执行语义 |
| Flow 闭环信号 | Verifier H/I/J 评分和 recommendedStatus | 改进下一轮 Planner / Builder / Verifier |
| 战略信号 | Daily Review、战略金字塔或路线图调整产生的组合判断 | 支撑项目加码、收缩和排序 |

不应沉淀为候选的内容：

- 单次命令输出全文。
- Agent 自称完成但没有证据的总结。
- 没有未来复用价值的临时观察。
- 只描述“我做了什么”的执行流水。
- 需要用户理解内部字段才能使用的对象说明。

## 写入规则

学习写入遵循非阻断原则。

主执行链路的优先级始终高于学习管线：

```text
用户任务完成 > 状态正确写回 > 证据保存 > 学习事件写入 > 候选提炼
```

如果学习账本不可写：

- 不能让路线图推进、Solo、Flow 或 review 失败。
- 可以记录警告。
- 下次读取时降级为空学习信号。
- 不把存储错误暴露成用户必须处理的前台任务。

这样做是为了避免学习机制反过来阻断用户目标。

## 召回规则

学习召回必须按需发生。

召回输入包括：

- 当前项目。
- 运行类型：step、solo、roadmap revision、flow。
- Flow 角色：planner、builder、verifier。
- 用户目标、路线图环节、Agent prompt、补充文件和上下文文本。

召回排序优先考虑：

- 同项目匹配。
- 任务上下文命中。
- 角色匹配。
- 已确认或已晋升状态。
- 近期更新。

召回输出必须能直接改变本轮行动：

- 应做什么。
- 应避免什么。
- 为什么适用。
- 证据来源是什么。

不能只输出历史回顾。

## 消费入口

### Agent Prompt

路线图推进、Solo、路线图调整和 Flow 都应注入相关学习候选。

注入目标不是让 Agent 背诵历史，而是让它：

- 避免重复失败。
- 复用已验证的验证动作。
- 遵守用户纠偏后的边界。
- 在 Flow 中把风险提前放进计划和验证闸门。

### 项目卡片

项目卡片的学习线索 tag 表示该项目存在可行动的学习信号。

它可以聚合：

- 候选经验数量。
- 已确认经验数量。
- 风险信号数量。
- 验证信号数量。
- 旧的 step-memory / agent-runs 兼容信号。

前台不解释账本结构，只显示用户能理解的“学习线索”。

### Daily Review

Daily Review 读取账本摘要，但只能把它转成今日行动：

- 哪个风险今天要先收口。
- 哪个验证经验可以复用。
- 哪个候选需要用户确认。
- 哪个项目因为学习信号应进入本周主推进或收尾。

不能把后台归档、候选整理或目录维护包装成用户任务。

### 战略金字塔

战略金字塔吸收学习信号时，只回答组合问题：

- 已验证经验是否支撑加码。
- 未收口风险是否阻止扩张。
- 哪些项目正在形成能力复利。
- 哪些学习候选还不能作为战略事实。

战略金字塔可以显示“学习闭环”结构信号，但不能把未确认候选直接当成战略结论。

### Flow

Flow 的微循环是学习管线最高价值来源之一。

Planner、Builder、Verifier 产生的结构化事实会沉淀为：

- 规划风险。
- 实现偏差。
- 验证不足。
- 已验证路径。
- 需要用户确认的边界。

下一轮 Flow 应召回这些候选，尤其是 Verifier 发现的 `deviated`、`implemented_unverified`、`verified_failed` 和 `needs_confirmation`。

## 与既有机制的关系

| 机制 | 定位 | 与学习账本关系 |
| --- | --- | --- |
| `.solopreneur/agent-runs/` | 单次运行原始材料 | 证据来源 |
| `.solopreneur/run-digests/` | 跨 Agent 交接摘要 | 证据来源和上下文索引 |
| `.solopreneur/flows/*.json` | Flow trace 事实源 | 学习事件来源 |
| `.solomap-global/learning/candidates/` | 候选经验池 | 账本提炼产物 |
| `.solomap-global/memory/` | 长期记忆 | 候选晋升目标 |
| Daily Review | 今日行动判断 | 学习信号消费者 |
| 战略金字塔 | 组合战略判断 | 学习信号消费者 |

账本不是替代这些机制，而是把它们串成主线。

## 状态边界

学习候选至少有四种状态：

| 状态 | 含义 |
| --- | --- |
| candidate | 已被系统提炼，但未确认 |
| approved | 已被用户或验证机制确认值得复用 |
| rejected | 已确认不应进入长期记忆 |
| promoted | 已晋升到项目记忆、模式、决策、领域或战略信号 |

状态转换必须保留来源证据。

禁止：

- 未经确认直接 promoted。
- rejected 后仍高权重召回。
- promoted 后继续把原候选当待处理任务。

## UI 边界

普通用户界面不应出现这些概念：

- events.jsonl
- source payload
- ledger index
- JSON candidate
- promotion target
- schemaVersion

用户只需要看到：

- 有多少学习线索。
- 哪些线索影响今天行动。
- 哪些风险需要确认。
- 哪些经验已经能复用。
- 哪些战略判断因学习信号而改变。

内部加工复杂度必须由实现层吸收。

## 成功标准

学习管线成立的标准不是“文件写入成功”，而是：

- 下一次 Agent 执行能召回相关经验。
- Daily Review 能把学习信号变成今日行动。
- 战略金字塔能区分已验证经验与未收口风险。
- Flow 能把验证失败和偏航转成下一轮微循环约束。
- 项目卡片学习线索 tag 有真实来源。
- 学习存储失败不会阻断用户主任务。

如果学习产物不能改变下一次行动、验证或战略判断，它就还没有进入真正闭环。
