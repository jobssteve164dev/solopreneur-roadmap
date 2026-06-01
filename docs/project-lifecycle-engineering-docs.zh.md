# 项目生命周期工程文档体系方法论

## 这份文档解决什么判断

这份文档解决 SoloMap harness 应该如何约束 Agent 产出项目解释性文档的问题：既避免 Agent 不沉淀长期判断，也避免 Agent 随意创建大量难以查阅、没有工程体系的文档。

核心判断只有一句：**工程文档不是记录做过什么，而是降低未来的人和 Agent 的判断负担。**

## 适用范围

本文约束项目内 `docs/`、`README.md`、架构说明、产品说明、UI 指南、数据归属说明、发布说明和决策记录等解释性文档。

本文不约束以下内容：

- `.solopreneur/step-memory/` 中的环节交接记录。
- `.solopreneur/agent-runs/` 中的运行日志、prompt、输出和 touched files。
- `.solomap-global/memory/` 中的跨项目长期记忆。
- `.solomap-global/learning/candidates/` 中的跨项目学习候选。
- 用户明确要求的一次性草稿、市场文案、内容成品或临时分析。

这些内容可以存在，但不能伪装成项目长期解释性文档。

## 第一原则

项目解释性文档只在一个判断需要长期复用时产生。

如果一份文档不能帮助未来读者回答“为什么这样设计、边界在哪里、下一次应该如何判断”，它就不应该进入项目长期文档体系。

## 文档职责

项目内解释性文档只承担五类职责。

### 1. 定义方向

说明项目是什么、不是什么、服务谁、成功标准是什么。

适合文档：

- `README.md`
- `docs/product-positioning.zh.md`
- `docs/business-plan.zh.md`

不适合写入：

- 当前任务完成总结。
- 临时灵感堆叠。
- 面向 Agent 的执行过程。

### 2. 解释模型

说明项目如何理解用户、生命周期、核心流程、关键对象和工作节奏。

适合文档：

- `docs/project-lifecycle-model.zh.md`
- `docs/project-type-templates.zh.md`
- `docs/global-methodology.zh.md`

不适合写入：

- 单次执行中的任务拆解。
- 为了显得完整而补出的抽象概念。
- 需要用户理解内部实现才能使用产品的对象模型。

### 3. 固定边界

说明哪些属于系统职责，哪些不该暴露给用户，哪些不能做。

适合文档：

- `docs/cross-agent-harness.zh.md`
- `docs/data-ownership.zh.md`
- `docs/ui/<surface>-guidelines.zh.md`

不适合写入：

- 代码实现细节流水。
- 临时兼容方案。
- 可以由测试或类型系统表达的普通约束。

### 4. 记录决策

说明为什么选择这个方向、放弃了什么替代方案、以后哪些设计必须遵守。

适合路径：

- `docs/decisions/YYYY-MM-DD-short-title.zh.md`

不适合写入：

- 没有长期影响的小修小补。
- 没有替代方案的普通实现选择。
- 事后包装出来的伪决策。

### 5. 说明运行

说明如何开发、验证、发布、安装、回滚和排障。

适合文档：

- `docs/release-and-distribution.zh.md`
- `docs/local-dev.zh.md`
- `docs/troubleshooting.zh.md`

不适合写入：

- 某一次命令输出全文。
- CI 临时失败日志。
- 已经过期的本地环境状态。

## 标准文档地图

一个长期项目可以收敛到以下稳定结构：

```text
README.md
docs/product-positioning.zh.md
docs/project-lifecycle-model.zh.md
docs/data-ownership.zh.md
docs/release-and-distribution.zh.md
docs/ui/<surface>-guidelines.zh.md
docs/decisions/YYYY-MM-DD-short-title.zh.md
```

不是每个项目一开始都必须拥有全部文档。文档由生命周期事件触发，而不是由 Agent 兴致触发。

## 生命周期触发条件

### 项目启动

触发条件：

- 新项目初始化。
- 项目目标、用户或成功标准不清楚。
- 后续 Agent 容易不知道项目到底要服务谁。

应产出或更新：

- `README.md`
- `docs/product-positioning.zh.md`

### 生命周期模型成型

触发条件：

- 项目出现稳定的阶段模型、工作流或推进节奏。
- 同一项目类型未来可能复用这套路线路径。
- UI 或路线图需要按该模型做长期判断。

应产出或更新：

- `docs/project-lifecycle-model.zh.md`
- `docs/project-type-templates.zh.md`

### 关键 UI 或治理面形成

触发条件：

- 一个页面、面板或治理入口承担长期用户动作。
- 多次讨论都围绕同一套用户心智、边界或禁忌。
- 内部实现差异有泄漏到用户界面的风险。

应产出或更新：

- `docs/ui/<surface>-guidelines.zh.md`
- 已存在的相关 UI 指南。

### 不可轻易反转的决策出现

触发条件：

- 选择会影响后续架构、路线图、用户心智或数据归属。
- 存在明确替代方案，并且未来可能再次争论。
- 决策错误会造成长期返工或用户体验偏航。

应产出：

- `docs/decisions/YYYY-MM-DD-short-title.zh.md`

### 数据归属或文件结构稳定

触发条件：

- 项目内数据、全局数据、缓存、记忆、运行记录之间的边界会影响 Agent 行为。
- 删除、迁移、同步或 Git 管理风险需要被长期理解。

应产出或更新：

- `docs/data-ownership.zh.md`
- `.solopreneur/README.md`

### 发布链路稳定

触发条件：

- 项目有稳定的 CI/CD、打包、市场发布、部署或安装链路。
- 发布失败会直接影响用户拿到产品。

应产出或更新：

- `docs/release-and-distribution.zh.md`
- 必要时补充 `docs/troubleshooting.zh.md`

## 文档骨架

解释性文档默认使用以下骨架：

```md
# 标题

## 这份文档解决什么判断

一句话说明未来读者看它是为了避免什么误判。

## 适用范围

它约束哪些功能、页面、流程、数据或项目阶段。

## 核心原则

3-7 条稳定原则。

## 正式规则

现在系统应该怎么做。

## 禁止项

哪些做法会导致偏航。

## 相关入口

代码路径、UI 页面、工作流、关联文档。
```

决策文档使用更短骨架：

```md
# 决策标题

## 背景

当时出现了什么分歧。

## 决策

最终选择什么。

## 理由

为什么这样选。

## 影响

以后哪些设计、实现或文档必须遵守。

## 不再采用

明确排除哪些方案。
```

## Harness 文档产出契约

SoloMap harness 应在 Agent prompt 中加入固定文档判断：

```text
本轮是否产生长期解释性文档价值？

- 没有：不要新增 docs 文档。
- 有：优先更新已有相关文档；只有当前文档地图没有合适位置时，才按规范路径新建。
- 不能把执行日志、过程总结、临时计划、Agent 心路历程写进 docs。
- 如果只是本轮交接，写入 step-memory。
- 如果只是跨项目候选，写入 learning candidates。
- 如果只是未验证观察，写入 memory inbox 或本轮输出，不进入长期项目文档。
```

Agent 如需新增或修改解释性文档，必须在最终输出中说明：

- 文档路径。
- 文档职责。
- 解决了什么长期判断。
- 为什么不是 step-memory、learning candidate 或临时输出。

## `documentation.json` Manifest

SoloMap harness 使用项目内 `.solopreneur/documentation.json` 作为文档体系 manifest。它不是文档正文，也不是给用户手写维护的配置，而是插件维护的文档路由账本和审计状态。

它承担三件事：

- 记录当前项目有哪些正式解释性文档、各自承担什么职责。
- 让 Agent 启动前知道应该优先更新哪份既有文档，而不是靠猜测新建文件。
- 让运行结束后的文档审计有结构化落点，例如低语义文件名、日志污染或缺少长期判断结构。

建议结构：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-06-01T00:00:00.000Z",
  "documents": [
    {
      "path": "README.md",
      "role": "direction",
      "status": "active",
      "solves": "说明项目是什么、服务谁、成功标准和对外表达。",
      "lastReviewedAt": "",
      "lastTouchedAt": "2026-06-01T00:00:00.000Z"
    }
  ],
  "pendingReview": [
    {
      "path": "docs/summary.md",
      "reason": "低语义文件名，疑似把本轮总结或过程记录放进长期项目文档。",
      "severity": "warning",
      "detectedAt": "2026-06-01T00:00:00.000Z",
      "source": "documentation_audit"
    }
  ],
  "lastAudit": {
    "auditedAt": "2026-06-01T00:00:00.000Z",
    "runKind": "step",
    "nodeId": "2",
    "status": "Completed",
    "action": "needs_review",
    "touchedDocuments": ["docs/summary.md"],
    "pendingReviewCount": 1
  }
}
```

边界：

- `documentation.json` 只保存索引、职责和审计状态，不保存文档正文。
- Agent 不应手动编辑它；插件在项目刷新、Agent prompt 构建和运行结束时维护。
- 它不能阻断主任务完成；风险只进入运行结果提示或 Agent 审视的 `needsConfirmation`。
- 它不替代 `.solopreneur/step-memory/`、`.solomap-global/learning/candidates/` 或 `.solomap-global/memory/`。

## 文档路由表

| 情况 | 正确去处 | 不应去处 |
| --- | --- | --- |
| 本轮做了什么、改了哪里、怎么验证 | `.solopreneur/step-memory/` | `docs/summary.md` |
| 形成长期产品定位 | `docs/product-positioning.zh.md` 或 `README.md` | `docs/notes.md` |
| 形成长期 UI 行动模型 | `docs/ui/<surface>-guidelines.zh.md` | `docs/ui-random.md` |
| 做出长期方向决策 | `docs/decisions/YYYY-MM-DD-short-title.zh.md` | `docs/final-decision.md` |
| 发现可能跨项目复用的经验 | `.solomap-global/learning/candidates/` | 当前项目 `docs/` |
| 稳定项目事实 | `.solomap-global/memory/projects/<project>.md` 或项目正式文档 | 临时总结文件 |
| 发布、安装、回滚规则 | `docs/release-and-distribution.zh.md` | CI 日志复制文档 |
| 临时排障观察 | 本轮输出、run log、memory inbox | 长期指南 |

## 命名规则

允许：

```text
docs/product-positioning.zh.md
docs/project-lifecycle-model.zh.md
docs/data-ownership.zh.md
docs/release-and-distribution.zh.md
docs/ui/today-plan-sidebar-guidelines.zh.md
docs/decisions/2026-06-01-contextual-agent-review.zh.md
```

不允许 Agent 自行创建低语义文件：

```text
docs/summary.md
docs/notes.md
docs/final.md
docs/implementation.md
docs/plan.md
docs/temp.md
docs/design.md
```

如果项目已有历史低语义文档，Agent 可以读取，但不能继续扩散同类命名。

## 文档卫生审计

Harness 在任务结束后可以扫描新增或修改的文档，并标记风险：

- 未归属文档：新增文档不在规范路径中。
- 低语义命名：文件名无法表达长期职责。
- 过程日志污染：内容主要是命令输出、执行流水或 prompt。
- 重复解释：与已有文档职责重叠。
- 缺少判断目标：没有说明这份文档解决什么长期判断。
- 用户心智污染：把内部对象、文件结构或治理负担暴露成用户必须理解的概念。

审计默认不删除文件。它只把风险作为 Agent 审视的 `needsConfirmation` 或运行结果提示，让用户决定是否整理、保留或忽略。

## 禁止项

- 禁止把“写了文档”当成“完成了交付”。
- 禁止把执行流水、日志、prompt 或终端输出复制进长期项目文档。
- 禁止为了显得完整而新增空泛文档。
- 禁止同一主题分散到多个相互重叠的文档。
- 禁止让普通用户读项目文档后还要理解系统内部治理对象才能继续行动。
- 禁止把跨项目经验直接塞进单项目 docs，除非它已经成为该项目正式设计的一部分。

## SoloMap 插件当前适用建议

SoloMap 插件自身应逐步收敛到以下解释性文档体系：

```text
docs/product-positioning.zh.md
docs/project-lifecycle-model.zh.md
docs/cross-agent-harness.zh.md
docs/project-lifecycle-engineering-docs.zh.md
docs/data-ownership.zh.md
docs/release-and-distribution.zh.md
docs/ui/*.zh.md
docs/decisions/*.zh.md
```

当前已有文档可继续保留，但后续新增文档应先判断是否属于上述体系；若不属于，优先更新现有文档或写入运行记录、学习候选、项目记忆。

## 相关入口

- `docs/cross-agent-harness.zh.md`
- `docs/today-plan-sidebar-guidelines.zh.md`
- `docs/global-execution-guide.zh.md`
- `docs/global-methodology.zh.md`
- `src/extension.ts`
- `src/sidebarProvider.ts`
