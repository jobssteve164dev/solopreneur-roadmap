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
implemented_unverified
verified_failed
partial
deviated
spawned_followup
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
| `implemented_unverified` | 有实施动作，但验证不足 |
| `verified_failed` | 验证明确失败 |
| `partial` | 部分目标完成 |
| `deviated` | 实际结果偏离意图 |
| `spawned_followup` | 已生成下一轮微观循环 |
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
  "createdAt": "",
  "updatedAt": ""
}
```

第一版可以把它保存为项目本地 JSON 或 JSONL；后续再纳入 SQLite/Execution Graph。

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
- 禁止把插件事实账本做成用户手工表单。
- 禁止把失败更早中止当成可靠闭环；失败必须生成可继续推进的下一步。

## 相关入口

- `docs/methodology/micro-execution-loop-methodology.zh.md`
- `docs/ui/execution-trace-panel-guidelines.zh.md`
- `docs/architecture/agent-collaboration-boundary.zh.md`
- `docs/architecture/execution-experience-layer.zh.md`
- `docs/methodology/agent-task-flow-methodology.zh.md`
