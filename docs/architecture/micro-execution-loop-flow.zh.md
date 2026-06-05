# 微观执行循环架构设计

## 这份文档解决什么判断

这份文档说明 SoloMap 如何计划、执行、验证一个微观循环，并把它可靠归并到路线图环节。

核心判断只有一句：**Agent 可以承担计划、实施和验证的认知工作，但微观循环的账本、证据、状态和闸门必须由插件治理。**

## 设计目标

微观执行循环要解决 Agent Task Flow 最关键的问题：

```text
每个结果都能被可靠执行、可靠验证、可靠归因，然后再推动下一步。
```

它不是为了展示更多运行信息，而是为了让路线图自动滚动具备事实基础。

## 职责分工

一次可靠微观循环至少需要四类职责：

| 角色 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Planner | 把路线图目标或用户输入拆成本轮意图、边界、计划和验证方式 | 最终状态裁判 |
| Builder | 修改代码、文档、配置或运行命令，完成实施动作 | 自证完成 |
| Verifier | 对照意图和证据审查是否闭环，指出缺口或下一轮循环 | 写入最终状态 |
| Plugin | 创建循环、采集事实、维护账本、执行闸门、归并路线图 | 生成式代码实现 |

Planner、Builder、Verifier 可以是三个独立 Agent，也可以是同一个 Agent CLI 的三种 prompt 模式。第一版推荐先采用同一 Agent 的三角色模式，等微循环账本和闸门稳定后，再拆成独立 Agent。

## Session 数量边界

六阶段是方法论结构，四分工是责任边界，它们不等于固定六次 Agent session，也不等于固定四个独立 Agent 进程。

正确关系是：

```text
六阶段 = 每个微观循环必须留下的结构化事实
四分工 = 谁对哪些事实负责
Session = 具体执行时可按风险合并、拆分或复用
```

因此微观循环是逻辑闭环，不是 session 数量。SoloMap 应按任务风险选择 1、2 或 3 个 Agent session，但无论 session 数量多少，都必须形成完整六阶段轨迹。

### 轻量形态：1 个主 Agent session

适用：

- 低风险文档更新。
- 小范围代码修复。
- 已有明确验证命令的简单任务。
- 不涉及发布、权限、数据、外部写入或路线图结构变化。

流程：

```text
插件创建微观循环
  -> 主 Agent 在同一 session 中完成意图、判断、动作和初步验证
  -> 插件采集事实证据
  -> 插件裁定结果和归因
```

这里 Planner、Builder 和初步 Verifier 可以由同一个 Agent session 承担，但插件仍然负责证据采集、状态裁判和路线图归并。

### 默认形态：主 Agent + 副 Agent

适用：

- 普通代码任务。
- UI、配置、模板、文档体系等会影响用户体验或项目长期边界的任务。
- 主 Agent 有明确产出，但仍需要独立复核证据是否支撑完成。

流程：

```text
主 Agent session
  -> 输出意图、判断、实施动作和自测结果
插件
  -> 采集 diff、命令、文件变化和验证结果
副 Agent session
  -> 只读复核是否满足意图、证据是否充分、是否需要返工
插件
  -> 写入结果、归因，并决定推进或生成下一微观循环
```

这是现有主副 Agent 协作机制升级为微观循环的推荐默认路径。

### 重量形态：Planner + Builder + Verifier

适用：

- 跨模块重构。
- 高风险权限、数据、支付、发布或生产动作。
- 路线图结构变化。
- 复杂任务中计划、执行、验证需要明确隔离。

流程：

```text
Planner session
  -> 只产出意图、边界、计划和验证方式
Builder session
  -> 按计划实施
插件
  -> 采集事实证据
Verifier session
  -> 独立复核证据和结果
插件
  -> 执行闸门、写入归因、决定下一步
```

这种形态不应默认启用，否则微观循环会变得过重、过慢，并把执行成本放大到用户难以接受。

## Session 分级策略

| 任务风险 | 推荐 session 策略 |
| --- | --- |
| 低风险、纯文档、小修 | 1 个主 Agent session |
| 普通代码、UI、配置 | 主 Agent + 副 Agent |
| 高风险、跨模块、发布、权限、数据 | Planner + Builder + Verifier |
| 需要用户授权 | 停下确认，不自动继续 |

关键原则：**微观循环必须完整留痕，但不必重型执行。**

## 插件为什么必须是裁判

如果只用 Planner / Builder / Verifier 三 Agent，系统仍然可能是三个黑箱互相背书：

- Planner 计划不完整，Builder 仍然照做。
- Builder 改了代码但没有可验证证据。
- Verifier 只基于 Agent 描述判断，而不是基于事实。
- 三个 Agent 都说完成，但路线图完成标准并未满足。
- 失败后不知道应该返工、重开循环还是推进下一环节。

因此插件必须掌握：

- 唯一循环状态。
- 客观证据采集。
- 状态流转规则。
- 路线图完成标准命中。
- 是否开启下一轮循环或下一路线图环节。

插件裁判必须按结构化评分与硬闸门执行，不能把 Verifier Agent 的自然语言意见直接当成最终结论。评分制度见 `docs/architecture/micro-execution-loop-scoring-gates.zh.md`。

## 微观循环状态机

推荐状态：

```text
created
  -> planned
  -> building
  -> evidence_collected
  -> verifying
  -> closed
```

异常或分支状态：

```text
needs_user_confirmation
planning_incomplete
no_effect
implemented_unverified
verified_failed
partial
deviated
needs_review
spawned_followup
unassigned
abandoned
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| `created` | 插件已创建循环，绑定路线图环节和来源 |
| `planned` | 已形成意图、边界、计划和验证方式 |
| `building` | Builder 正在实施 |
| `evidence_collected` | 插件已采集 diff、命令、测试、日志等事实 |
| `verifying` | Verifier 正在审查证据是否支撑闭环 |
| `closed` | 证据足以支撑本轮闭环 |
| `needs_user_confirmation` | 涉及方向、授权、成本、发布或不可逆动作 |
| `planning_incomplete` | 意图、五看三定、范围或验证计划不足，不能进入实施或完成 |
| `no_effect` | 本轮没有产生可观察动作证据，且任务不属于纯分析或纯讨论 |
| `implemented_unverified` | 有实施动作，但验证不足 |
| `verified_failed` | 验证明确失败 |
| `partial` | 部分目标完成 |
| `deviated` | 实际结果偏离意图 |
| `needs_review` | 工程判断依据不足或风险较高，需要复核或生成下一循环 |
| `spawned_followup` | 已生成下一轮微观循环 |
| `unassigned` | 结果无法归因到路线图完成标准，不能推动宏观进度 |
| `abandoned` | 明确放弃 |

## 最小数据模型

每个微观循环应有独立 `traceId`，并绑定路线图环节。

建议最小结构：

```json
{
  "schemaVersion": 1,
  "traceId": "",
  "projectPath": "",
  "roadmapStepId": "",
  "source": {
    "type": "roadmap_step | solo | issue | test_failure | agent_finding | followup",
    "ref": "",
    "userInput": ""
  },
  "intent": {
    "goal": "",
    "scope": [],
    "outOfScope": [],
    "successCriteria": []
  },
  "judgment": {
    "plan": [],
    "affectedAreas": [],
    "constraints": [],
    "risks": [],
    "verificationPlan": []
  },
  "actions": [
    {
      "type": "add_capability | modify_path | fix_defect | harden_boundary | add_verification | reduce_debt | revert_deviation | update_docs",
      "summary": "",
      "files": []
    }
  ],
  "evidence": {
    "touchedFiles": [],
    "diffSummary": [],
    "commands": [],
    "verification": [],
    "commits": [],
    "manualChecks": [],
    "unverified": []
  },
  "result": {
    "status": "closed | implemented_unverified | verified_failed | partial | deviated | spawned_followup | abandoned",
    "summary": "",
    "remainingGaps": []
  },
  "attribution": {
    "roadmapStepId": "",
    "completionCriteriaHit": [],
    "userCapabilities": [],
    "boundaryChanges": [],
    "riskChanges": [],
    "nextTraceIds": []
  },
  "lessons": [
    {
      "type": "verification_pattern | boundary_rule | planning_rule | risk_pattern | implementation_pattern",
      "summary": "",
      "evidence": ["trace:"],
      "promotion": "none | project_candidate | project_memory | cross_project_candidate"
    }
  ],
  "followups": [
    {
      "reason": "",
      "suggestedIntent": "",
      "targetStatus": "created"
    }
  ],
  "createdAt": "",
  "updatedAt": ""
}
```

第一版应把它保存为项目本地 JSON 或 JSONL；后续再纳入 SQLite/Execution Graph。

## 数据持久化形态

微观循环是项目事实账本，第一版的 source of truth 应是项目目录内的 JSON/JSONL，而不是插件私有数据库。

推荐结构：

```text
.solopreneur/execution-traces/
  traces.jsonl
  traces/
    <traceId>.json
```

职责划分：

| 载体 | 职责 |
| --- | --- |
| `traces.jsonl` | 轻量索引流，每个微观循环一行，便于追加、扫描和 Git diff |
| `traces/<traceId>.json` | 单个微观循环完整详情，保存六阶段、证据、结果和归因 |
| SQLite | 查询索引、聚合缓存、面板加速层，可由 JSON/JSONL 重建 |
| HTML 导出 | 归档、分享或审计视图，不作为主交互状态源 |

推荐原则：

```text
JSON/JSONL = 项目内事实账本
SQLite = 索引 / 缓存 / 查询加速
Webview State = 当前界面状态
HTML = 导出产物
```

这样做的原因：

- Git 可追踪，用户和 Agent 都能读。
- 项目可跨机器迁移，不依赖插件内部状态。
- 数据损坏时容易人工审计和修复。
- 数据库可以删除后重建，不会丢失微观循环事实。
- 符合 SoloMap 项目数据保留在 `.solopreneur/` 下的本地优先边界。

禁止把 SQLite 作为唯一事实源。数据库适合做筛选、聚合、排序和面板查询缓存，但不能成为微观循环账本的唯一载体。

## 索引与召回

微观循环不能只是写入后归档。它必须成为下一轮 Planner、Builder、Verifier 和 Plugin 的输入。

`traces.jsonl` 第一版应保留下一轮最常用的检索字段：

```json
{
  "traceId": "",
  "roadmapStepId": "",
  "status": "closed",
  "goal": "",
  "files": [],
  "modules": [],
  "criteriaHit": [],
  "failedGates": [],
  "riskFlags": [],
  "hij": {
    "H": "pass",
    "I": "pass",
    "J": "pass"
  },
  "plannerDecision": "",
  "rejectedOptions": [],
  "followupTraceIds": [],
  "lessonCandidateIds": [],
  "createdAt": "",
  "updatedAt": ""
}
```

第一版索引维度：

- `roadmapStepId`：同一路线图环节的未闭环循环。
- `status`：待验证、失败、偏离、需要确认等状态。
- `criteriaHit`：完成标准覆盖。
- `files/modules`：同文件、同模块历史。
- `failedGates`：反复失败的闸门。
- `riskFlags`：权限、发布、数据、用户体验、边界风险。
- `hij`：H/I/J 失败或不确定项。
- `plannerDecision/rejectedOptions`：过去选过或拒绝过的路径。
- `followupTraceIds`：下一轮微循环关系。
- `lessonCandidateIds`：可沉淀经验候选。

后续 SQLite 可以扩展成查询表：

```text
traces
trace_files
trace_modules
trace_criteria
trace_gates
trace_risks
trace_hij
trace_followups
trace_lessons
```

但这些表必须能从 JSON/JSONL 重建。

## 四分工如何消化 trace

四分工不应读取同一大段原始日志。插件应按角色生成最小上下文包。

### Planner 消化

Planner 读取：

- 同路线图环节未闭环 trace。
- 同模块或同文件历史 trace。
- 上轮 followups。
- 常见 failed gates。
- 历史 rejectedOptions。
- 已确认 lessons。

Planner 用这些回答：

- 这轮意图从哪里来。
- 哪些路过去走过、为什么被拒绝。
- 哪些边界不能破。
- 哪些验证必须提前规划。

### Builder 消化

Builder 读取：

- 当前 Planner 计划。
- 相关历史 actions。
- 相关 touched files。
- 上次失败的验证命令。
- knownGaps。
- 不能破的边界。

Builder 用这些执行，不重新规划目标。

### Verifier 消化

Verifier 读取：

- 当前 evidence。
- 当前 scoring gates。
- Planner 五看三定。
- 历史 H/I/J 失败项。
- 同类任务曾经漏掉的验证。
- 之前的偏离记录。

Verifier 用这些判断是否真的闭环，不复述 Builder 自述。

### Plugin 消化

Plugin 读取：

- `traces.jsonl`。
- 当前 trace 详情。
- scoring gates。
- attribution。
- completion criteria coverage。
- followup trace links。

Plugin 用这些决定：

- 是否推进路线图。
- 是否生成下一轮微循环。
- 是否沉淀项目经验候选。
- 是否上提跨项目经验候选。

## 经验沉淀链路

微观循环是经验生产线的原子事实。

```text
trace 写入
  -> traces.jsonl 索引
  -> 下一轮四分工按职责召回
  -> 多次命中生成 lesson candidate
  -> 项目经验沉淀
  -> 跨项目经验审核
  -> patterns / decisions / operating-rules / skills
```

不是每个 trace 都沉淀。只有以下情况生成项目经验候选：

- 同一 failed gate 多次出现。
- 同一模块或用户路径反复返工。
- 某个验证命令多次证明有效。
- 某个边界多次防止偏航。
- 某个 rejected option 被多次拒绝。
- 某个 H/I/J 问题反复出现。
- 某条 Planner 决策被后续闭环证明有效。

项目内候选可以写入：

```text
.solopreneur/execution-traces/lessons.jsonl
```

推荐字段：

```json
{
  "lessonId": "",
  "sourceTraceIds": [],
  "type": "verification_pattern | boundary_rule | planning_rule | risk_pattern | implementation_pattern",
  "summary": "",
  "evidence": ["trace:"],
  "status": "candidate | promoted_project | promoted_cross_project",
  "createdAt": ""
}
```

项目稳定经验应进入项目记忆或正式项目文档：

- 项目稳定事实：`.solomap-global/memory/projects/<project>.md`
- 项目边界：`docs/architecture/`
- 项目方法论：`docs/methodology/`
- UI 长期约束：`docs/ui/`

跨项目经验必须更严格：

- 至少 2 个项目命中同类 lesson。
- 或用户明确确认这是通用规则。
- 或失败模式具有明显跨项目复发风险。
- 且不包含项目私有路径、接口名、供应方细节或敏感信息。

跨项目目标位置：

- `memory/patterns/`：可复用做法。
- `memory/operating-rules.md`：通用执行硬规则。
- `memory/decisions/`：已确认长期决策。
- `memory/domains/`：领域知识。
- `skills/`：稳定到可自动执行的流程。

## 执行流程

### 1. 路线图环节启动

插件读取：

- 当前路线图环节。
- 环节完成标准。
- 用户本轮输入。
- 相关执行经验。
- 相关 Issue、文档或历史循环。

插件创建第一个微观循环，状态为 `created`。

### 2. Planner 形成计划

Planner 输出：

- 本轮意图。
- 实施边界。
- 不做范围。
- 影响范围。
- 验证计划。

插件检查计划是否包含必要字段。缺失时不能进入 Builder。

### 3. Builder 实施

Builder 按计划执行：

- 修改项目文件。
- 运行必要命令。
- 记录已知风险。
- 遇到新问题时标明是否需要新循环。

Builder 结束后，插件不直接相信其结论，而是进入事实采集。

### 4. 插件采集证据

插件采集：

- 文件变更。
- diff 摘要。
- touched files。
- 运行命令和退出状态。
- 测试、构建、lint、typecheck 结果。
- Agent 输出中的明确完成判断。
- completion decision。

这些事实进入循环账本，并交给 Verifier。

### 5. Verifier 审查

Verifier 只读审查：

- 意图是否被满足。
- 判断阶段承诺的验证是否执行。
- 动作是否有事实支撑。
- 证据是否足够支撑结果。
- 是否产生偏离、部分完成或下一轮问题。
- 是否可以命中路线图完成标准。

Verifier 输出建议状态，但不直接写最终状态。

### 6. 插件执行闸门

插件根据 Verifier 建议和客观证据决定状态：

- 证据充分：`closed`。
- 有实施无验证：`implemented_unverified`。
- 验证失败：`verified_failed`。
- 目标部分满足：`partial`。
- 偏离原意：`deviated`。
- 需要人决定：`needs_user_confirmation`。
- 生成下一轮：`spawned_followup`。

状态计算必须优先执行硬闸门，再参考 Planner、Builder、Verifier 的计分项。硬闸门决定能不能推进，分数只解释 Planner / Builder / Verifier 哪个环节薄弱。

### 7. 归并路线图

插件聚合同一环节下所有微观循环，判断完成标准：

- 哪些标准已有 `closed` 循环支撑。
- 哪些标准只有实施但未验证。
- 哪些失败生成了后续循环。
- 哪些风险仍未闭环。

只有关键完成标准都被闭环证据覆盖时，路线图环节才允许自动完成。

### 8. 开启下一轮

如果当前环节未满足完成标准，插件生成下一轮微观循环：

- 补验证。
- 修失败。
- 纠偏。
- 处理遗漏。
- 继续实现未完成部分。

如果当前环节完成，插件可按路线图推荐下一环节，并从新的环节目标创建下一组微观循环。

## 自动推进规则

允许自动继续：

- 缺少验证但验证命令明确、安全、低成本。
- 验证失败且修复范围仍在本环节内。
- 部分完成且剩余工作属于原意图范围。
- 需要补充事实采集或设计对标。

必须停下确认：

- 发布、部署、上架。
- 删除、不可逆写入或外部消息发送。
- 权限、凭证、支付、生产数据。
- 路线图结构或产品方向变化。
- Agent 判断冲突且证据不能解决。

## 与现有执行经验层的关系

Run Digest 记录一次 Agent 运行的结构化经验。  
Micro Execution Trace 记录一个意图如何被规划、实施、验证、归因。

两者关系：

```text
一个微观循环可以包含多个 run digest
一个 run digest 也可能只支撑某个微观循环的一部分证据
```

第一版可以从 run digest 反推微观循环；更稳定的形态是先创建微观循环，再让 run digest 作为证据进入循环。

## 禁止项

- 禁止让 Agent 自己写最终状态并直接推动路线图。
- 禁止把 CLI 退出码当作完成状态。
- 禁止没有证据就关闭循环。
- 禁止把三个 Agent 分工暴露成用户必须管理的组织结构。
- 禁止把六阶段误实现成固定六次 Agent session。
- 禁止把四分工误实现成默认四个独立 Agent 进程。
- 禁止把插件事实账本做成用户手工表单。
- 禁止把失败更早中止当成可靠闭环；失败必须生成可继续推进的下一步。
- 禁止让 Agent 主观评分替代插件硬闸门。

## 相关入口

- `docs/methodology/micro-execution-loop-methodology.zh.md`
- `docs/architecture/micro-execution-loop-scoring-gates.zh.md`
- `docs/ui/execution-trace-panel-guidelines.zh.md`
- `docs/architecture/agent-collaboration-boundary.zh.md`
- `docs/architecture/execution-experience-layer.zh.md`
- `docs/methodology/agent-task-flow-methodology.zh.md`
