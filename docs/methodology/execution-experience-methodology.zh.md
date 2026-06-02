# SoloMap 执行经验层方法论

## 这份文档解决什么判断

这份文档说明 SoloMap 如何把每次 Agent 工作从原始日志转化为下一轮任务可复用的上下文、经验和方法包。

核心判断只有一句：**每次运行结束后，都应该留下能改变下一次执行决策的最小结构化经验。**

## 适用范围

本文适用于路线图环节、Solo 对话、路线图调整、Agent 安装 skill/MCP、代码修复、文档产出、发布验证和排障类运行。

本文不要求每次普通闲聊都生成执行经验，也不要求文档纯讨论自动进入长期记忆。

## 分层模型

执行经验层分为五层：

```text
Raw Run
  -> Run Digest
  -> Execution Graph
  -> Retrieval Pack
  -> Stable Memory / Skill
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

建议最小字段：

```json
{
  "schemaVersion": 1,
  "runId": "",
  "projectPath": "",
  "scope": "roadmap-step | solo | revision | install-skill | install-mcp",
  "roadmapStepId": "",
  "userIntent": "",
  "agentFamily": "",
  "outcome": "completed | failed | partial | stopped",
  "touchedFiles": [],
  "commands": [],
  "verification": [],
  "failures": [],
  "fixes": [],
  "reusableLessons": [],
  "relatedIssues": [],
  "relatedSkills": [],
  "relatedDocs": [],
  "tags": [],
  "createdAt": ""
}
```

字段保持少而准，先覆盖召回价值最高的信息。

### 3. Execution Graph

Execution Graph 是 digest 之间的关系索引。第一版不需要复杂图数据库，可以用 JSONL、SQLite 或项目现有 SQLite 表实现。

核心关系：

- 同项目。
- 同路线图环节。
- 同文件。
- 同测试命令。
- 同错误类型。
- 同 skill。
- 同 Issue。
- 同文档职责。
- 同 CodeGraph symbol/module（可选）。

### 4. Retrieval Pack

Retrieval Pack 是下一轮 Agent 启动前注入的少量相关历史经验。

它必须短、可执行、可验证。建议最多 3 条，每条包含：

- 为什么相关。
- 上次发生了什么。
- 下次应复用什么。
- 哪些路径不要重复。
- 哪个命令或检查证明过结果。

示例：

```text
相关历史 1：
- 命中原因：同文件 src/sidebarProvider.ts + Webview 运行脚本。
- 上次问题：内联脚本拼接生成非法 JS，按钮事件没有绑定。
- 可复用做法：改为 data-* + addEventListener，避免动态 onclick。
- 必须验证：检查最终生成的 Webview runtime script 可解析，并验证关键点击链路。
```

### 5. Stable Memory / Skill

当一个 lesson 被多次召回或被明确验证为跨任务有价值时，才提升：

- 项目稳定事实 -> `memory/projects/<project>.md`
- 跨任务规则 -> `memory/operating-rules.md`
- 可复用做法 -> `memory/patterns/`
- 已确认决策 -> `memory/decisions/`
- 稳定流程 -> `skills/`

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

下一轮 Agent 启动前，按以下顺序召回经验：

1. 当前路线图环节最近 digest。
2. 同项目、同文件或同模块 digest。
3. 同错误类型或同验证命令 digest。
4. 同 skill 或同任务类型 digest。
5. 同 Issue、同文档职责或同路线图阶段 digest。
6. embedding 语义相似 digest（可选，作为补充）。

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

Digest 进入长期经验前必须满足至少一个条件：

- 同类任务多次命中并证明有用。
- 用户明确确认这是长期规则或稳定偏好。
- 失败模式具有跨任务复发风险。
- 修复方式已经通过测试、构建、发布或真实运行验证。

升级时必须选择正确位置：

| 信息类型 | 目标位置 |
| --- | --- |
| 用户长期偏好 | `memory/profile.md` |
| 跨任务执行规则 | `memory/operating-rules.md` |
| 项目稳定事实 | `memory/projects/<project>.md` |
| 可复用排障或交付方式 | `memory/patterns/` |
| 已确认长期决策 | `memory/decisions/` |
| 稳定执行流程 | `skills/` |
| 未验证观察 | `memory/inbox/` 或 `learning/candidates/` |

## 最小可落地版本

第一版不需要 embedding，也不需要独立图数据库。

建议先做：

1. 从现有 Raw Run 生成 digest JSON。
2. 保存到项目或全局 execution 目录。
3. 用文件路径、路线图环节、命令、状态做确定召回。
4. Agent prompt 注入最多 3 条 Retrieval Pack。
5. 任务结束时提示哪些 lesson 值得提升到 memory。

第一版成功标准：

- Agent 少读重复文件。
- 相同区域的问题能复用历史验证命令。
- 用户纠偏不再只留在对话里。
- 多次复用的经验能自然上提到 memory 或 skill。

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
