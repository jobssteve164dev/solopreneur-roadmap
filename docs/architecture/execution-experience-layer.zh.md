# SoloMap 全局执行经验层设计

## 这份文档解决什么判断

这份文档固定 SoloMap 是否应该、以及如何把 Agent 运行日志转化为下一次任务可复用的执行经验。

核心判断只有一句：**SoloMap 不重建 Agent CLI 的私有记忆，而是在项目生命周期层管理被验证过的执行经验。**

## 适用范围

本文约束 SoloMap 对以下数据和能力的产品边界：

- `.solopreneur/agent-runs/` 中的 prompt、输出日志、命令、变更文件和完成判断。
- SQLite `execution_logs` 中的 Agent 对话记录。
- `.solopreneur/step-memory/` 中的环节交接和完成标准。
- `.solomap-global/memory`、`skills`、`mcp`、`learning` 中的跨项目经验、技能、连接器和学习候选。
- 后续可能出现的 Run Digest、Execution Graph、执行经验召回、CodeGraph 连接器和 embedding 辅助召回。

本文不约束 Agent CLI 自身的原生 memory、rules、AGENTS/CLAUDE 类项目指令文件，也不要求 SoloMap 写入或接管这些私有机制。

## 产品边界

Agent CLI 的原生记忆解决“这个 Agent 应该如何工作”。SoloMap 的执行经验层解决“这个项目上一次如何被推进，哪些执行事实能帮助下一次更快更准”。

两者边界如下：

| 层级 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Agent 原生 memory | Agent 偏好、目录规则、项目提示词、工具自身习惯 | 跨 Agent 统一项目执行历史 |
| SoloMap Execution Experience | 运行事实、历史失败、验证命令、触碰文件、可复用经验、路线图/Issue/skill 关系 | 模型推理、代码生成、Agent 私有记忆 |
| CodeGraph | 代码符号、调用关系、影响半径、结构化代码探索 | 执行失败原因、用户纠偏、验证闭环 |
| Embedding | 自然语言相似经验召回 | 因果、依赖、状态、验证责任 |
| Long-term Memory / Skill | 已验证且稳定的经验和方法包 | 原始日志全文、一次性过程记录 |

SoloMap 可以向 Agent 注入执行经验，但不应该把自己变成另一个通用 Agent 大脑。

## 核心原则

### 1. 原始日志不直接进入下一轮 prompt

运行日志是审计资产，不是工作上下文。下一轮 Agent 需要的是压缩后的执行判断：目标、触碰文件、失败原因、修复方式、验证命令和可复用教训。

### 2. 执行经验必须服务下一步动作

执行经验层的成败标准不是“记录完整”，而是下一轮任务是否更快定位、更少重复探索、更少重复失败、更能复用正确验证。

### 3. 结构化关系优先，语义相似辅助

SoloMap 首先依靠确定关系召回经验：项目、路线图环节、Issue、文件、模块、测试命令、错误类型、skill、Agent、结果状态。Embedding 只作为字段命中不足时的模糊召回补充。

### 4. 经验升级必须分层

一次运行先进入 Run Digest；多次被召回或被验证有效后，才能提升为 memory、pattern、decision 或 skill。不能把单次日志直接写成长期规则。

### 5. 用户不承担内部治理心智

用户看到的是“已带入相关历史经验”“建议先看这些文件”“上次类似问题这样验证”，而不是 embedding、graph、digest、index、向量库或日志分类表。

## 目标形态

SoloMap 的执行经验层最终形成以下链路：

```text
Agent 原始运行记录
  -> Run Digest
  -> Execution Graph
  -> 本轮相关经验召回
  -> 稳定经验提升为 Memory / Skill / Decision / Pattern
```

其中：

- Run Digest 是单次运行的结构化摘要。
- Execution Graph 是运行摘要之间，以及摘要与项目、文件、路线图、Issue、skill、验证命令之间的关系索引。
- Memory / Skill 是经过验证且跨会话仍值得复用的稳定经验。

## 当前首版落地边界

首版已经落地为项目本地的轻量闭环：

- 每次路线图环节、Solo 对话或路线图调整 run 收尾时，插件从现有运行事实生成 `Run Digest` JSON。
- Digest 保存到 `.solopreneur/run-digests/`，作为原始日志和长期记忆之间的中间层。
- 下一轮 Agent prompt 会按同任务入口、同运行类型、文件路径和关键词命中召回最多 3 条相关执行经验。
- 注入内容只包含上次目标、结果、相关文件、可复用信号、验证信号和风险信号，不注入原始日志全文。
- 历史经验在 prompt 中被明确标注为“历史结构化摘要”，不能覆盖用户本轮要求、当前代码、测试或日志。

首版暂不引入 embedding、独立图数据库或 CodeGraph 连接器。它先验证最小闭环是否能减少重复探索，再决定是否扩展为更完整的 Execution Graph。

## Run Digest 边界

Run Digest 是原始日志和长期记忆之间的中间层。它不替代日志，也不替代 memory。

它应记录：

- 用户意图。
- 所属项目、scope、路线图环节或 Solo 对话。
- Agent family 和运行结果。
- 触碰文件和关键模块。
- 执行命令、验证命令和结果。
- 失败信号、根因判断和修复动作。
- 可复用经验候选。
- 与 Issue、文档、skill、MCP、CodeGraph 查询的关系。

它不应记录：

- 完整 prompt。
- 完整终端输出。
- Agent 心路历程。
- 未经验证的长篇猜测。
- 普通用户不需要理解的内部对象模型。

## Execution Graph 边界

Execution Graph 不是聊天搜索，也不是日志浏览器。它是为了在任务启动前回答：

- 过去哪个 run 与当前任务有关？
- 上次类似任务先看了哪些文件？
- 哪些错误路径已经被证明无效？
- 哪些验证命令曾证明这个区域修复有效？
- 哪些长期规则或 skill 来源于这些 run？
- 哪些历史经验已经稳定到可以提升为 memory 或 skill？

它应优先建立以下关系：

- `run -> project`
- `run -> roadmap step`
- `run -> issue`
- `run -> touched file`
- `run -> command`
- `run -> verification`
- `run -> failure`
- `run -> fix`
- `run -> skill`
- `run -> reusable lesson`
- `lesson -> memory/pattern/decision/skill`
- `file -> CodeGraph symbol/module`（当 CodeGraph 可用时）

## CodeGraph 的位置

CodeGraph 适合作为代码结构维度，不适合作为执行经验层本体。

它能帮助 SoloMap：

- 把 run 触碰文件映射到符号、调用链和影响半径。
- 在代码任务启动时减少 grep/read 探索。
- 给 Execution Graph 增加代码结构关系。

它不能替代：

- 运行失败原因分析。
- 用户纠偏记录。
- 验证命令和结果。
- 经验升级判断。

因此 CodeGraph 应作为受管 MCP 连接器或代码上下文加速层，而不是日志吸收层。

## Embedding 的位置

Embedding 适合找“语义相似”，不适合判断“应该如何行动”。

SoloMap 可以对 Run Digest 的自然语言字段做 embedding，用于补充召回：

- 用户意图。
- 错误摘要。
- 修复摘要。
- 可复用经验候选。

但最终注入给 Agent 的内容必须经过结构化过滤和排序，不能把 embedding top-k 原样塞进 prompt。

## 用户体验边界

前台不应出现以下概念：

- Execution Graph
- vector index
- embedding
- digest schema
- retrieval score
- raw log mining

前台可以出现：

- “已带入 3 条相关历史经验。”
- “上次类似问题触碰了这些文件。”
- “建议复用这些验证命令。”
- “这条经验已多次命中，可提升为项目记忆。”

## 禁止项

- 禁止把原始日志全文注入下一轮 Agent。
- 禁止把单次运行结论直接提升为全局规则。
- 禁止用 embedding 召回替代结构化事实判断。
- 禁止让用户维护 digest、graph、embedding 或索引字段。
- 禁止自动写入 Agent 私有 memory 作为正式机制。
- 禁止把执行经验层做成独立任务系统，绕开 Roadmap、Solo 和 Issue 的既有主路径。
- 禁止因为历史经验召回而覆盖用户本轮明确要求。

## 相关入口

- `docs/architecture/cross-agent-harness.zh.md`
- `docs/methodology/execution-experience-methodology.zh.md`
- `docs/methodology/project-lifecycle-engineering-docs.zh.md`
- `docs/architecture/global-system-plugin-blueprint.zh.md`
- `.solopreneur/agent-runs/`
- `.solopreneur/step-memory/`
- `.solomap-global/memory/`
- `.solomap-global/learning/`
