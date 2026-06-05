# 微观执行循环评分与闸门设计

## 这份文档解决什么判断

这份文档固定 SoloMap 如何量化评审一个微观执行循环，避免“Verifier Agent 凭感觉说通过”变成新的黑箱。

核心判断只有一句：**评分者不是 Agent，而是插件；评分依据不是主观评价，而是结构化 checklist、可引用证据和硬闸门。**

## 设计目标

评分制度不是为了评价 Agent 聪不聪明，而是为了防止微观循环假闭环。

它必须做到：

- 插件可以机械执行。
- 每个分数项都有明确字段或事实来源。
- Agent 只能提供候选判断和解释，不能直接决定最终分。
- 硬闸门决定状态，分数只解释质量。
- 没有证据的 `pass` 无效。

## 三层评分模型

```text
硬闸门 = 决定能不能进入下一状态
计分项 = 解释 Planner / Builder / Verifier 哪一段弱
证据绑定 = 每个 pass 必须指向字段、文件、命令、diff、测试或人工确认
```

禁止使用抽象总评作为状态依据：

```text
禁止：微循环总分 85，所以 closed
推荐：verificationExecuted=false，所以 implemented_unverified
```

## Planner 结构化输出

Planner 必须输出结构化计划，不能只输出自然语言方案。

推荐最小结构：

```json
{
  "intent": {
    "goal": "",
    "source": "roadmap_step | solo | issue | test_failure | agent_finding | followup",
    "userOutcome": "",
    "successCriteria": [""]
  },
  "scope": {
    "inScope": [""],
    "outOfScope": [""]
  },
  "impact": {
    "expectedFiles": [""],
    "expectedModules": [""],
    "userFacingChange": false
  },
  "verificationPlan": [
    {
      "type": "test | build | lint | typecheck | manual | screenshot | smoke",
      "command": "",
      "manualStep": "",
      "proves": ""
    }
  ],
  "risk": {
    "requiresUserConfirmation": false,
    "riskReasons": []
  }
}
```

### Planner 计分项

| 项 | 插件检查方式 | 分 |
| --- | --- | --- |
| `intent.goal` 非空 | 字段存在且长度超过最小阈值 | 1 |
| `intent.userOutcome` 非空 | 必须描述用户结果，不能只是文件名或内部对象 | 1 |
| `intent.successCriteria` 非空 | 至少 1 条完成标准 | 1 |
| `scope.inScope` 非空 | 至少 1 条本轮范围 | 1 |
| `scope.outOfScope` 字段存在 | 可为空，但字段必须存在 | 1 |
| 影响范围明确 | `expectedFiles` 或 `expectedModules` 至少一个非空 | 1 |
| 有验证计划 | `verificationPlan` 至少 1 条 | 2 |
| 高风险声明存在 | `requiresUserConfirmation` 必填 | 1 |

Planner 满分 9 分。

### Planner 硬闸门

| 闸门 | 不满足时状态 |
| --- | --- |
| `intent.goal` 存在 | `planning_incomplete` |
| `intent.successCriteria` 非空 | `planning_incomplete` |
| `verificationPlan` 非空，除非插件判定为纯讨论或无需验证的文档判断 | `planning_incomplete` |
| `requiresUserConfirmation=false`，或用户已确认 | `needs_user_confirmation` |

Planner 分数低不一定阻断，但硬闸门不通过不能进入 Builder。

## Builder 结构化输出

Builder 必须输出动作清单和自测记录，但插件不能直接相信它。

推荐最小结构：

```json
{
  "actions": [
    {
      "type": "add_capability | modify_path | fix_defect | harden_boundary | add_verification | reduce_debt | revert_deviation | update_docs",
      "summary": "",
      "files": [""],
      "linkedCriteria": [""]
    }
  ],
  "commandsRun": [
    {
      "command": "",
      "exitCode": 0,
      "proves": ""
    }
  ],
  "knownGaps": []
}
```

插件需要把 Builder 输出与真实文件哨兵、git diff、命令记录和测试结果对照。

### Builder 计分项

| 项 | 插件检查方式 | 分 |
| --- | --- | --- |
| 有真实 touched files | 文件哨兵、git status 或 diff 采集到变化；纯分析任务可豁免 | 2 |
| touched files 与计划影响范围有交集 | 与 `expectedFiles` 或 `expectedModules` 命中 | 2 |
| 每个 action 绑定完成标准 | `linkedCriteria` 至少命中 1 条 `successCriteria` | 1 |
| 未出现未解释的大范围越界变更 | diff 文件没有明显超出 `inScope/expectedFiles`，或有结构化解释 | 2 |
| 运行了计划中的验证 | `commandsRun` 或插件命令记录匹配 `verificationPlan` | 2 |
| 验证通过 | 对应命令 exitCode 为 0，或人工/截图证据通过 | 2 |
| `knownGaps` 字段存在 | 可为空，但必须显式 | 1 |

Builder 满分 12 分。

### Builder 硬闸门

| 闸门 | 不满足时状态 |
| --- | --- |
| 任务需要改动时，必须有真实动作证据 | `no_effect` |
| 有文件变化时，必须有动作清单 | `implemented_unverified` |
| 必跑验证未执行 | `implemented_unverified` |
| 必跑验证执行但失败 | `verified_failed` |
| diff 明显超出范围且无解释 | `deviated` |

Builder 的自述不能替代插件采集到的事实。

## Verifier 结构化输出

Verifier 只读复核，输出结构化检查结果。它可以建议状态，但不能写最终状态。

推荐最小结构：

```json
{
  "checks": [
    {
      "criterion": "",
      "status": "pass | fail | partial | unclear",
      "evidence": [
        "file:src/sidebarProvider.ts",
        "test:test/webview-regression.test.js",
        "command:npm test -- webview-regression.test.js"
      ],
      "reason": ""
    }
  ],
  "recommendedStatus": "closed | implemented_unverified | verified_failed | partial | deviated | needs_user_confirmation",
  "requiredFollowups": []
}
```

### Verifier 计分项

| 项 | 插件检查方式 | 分 |
| --- | --- | --- |
| 覆盖所有完成标准 | 每条 `successCriteria` 都有对应 check | 3 |
| 每个 `pass` 有 evidence | `pass` 不能没有证据引用 | 3 |
| evidence 引用真实存在 | 文件、命令、测试、commit、人工确认可解析 | 2 |
| `recommendedStatus` 合法 | 枚举值匹配允许状态 | 1 |
| fail/partial 时有 followup | `requiredFollowups` 非空且可执行 | 2 |

Verifier 满分 11 分。

### Verifier 硬闸门

| 闸门 | 插件处理 |
| --- | --- |
| `pass` 没有 evidence | 该 `pass` 无效 |
| evidence 引用不存在 | 该 check 无效 |
| successCriteria 未全部覆盖 | 不能 `closed` |
| Verifier 建议 `closed` 但插件硬证据不足 | 插件覆盖为 `implemented_unverified`、`verified_failed`、`partial` 或 `deviated` |

Verifier 的作用是发现缺口和给出候选裁决，不是替插件裁判。

## Plugin 硬闸门

插件不打智能分，只做事实裁判。

推荐闸门结构：

```json
{
  "gates": {
    "intentDefined": true,
    "planComplete": true,
    "actionsObserved": true,
    "verificationExecuted": true,
    "verificationPassed": true,
    "criteriaCovered": true,
    "scopeRespected": true,
    "roadmapAttributionValid": true,
    "userConfirmationRequired": false
  }
}
```

### 最终状态规则

插件按固定顺序计算最终状态：

```text
if userConfirmationRequired -> needs_user_confirmation
else if !intentDefined or !planComplete -> planning_incomplete
else if !actionsObserved -> no_effect
else if !verificationExecuted -> implemented_unverified
else if !verificationPassed -> verified_failed
else if !criteriaCovered -> partial
else if !scopeRespected -> deviated
else if !roadmapAttributionValid -> unassigned
else -> closed
```

顺序很重要。比如验证没执行时，即使 Planner 和 Verifier 分数很高，也不能进入 `closed`。

## 微观循环评分结果结构

推荐保存到单个 trace 的 `scoring` 字段：

```json
{
  "scoring": {
    "planner": {
      "passed": 8,
      "total": 9,
      "failedItems": ["scope.outOfScope"],
      "hardGateFailures": []
    },
    "builder": {
      "passed": 6,
      "total": 12,
      "failedItems": ["verificationPlan.command.not_run"],
      "hardGateFailures": ["verificationExecuted"]
    },
    "verifier": {
      "passed": 9,
      "total": 11,
      "failedItems": ["criterion.coverage.partial"],
      "hardGateFailures": []
    },
    "pluginGates": {
      "intentDefined": true,
      "planComplete": true,
      "actionsObserved": true,
      "verificationExecuted": false,
      "verificationPassed": false,
      "criteriaCovered": false,
      "scopeRespected": true,
      "roadmapAttributionValid": true,
      "userConfirmationRequired": false
    },
    "finalStatus": "implemented_unverified",
    "statusReason": "计划要求运行验证命令，但本轮没有可采信的验证记录。"
  }
}
```

## 前台展示原则

执行轨迹面板不应把评分表作为主界面。

主界面只显示用户能行动的结论：

```text
状态：已实施，待验证
原因：计划要求运行 webview regression test，但本轮没有验证记录。
下一步：补充验证
```

下钻时才显示：

```text
Planner 8/9
Builder 6/12
Verifier 9/11
硬闸门：verificationExecuted = false
最终状态：implemented_unverified
```

## 禁止项

- 禁止让 Agent 输出一个总分作为最终裁决。
- 禁止没有 evidence 的 `pass` 计入通过。
- 禁止用高总分覆盖硬闸门失败。
- 禁止 CLI 退出码为 0 就自动 `closed`。
- 禁止把评分制度做成用户手工打分表。
- 禁止让 Verifier 的自然语言意见直接推动路线图。

## 相关入口

- `docs/architecture/micro-execution-loop-flow.zh.md`
- `docs/methodology/micro-execution-loop-methodology.zh.md`
- `docs/ui/execution-trace-panel-guidelines.zh.md`
