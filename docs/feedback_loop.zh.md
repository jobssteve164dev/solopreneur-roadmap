# SoloMap 反馈记录与支持循环

## 核心概念

反馈循环不只是收集用户意见，而是建立一套从**用户信号 -> 理解 -> 改进 -> 学习 -> 沉淀**的闭合链路。在这个过程中，我们同时维护**宏观可见性**（路线图阶段、环节进度）和**微观可见性**（具体代码改动、设计实现对标）。

---

## 一、反馈来源与收集

### 1.1 反馈源渠道

| 来源 | 性质 | 收集方式 | 优先级 |
|------|------|--------|-------|
| GitHub Issues | 结构化问题报告 | `gh` CLI 自动拉取、.solopreneur/issues-cache.json 缓存 | P0 |
| 代码提交的 commit message | 开发者自述 | Git log 分析 + 提交摘要 | P1 |
| Agent 运行日志 | 自动化执行过程 | .solopreneur/agent-runs/<nodeId>/output.log | P1 |
| 环节交接 JSON | 结构化决策 | .solopreneur/step-memory/<nodeId>.json entries | P1 |
| 用户补充要求 | 实时上下文调整 | Agent 对话中的 supplement | P0 |
| 路线图修订记录 | 优先级和方向变化 | .solopreneur/roadmap.csv 变更 + Agent 改写日志 | P1 |
| 全局经验库 | 跨项目学习信号 | .solomap-global/learning/candidates | P2 |

### 1.2 Issue 标注规则（分类 + 优先级 + 处理路径）

#### 标签体系

**类别标签**（categories，单选）：
- `bug` - 功能故障或缺陷
- `feature-request` - 新功能需求
- `enhancement` - 现有功能改进
- `tech-debt` - 技术债/代码质量
- `design-review` - 架构或设计问题
- `documentation` - 文档不完整或错误
- `question` - 用户问题/需求澄清

**优先级标签**（single）：
- `P0` - 阻塞核心功能，立即处理
- `P1` - 重要功能或体验问题，本周处理
- `P2` - 可选改进，本月处理
- `P3` - 长期积累的建议

**阶段标签**（single）：
- `stage:discovery` - 需要进一步了解用户需求
- `stage:design` - 需要设计方案
- `stage:implementation` - 已确认设计，可实施
- `stage:verification` - 实施完成，等待验证
- `stage:closed` - 已解决或不再处理

**其他标签**：
- `microservice:<模块名>` - 关联的主要模块（sync-engine, sidebar-provider, agent-impact 等）
- `requires-design-update` - 涉及的设计文档需更新
- `requires-test-addition` - 需要补充测试用例
- `blocks-roadmap-<nodeId>` - 阻塞路线图某环节
- `ecosystem-integration` - 与外部系统集成相关

#### Issue 处理流程

1. **初始分类**（提交者或 triage 人员，<1 天）
   - 标记类别、优先级
   - 关联涉及模块
   - 填写初始的 acceptance criteria

2. **需求澄清**（如需，P0/P1 优先，<3 天）
   - 如标记为 `stage:discovery`，Agent 或用户通过评论补充上下文
   - 如需设计讨论，邀请路线图相关模块负责人（或 Agent）

3. **设计与规划**（<1 周）
   - 标记为 `stage:design`
   - 生成对应的 `docs/design/*` 或 `docs/decisions/*` 文档
   - 在路线图中创建对应环节或更新现有环节

4. **实施**（变量，取决于工作量）
   - 标记为 `stage:implementation`
   - Agent 执行路线图环节，生成实现工件
   - 在评论中链接对应的环节交接 JSON

5. **验证**（P0: <1 天，P1: <1 周）
   - 标记为 `stage:verification`
   - 自动生成或手工复查实现工件
   - 验证范围：功能完成 + 设计符合 + 测试通过

6. **关闭**（验证通过后）
   - 标记为 `stage:closed`
   - 在评论中总结交付内容、相关工件链接
   - 沉淀可复用的决策或模式到 `.solomap-global/memory`

---

## 二、支持回复模板

### 2.1 Bug 报告的标准回复

```markdown
感谢报告！已确认此问题。

**问题确认**
- 复现环境：[系统版本/项目配置]
- 影响范围：[当前只影响该场景，还是更广？]
- 根因分析：[初步判断的技术根因]

**预期处理**
- 优先级：P0（阻塞） / P1（重要）/ P2（可选）
- 计划修复：[路线图环节名] 或 [预计周期]
- 涉及模块：[关联的 microservice 标签]

**下一步**
- [如需用户提供信息，具体说明]
- [链接到对应的路线图环节或 Agent 对话]

感谢你的反馈！
```

### 2.2 功能请求的标准回复

```markdown
感谢建议！

**需求确认**
- 用户场景：[具体用户想做什么事情]
- 当前痛点：[现在为什么困难或无法做]
- 预期改进：[改进后应该怎样]

**初步评估**
- 与当前方向的契合度：[完全契合 / 有一定偏差 / 需后续讨论]
- 工作量估计：[小 / 中 / 大]
- 可能的实现方向：[技术思路简述，或"需要进一步设计"]

**后续流程**
1. 如评估为重要需求，会在下一轮路线图调整中规划
2. 如需进一步讨论，会在此评论中继续
3. 一旦开始设计，会在 `docs/design/` 中创建对应文档

感谢！
```

### 2.3 技术债或设计问题的标准回复

```markdown
已记录。

**问题范围**
- 涉及模块：[module names]
- 当前风险等级：[低 / 中 / 高]
- 与其他工作的依赖关系：[是否阻塞后续开发]

**沉淀地点**
- 设计文档：`docs/design/[module].zh.md`
- 或决策记录：`docs/decisions/[decision-name].zh.md`
- 或技术债列表：`.solopreneur/health/tech-debt.md`

**处理时间表**
- 短期（<1 周）缓解措施：[如有]
- 中期（<1 月）完整解决方案：[链接到设计或路线图环节]
- 长期监控：[后续检查清单]

感谢指正！
```

### 2.4 验证完成的标准回复

```markdown
✅ 已完成并验证。

**交付内容**
- 实现环节：[路线图环节链接]
- 关键改动：[文件列表、功能点]
- 测试覆盖：[新增测试、修改测试、覆盖率变化]

**质量报告**
- 设计符合度：[100% / 85% with deviations / ]
- 测试状态：全部通过 / 有已知限制
- 技术债新增：[无 / 已记录为 tech-debt issue]

**如何验证**
1. 拉取最新代码
2. 运行：`npm test` / `npm run build`
3. 在 VS Code 中手工测试：[具体步骤]

链接相关工件：
- 设计文档：docs/design/...
- 实现记录：.solopreneur/agent-runs/.../implementation.json
- 对标报告：docs/decisions/...-design-compliance.zh.md

感谢你的耐心等待！
```

---

## 三、每周 Learn/Improve 复盘格式

在每个周期（通常是环节完成或固定的周回顾）执行以下复盘。复盘结果保存在 `.solopreneur/health/weekly-reviews/` 目录中。

### 3.1 复盘文档结构

**文件名**: `weekly-review-<年周数>-<日期>.md`
**例**: `weekly-review-2026-w23-2026-06-07.md`

```markdown
# 第 23 周复盘 (2026-06-01 ~ 2026-06-07)

## 📊 本周关键信号

### 用户反馈汇总
- **Issue 处理**：5 个 Issue 新建，2 个 Issue 关闭
  - 重点问题：[标题] (P0/P1)
  - 用户满意度信号：[是否有正向/负向反馈]
  
### 代码交付
- **完成环节**：[路线图环节名] (commit SHA)
- **行数变更**：总计 +<n> / -<n> 行
- **模块涉及**：[主要模块]
- **测试状况**：通过 <n>/<m> 用例，覆盖率 <n>%

### 架构健康度
- **代码质量得分**：上周 <score1> -> 本周 <score2> （趋势 ↑ / ↓ / → ）
- **技术债**：新增 <n> 项，解决 <n> 项，净增加 <n> 项
- **关键模块风险**：[模块名]: <低 / 中 / 高>

---

## 🎯 Learn - 学习

### 设计决策回顾
**问题**：[本周遇到的核心设计挑战]

**过程**：
- 初始想法：[what we tried]
- 遇到的问题：[what didn't work]
- 最终方案：[what we chose]

**文档沉淀**：
- 对应设计文档：`docs/design/[].zh.md` 或 `docs/decisions/[].zh.md`

---

### 用户见解（来自 Issue / 反馈）
**高价值观察**（会影响后续路线）：
1. [用户普遍在抱怨的问题 / 期望]
   - 影响面：[影响多少用户或场景]
   - 建议路线图调整：[如需]

2. [发现的遗漏的需求]
   - 原因：[为什么之前没考虑到]
   - 改进方向：[后续应该]

**文档沉淀**：
- 更新：`docs/customer_discovery.zh.md` 或 `.solomap-global/memory/projects/solopreneur-roadmap.md`

---

### 技术积累
**本周学到的模式（可跨项目复用）**：
- [pattern-1]: [简述]
  - 应用场景：[什么时候用]
  - 源代码：[src 文件]
  - 对应文档：[docs 文档]

**本周遇到的排障方法（可沉淀为 decision 或 pattern）**：
- [排障名]: [how we debugged it]

**文档沉淀**：
- 新增 pattern：`.solomap-global/memory/patterns/[pattern-name].md`
- 新增 decision：`.solomap-global/memory/decisions/[decision-name].md`

---

## ↗️ Improve - 改进

### 优先级排序（基于本周信号）

| 优先级 | 工作项 | 理由 | 计划时间 |
|-------|------|------|--------|
| P0 | [阻塞用户或质量的问题] | [根因] | 下周启动 / 下月启动 |
| P1 | [影响核心体验的改进] | [user signal or tech debt] | |
| P2 | [可选的增强] | | |

### 路线图调整建议
**是否需要调整路线图**：是 / 否

如是：
- **理由**：[用户反馈/技术发现/优先级变化]
- **建议调整**：
  - 新增环节：[description]
  - 调整优先级：从 [旧] 到 [新]
  - 移除或推迟：[reason]
  - 估计工作量变化：[+<n> days / -<n> days]

**后续流程**：
- [ ] Agent 负责在下周一启动"调整路线图"环节
- [ ] 或用户手工更新 `.solopreneur/roadmap.csv`

---

## 📝 质量指标追踪

```
周数    | 代码覆盖率 | 技术债(项) | 用户反馈(个) | Issue 平均解决(天) | 架构健康分
--------|----------|----------|-----------|------------|----------
w22     | 65%      | 12       | 8         | 5          | 72
w23     | 67%      | 13       | 5         | 4          | 75
趋势    | ↑        | ↑        | ↓         | ↓          | ↑
```

---

## 🔄 下周计划

基于本周学习和改进建议，下周的核心工作：

1. **继续推进**：[上周未完成的环节]
2. **新启动**：[本周复盘选出的高优先级工作]
3. **关注的风险**：[需要监控的问题]

---

## 📎 附件与链接

- 完整的 Issue 列表：[link]
- Agent 运行日志：[link to .solopreneur/agent-runs/]
- 改动设计文档列表：[link]
- 提交历史（本周）：[link to Git log]
- 上周复盘：[link]

---

复盘完成时间：<date> | 复盘执行者：Agent / User
```

### 3.2 每周复盘的生成流程

1. **收集阶段**（通常在周末或周一早）
   - Agent 或自动脚本扫描本周的 GitHub Issues、提交、Agent 运行日志
   - 生成初始的"本周信号"部分

2. **审视阶段**（开发者或用户，<30 min）
   - 补充设计决策的学习点
   - 标记高价值观察
   - 调整优先级排序

3. **沉淀阶段**
   - 自动更新 `patterns/`、`decisions/`、`projects/` 等长期记忆
   - 生成下周的路线图调整建议（如有）

4. **关闭阶段**
   - 提交复盘文档到 Git
   - 归档到 `.solomap-global/memory/` 的学习候选区

---

## 四、路线图调整触发条件

什么情况下应该启动"调整路线图"环节：

### 4.1 用户信号驱动

| 触发条件 | 严重程度 | 响应时间 | 调整类型 |
|--------|--------|--------|--------|
| **P0 bug 发现**：阻塞核心功能 | 紧急 | <1 天 | 插入新环节修复，调整优先级 |
| **用户普遍反馈**：5+ 个相似反馈 | 高 | <1 周 | 新增功能环节或重排优先级 |
| **关键技术债**：影响后续开发速度 | 高 | <1 周 | 新增重构环节或并行 tech-debt 环节 |
| **市场信号**：竞品发布、客户需求变化 | 中 | <1 月 | 方向调整、长期路线图更新 |
| **内部学习**：模型/方法论更新 | 中 | <1 月 | 流程优化、工具链升级 |

### 4.2 定期评审

- **每周一**：周复盘后，如有优先级变化，启动路线图微调
- **每个月**：综合用户反馈 + 技术债 + 学习信号，启动一次完整路线图评审
- **季度末**：完整的阶段评审 + 下阶段规划

### 4.3 路线图调整的决策框架

启动调整前，确认以下问题：

1. **问题成立吗**？
   - 是真实的用户痛点，还是单次异常？
   - 有多少证据支持？（Issue 数、重复率、用户投票）

2. **与当前方向的关系**？
   - 是当前阶段（Build/Sell/Learn/Improve）的核心，还是偏离？
   - 是否可以在现有环节中处理，而不需要调整路线图？

3. **工作量评估**？
   - 新增功能 / 改进：需要多少环节，多长时间？
   - 重排优先级：会影响其他环节吗？

4. **决策**？
   - 马上调整 -> 启动"调整路线图"环节 + 新建或重排环节
   - 下周考虑 -> 记录在 backlog，下周复盘时再评估
   - 不调整 -> 在回复中说明理由

---

## 五、微观可见性工件

为了让团队和 Agent 能在不逐行 diff 的情况下理解项目改动，每个重要改动应附带以下工件：

### 5.1 实现总结工件

**生成时机**：功能完成、代码提交后
**格式**：`.solopreneur/agent-runs/<nodeId>/implementation.json`
**查看**: 在 Issue 或环节交接中链接

示例内容：
```json
{
  "module": "sync-engine",
  "feature": "增量 Webview 更新",
  "designRef": "docs/design/sync-engine.zh.md",
  "changes": [
    {
      "file": "src/db/syncEngine.ts",
      "type": "edit",
      "reason": "添加消息队列缓冲区，防止 JSON 过大"
    }
  ],
  "testCoverage": {
    "unitTests": {"new": 3, "modified": 2},
    "status": "passed"
  },
  "designCompliance": {
    "status": "compliant",
    "deviations": []
  }
}
```

### 5.2 设计对标报告

**生成时机**：大型改动完成、或定期审计
**格式**：`docs/decisions/<功能名>-design-compliance.zh.md`
**查看**: 在相关 Issue 中链接

内容示例见 `docs/architecture/microscopic-execution-visibility.zh.md` 第"实现工件"部分。

### 5.3 模块依赖图

**生成时机**：定期审计（每月）
**格式**：`.solopreneur/architecture/module-graph.json` + 可视化
**查看**: 在新成员 onboarding 或架构讨论中参考

---

## 六、集成到现有流程

### 反馈 -> 改动 -> 验证 的完整闭环

```
用户提交 Issue
    ↓
[Issue 分类 + 标注]（1 天内）
    ↓
[Agent / 设计师 分析] 生成 docs/design/* 或 docs/decisions/*
    ↓
[启动路线图环节]
    ↓
[Agent 执行] 生成 implementation.json + 设计对标报告
    ↓
[自动化验证] 运行测试、检查设计符合度
    ↓
[用户验收]（查看工件，而非逐行 diff）
    ↓
[Issue 关闭] + [学习沉淀]（周复盘时归档）
    ↓
[更新全局经验库]（如果是可复用的模式或决策）
```

---

## 七、初期实施计划

### Phase 1: 基础建设（2-3 周）
- [ ] 定义 Issue 标注规则（已在本文档中）
- [ ] 创建支持回复模板（已在本文档中）
- [ ] 初始化 `.solopreneur/health/weekly-reviews/` 目录
- [ ] 建立路线图调整的决策框架（已在本文档中）

### Phase 2: 工件规范化（3-4 周）
- [ ] 定义 implementation.json 的 JSON Schema
- [ ] 定义 design-compliance.md 的模板
- [ ] 为当前主要模块创建 `docs/design/` 文档
- [ ] Agent 改动后自动生成实现工件

### Phase 3: 长期运行（持续）
- [ ] 每周执行复盘和工件审计
- [ ] 每月评估是否需要路线图调整
- [ ] 季度评估整个反馈循环的有效性

---

## 参考文档

- 微观可见性框架详解：`docs/architecture/microscopic-execution-visibility.zh.md`
- 项目设计规范：`docs/design/` 目录
- 决策记录：`docs/decisions/` 目录
- 全局经验库：`.solomap-global/memory/`
