# SoloMap 执行经验层方法论

## 2026-09-08 设计更新

下一阶段以 [学习管线设计](../architecture/learning-pipeline-design.zh.md) 的双入口和手动复盘契约为准，本轮不改运行时。Agent 主动解释产出及纠偏，插件回读精确 GitHub 提交与检查证据；日常保存材料，用户点击“复盘经验”后才做语义提炼及晋升。现有 digest/graph 字段是兼容基础，不是新设计已实现的证明。

## 这份文档解决什么判断

这份文档说明 SoloMap 如何把每次 Agent 工作从原始日志转化为下一轮任务可复用的上下文、经验和方法包。

核心判断只有一句：**每次运行结束后，都应该留下能改变下一次执行决策的结构化交接经验。**

## 适用范围

本文适用于路线图环节、Solo 对话、路线图调整、Agent 安装 skill/MCP、代码修复、文档产出、发布验证和排障类运行。

本文不要求每次普通闲聊都生成执行经验，也不要求文档纯讨论自动进入长期记忆。

## 分层模型

执行经验层分为五层：

```text
命令主动报告 + GitHub 提交与检查证据 / Raw Run
  -> Run Digest v2 / Agent Handoff
  -> 手动“复盘经验”：核对、提炼与分层沉淀
  -> Execution Graph
  -> Retrieval Pack / CLI Query
  -> Agent 按需使用与主动反馈
```

### 1. Raw Run

Raw Run 是审计层，保存完整运行事实：

- prompt 文件。
- Agent 输出日志。
- command 文件。
- touched files。
- changes。
- completion decision。
- execution log。

Raw Run 默认不直接注入下一轮 Agent。

### 2. Run Digest

Run Digest 是单次运行的结构化摘要。

当前字段形态：

```json
{
  "schemaVersion": 2,
  "runId": "",
  "executionLogId": 0,
  "projectPath": "",
  "nodeId": "",
  "runKind": "step | solo | roadmap_revision",
  "userIntent": "",
  "agentCli": "",
  "outcome": "",
  "status": "Completed | Failed | In Progress",
  "touchedFiles": [],
  "changedFiles": [],
  "commandSignals": [],
  "verification": [],
  "failures": [],
  "reusableSignals": [],
  "tags": [],
  "handoff": {
    "nextAgentBrief": "",
    "recommendedFirstActions": [],
    "filesToInspectFirst": [],
    "commandsToRunNext": [],
    "blockedBy": [],
    "doNotRepeat": [],
    "confidence": "low | medium | high",
    "riskLevel": "low | medium | high"
  }
}
```

字段保持短而准，覆盖跨 Agent 接手价值最高的信息。

### 3. Execution Graph

Execution Graph 是 digest 之间的关系索引。当前采用项目本地 `.solopreneur/execution-graph.json`，不引入独立图数据库。

核心关系分两层。

第一层是 run 索引：

- 同项目。
- 同路线图环节。
- 同文件。
- 同测试命令。
- 同错误类型。
- 同 skill。
- 同 Issue。
- 同文档职责。
- 同 CodeGraph symbol/module（可选）。

第二层是经验节点：

- 验证动作。
- 失败模式。
- 可复用信号。
- handoff 动作。
- 运行决策。

经验节点必须有中心语义及来源，不能只是 Markdown 段落。当前 Graph 按摘要信号和运行状态累计的 win/loss 不是后续采用效果；下一阶段应绑定主动报告中的经验标识、实际动作和结果证据。整个任务成功、候选反复出现或多次召回都不能直接计作经验有效。

### 4. Retrieval Pack

Retrieval Pack 是供下一轮 Agent 按需查询的少量相关历史经验；当前 Solo 保持按需入口，不恢复默认正文注入。

它必须短、可执行、可验证。建议最多 3 条，每条包含：

- 为什么相关。
- 上次发生了什么。
- 下次应复用什么。
- 哪些路径不要重复。
- 哪个命令或检查证明过结果。

同时，Agent 可以通过本地 CLI 自行取更完整的交接包：

```bash
node resources/tools/solomap-experience.cjs handoff --project . --node <node-id> --limit 3
```

示例：

```text
相关历史 1：
- 命中原因：同文件 src/sidebarProvider.ts + Webview 运行脚本。
- 上次问题：内联脚本拼接生成非法 JS，按钮事件没有绑定。
- 可复用做法：改为 data-* + addEventListener，避免动态 onclick。
- 必须验证：检查最终生成的 Webview runtime script 可解析，并验证关键点击链路。
```

### 5. Stable Memory / Skill

手动复盘确认 lesson 有复用价值且证据成立时，才按层沉淀；多次召回本身不能作为晋升依据：

- 项目稳定事实 -> `memory/projects/<project>.md`
- 跨任务规则 -> `memory/operating-rules.md`
- 可复用做法 -> `memory/patterns/`
- 已确认决策 -> `memory/decisions/`
- 稳定流程 -> 可保留技能改进建议；实际修改 `skills/` 需单独任务授权

当前配套 skill 为 `resources/skills/solomap-cross-agent-handoff/SKILL.md`，用于固定跨 Agent 接手时的查询顺序和边界。

## Digest 生成时机

### 运行完成

每次 Agent run 完成、失败或被用户停止后，都可以尝试生成 digest。

如果运行没有项目变化、没有完成判断、也没有可复用信息，可以只保留 Raw Run，不生成 digest。

### 路线图环节完成

环节真正完成时，digest 应额外记录：

- 完成标准命中情况。
- 最后完成证据。
- 后续环节可复用的上下文。

### 用户纠偏后

当用户指出“偏了”“没理解”“不要这么做”时，本轮 digest 必须记录纠偏信息：

- 原目标是什么。
- 偏航点是什么。
- 后续同类任务应避免什么。

这类信息不能只留在原始对话里。

## 召回顺序

在接续、复核、重复故障或当前证据不足时按需查询；先判断具体目标、动作与经验适用条件，再使用以下索引定位证据，项目或运行类型相同不能单独证明相关：

1. 当前路线图环节最近 digest。
2. 同项目、同文件或同模块 digest。
3. 同错误类型或同验证命令 digest。
4. 同 skill 或同任务类型 digest。
5. 同 Issue、同文档职责或同路线图阶段 digest。
6. 如经验查询不足，Agent 使用 `solomap-experience` CLI 查询 handoff、failures、latest-changes 或 search 追溯证据。
7. embedding 语义相似 digest（可选，作为补充）。

召回结果必须经过去重和压缩，禁止超过主任务 prompt 的必要比例。

## 召回过滤

以下 digest 不应注入：

- 与当前用户要求冲突。
- 只包含执行流水，没有可复用判断。
- 失败但未形成根因或修复方向。
- 过期路径、已删除文件或已经被后续成功 run 覆盖。
- 含有敏感信息、密钥、私有用户数据或外部凭证。

## 与 CodeGraph 协同

当 CodeGraph 可用时，执行经验层可以增加两类能力：

1. 写入 digest 时，把 touched files 映射到符号、组件、路由或调用链。
2. 召回时，当前任务命中某个 symbol/module，可以找到历史上触碰相邻代码区域的 digest。

CodeGraph 不负责判断运行是否成功，也不负责沉淀经验。

## 与 embedding 协同

Embedding 只用于模糊召回，不承担最终排序和注入决策。

推荐做法：

1. 对 `userIntent`、`failures`、`fixes`、`reusableLessons` 生成向量。
2. 只在结构化召回不足时查询相似 digest。
3. 将 embedding 命中的候选重新经过结构化过滤。
4. 注入时说明命中原因，不暴露向量分数。

## 与 memory / skill 的升级规则

Digest 中的判断进入长期经验前必须有可定位的证据并在手动复盘中核对；可支持判断的依据包括：

- 同类任务多次命中并证明有用。
- 用户明确确认这是长期规则或稳定偏好。
- 有证据支持失败原因及适用范围，不能只因怀疑复发就升级为规则。
- 修复方式已经通过测试、构建、发布或真实运行验证。

升级时必须选择正确位置：

| 信息类型 | 目标位置 |
| --- | --- |
| 用户长期偏好 | `memory/profile.md` |
| 跨任务执行规则 | `memory/operating-rules.md` |
| 项目稳定事实 | `memory/projects/<project>.md` |
| 可复用排障或交付方式 | `memory/patterns/` |
| 已确认长期决策 | `memory/decisions/` |
| 稳定执行流程 | 保留建议，另行授权技能修改 |
| 未验证观察 | `memory/inbox/` 或 `learning/candidates/` |

## 当前可落地闭环

当前闭环不需要 embedding，也不需要独立图数据库。插件采用项目本地 JSON digest、execution graph、SQLite log 查询工具和配套 skill 落地。

已有记录和查询基础（不代表学习效果已核验）：

1. 从现有 Raw Run 生成 digest v2 JSON。
2. 保存到 `.solopreneur/run-digests/`。
3. 每次 digest 写入后刷新 `.solopreneur/execution-graph.json`。
4. 用文件路径、任务入口、运行类型、关键词做确定召回。
5. 旧 prompt 构建器有最多 3 条 Retrieval Pack 注入路径；当前 Solo 已使用按需上下文索引。
6. `resources/tools/solomap-experience.cjs` 从 digest、execution graph 和 SQLite `execution_logs` 输出 handoff、summary、history、failures、latest-changes 和 search。
7. `resources/skills/solomap-cross-agent-handoff/SKILL.md` 固定跨 Agent 接手规则，避免 Agent 直接复制原始 execution log 或用历史覆盖本轮目标。
8. 注入时保留“历史摘要不能覆盖本轮事实”的优先级约束。

下一阶段只沿已确认的双入口与手动复盘推进：

1. 兼容现有命令的结构化汇报，以及任务与提交的明确关联规范。
2. 手动复盘回读精确提交和检查证据，并语义阅读报告与差异。
3. 按证据更新分层记忆及全局指令，保留版本、应用结果和纠偏来源。
4. 后续报告经验采用情况，供下次手动复盘核对；CodeGraph、embedding 不属于本次实施范围。

当前闭环成功标准：

- Agent 少读重复文件。
- 相同区域的问题能复用历史验证命令。
- 用户纠偏不再只留在对话里。
- 有证据的经验能在手动复盘中上提到对应 memory；技能修改另行授权。

## 禁止项

- 禁止把 Raw Run 直接当 Retrieval Pack。
- 禁止把 digest 做成用户手工维护表单。
- 禁止为了“记得更多”牺牲下一轮主任务清晰度。
- 禁止把 embedding 命中结果不经判断直接注入。
- 禁止让历史经验覆盖用户本轮最新要求。
- 禁止把执行经验层变成新的任务入口或新路线图系统。

## 相关入口

- `docs/architecture/execution-experience-layer.zh.md`
- `docs/architecture/cross-agent-harness.zh.md`
- `.solopreneur/agent-runs/`
- `.solopreneur/step-memory/`
- `.solomap-global/memory/`
- `.solomap-global/learning/`
