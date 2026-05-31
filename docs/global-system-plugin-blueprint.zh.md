# SoloMap 全局工程体系插件化蓝图

## 一句话目标

把全局工程方法论从文档变成 SoloMap 插件里的跨项目行动层：用户看到的是本周该推进什么、哪里被阻断、哪些经验能复用；后台再用 `.solomap-global` 维护项目组合、依赖、能力复用、学习候选和指标。

这份蓝图承接：

- `global-methodology.zh.md`：定义多项目并行和复利机制。
- `global-execution-guide.zh.md`：定义日/周/月执行动作和 `.solomap-global` 文件结构。
- `project-type-templates.zh.md`：定义项目类型和初始化路线图模板。
- `issue_panel_design_philosophy.zh.md`：定义 Issue 作为现实输入和决策链的角色。

## 设计判断

`.solomap-global` 不应该成为用户手工编辑的控制台，也不应该在 UI 里暴露成一组 CSV 表单。它应该是插件后台的跨项目事实层。

用户在前台完成的是行动：

- 选择或确认本周重点。
- 看见 P0 阻断和下一步。
- 新项目选择类型并快速初始化。
- 在路线图环节或 Solo 中推进 Agent 对话。
- 审核哪些经验值得跨项目复用。
- 看到 Issue 如何影响计划。

后台负责维护的是事实：

- 哪些项目存在。
- 哪个项目当前优先级最高。
- 哪些项目被其他项目阻断。
- 哪些能力已经验证并可复用。
- 哪些学习候选等待审核。
- 哪些跨项目决策出现冲突。
- 复利效果是否正在发生。

## 用户心智

SoloMap 的现有单项目心智保持不变：

```text
路线图 / Solo / Issue 输入 -> Agent 对话 -> 本地交付 -> 状态闭环
```

新增的全局心智是：

```text
项目组合 -> 本周重点 -> 当前项目下一步 -> 完成后提取可复用经验
```

因此 UI 不能把用户从“我要推进什么”拉到“我要维护什么全局对象”。所有后台对象都必须由用户动作自然产生。

## UI 蓝图

### 1. 侧边栏：今日安排面板

侧边栏顶部从普通项目列表升级为跨项目行动入口。当前正式形态以 `今日安排` 为主，详细约束见 [今日安排侧边栏设计指南](./today-plan-sidebar-guidelines.zh.md)。

首屏只回答三个问题：

```text
现在最该做什么？
为什么是它？
点哪里继续？
```

建议结构：

```text
今日安排
├─ 先处理：{项目名} · {阻断/失败/高优反馈}
├─ 主推进：{项目名} · {今天最值得推进的下一步}
└─ 收尾：{项目名} · {验证/复盘/学习候选}
```

每个项目卡片展示：

- 项目名。
- 项目类型。
- 当前状态。
- 推荐下一步。
- 是否被阻断。
- Issue 压力摘要。
- 是否存在可复用经验。

不展示：

- `portfolio.csv` 字段名。
- `dependencies.csv` 行。
- capability registry 的内部结构。
- 复杂优先级公式。

### 2. 新项目初始化：先问类型，再给起点

用户新建项目时，只需要回答一个稳定问题：

```text
这个项目更像哪一类？
```

可选项来自项目类型模板：

- 核心产品。
- 基础设施。
- 内容产品。
- 试验研究。
- 工具脚手架。
- 归档维护。

选择后后台执行：

1. 写入或更新 `.solomap-global/portfolio.csv`。
2. 根据类型生成项目内 `.solopreneur/roadmap.csv` 初始路线图。
3. 查询 `.codex-memory/projects/` 中的相似项目。
4. 查询 `.codex-memory/patterns/` 和 `decisions/` 中可复用起点。
5. 把结果作为 Agent 初始化上下文。

前台只需要显示：

```text
已找到 2 个相似项目和 4 条可复用经验。
```

不要要求用户手工填写 capability、dependency 或 memory 路径。

### 3. Roadmap 环节：保持主路径，自动补上下文

路线图环节仍然是项目执行主入口。全局体系不新增第二套执行入口，只增强每次 Agent 启动前的上下文。

Agent 启动前，后台生成 context pack：

```text
当前项目上下文
当前环节完成标准
相关 Issue 与评论链
相似项目经验
可复用 patterns
相关 decisions
被阻断或依赖信息
```

前台最多展示一句轻提示：

```text
已带入 3 条相关经验、2 个相关 Issue。
```

用户不需要手工选择“引用哪个全局文档”。

### 4. Solo 模式：未归类问题入口

Solo 继续承担“还不知道属于哪个环节”的自由对话入口。

一次 Solo 对话结束后，系统可以给出轻量归类动作：

- 保留在 Solo。
- 关联到已有路线图环节。
- 升级为 GitHub Issue。
- 作为学习候选。
- 进入路线图调整。

这些动作不应自动改变路线图结构。路线图调整仍由独立入口完成。

### 5. Issue 面板：现实输入，不是第三套任务系统

Issue 区域在选中项目卡片内展示，用于回答：

```text
现实中有哪些声音正在影响这个项目？
```

MVP 展示：

- open Issue 数量。
- bug / feature-request / tech-debt / discussion 分类。
- P0 / P1 / P2 标签。
- 最近评论摘要。
- 创建 Issue、展开评论、打开 GitHub、关闭 Issue。

Issue 数据自动进入：

- 路线图环节 Agent 上下文。
- Improve 阶段聚合。
- 路线图调整理由。
- 学习候选来源。

Issue 不应该变成“一键派发 Agent”的新主入口。Agent 执行仍在 Roadmap 或 Solo 输入区完成。

### 6. 每周审核工作台

全局方法论需要一个轻量审核入口，不是报表页。

周五或用户主动打开时，显示待处理列表：

```text
本周学习候选
├─ 候选 A：批准提升 / 留在项目 / 忽略
├─ 候选 B：批准提升 / 留在项目 / 忽略

决策冲突
├─ 冲突 A：确认统一 / 保持差异 / 延后

依赖阻断
├─ 项目 B 等待项目 A：升为 P0 / 保持 P1 / 忽略
```

用户做的是确认、批准、忽略和关联。后台再写入 `.solomap-global` 或 `.codex-memory`。

## `.solomap-global` 后台结构

建议第一版结构：

```text
.solomap-global/
├── portfolio.csv
├── dependencies.csv
├── capability-registry.csv
├── decision-conflicts.csv
├── learning/
│   ├── candidates/
│   ├── approved/
│   └── rejected/
├── metrics/
│   ├── execution-speed.csv
│   ├── reuse-rate.csv
│   ├── priority-accuracy.csv
│   └── monthly-summary.md
└── README.md
```

第一期 MVP 可以只实现：

```text
.solomap-global/
├── portfolio.csv
├── dependencies.csv
├── learning/
│   └── candidates/
└── README.md
```

### `portfolio.csv`

项目组合入口表。它回答：有哪些项目、当前状态是什么、下一步是什么。

建议字段：

```csv
id,name,path,type,status,priority,blocker,next_action,updated_at
```

字段含义：

- `id`：稳定项目 ID。
- `name`：用户可读项目名。
- `path`：本地项目路径。
- `type`：项目类型。
- `status`：当前状态。
- `priority`：P0 / P1 / P2 / P3。
- `blocker`：阻断原因，没有则为空。
- `next_action`：用户下一步动作。
- `updated_at`：最后更新时间。

写入来源：

- 添加项目。
- 新项目初始化。
- 用户设为本周重点。
- 依赖阻断变化。
- 路线图推进后状态变化。

### `dependencies.csv`

跨项目阻断表。它只记录会改变优先级的依赖，不记录普通关联。

建议字段：

```csv
from_project,to_project,capability,status,priority_impact,reason,updated_at
```

字段含义：

- `from_project`：被阻断的项目。
- `to_project`：需要先完成能力的项目。
- `capability`：依赖的能力。
- `status`：blocked / pending / satisfied。
- `priority_impact`：是否提升上游优先级。
- `reason`：用户语言说明。
- `updated_at`：最后更新时间。

UI 表达：

```text
SoloMap 正在等待 Cloudapi 的统一接入能力。
```

而不是：

```text
dependencies.csv: from_project=...
```

### `capability-registry.csv`

可复用能力索引。它不是代码注册表，而是“哪个能力在哪个项目验证过、后来被谁复用”。

建议字段：

```csv
capability,first_project,reused_by,status,reuse_success_rate,last_improvement
```

状态建议：

- `candidate`：刚从项目学习中提取，尚未验证可复用。
- `stable`：至少被两个项目使用。
- `deprecated`：不再推荐复用。

写入来源：

- 学习候选被批准。
- 新项目复用某个模式。
- 月度指标回填复用结果。

### `decision-conflicts.csv`

跨项目决策冲突表。它记录“多个项目做法不一致，是否需要统一”。

建议字段：

```csv
topic,projects,conflict,resolution,status,owner,updated_at
```

状态建议：

- `open`：等待确认。
- `resolved`：已形成全局决策。
- `accepted_difference`：确认保持差异。

确认后的稳定决策应提升到 `.codex-memory/decisions/`，而不是长期只留在 `.solomap-global`。

### `learning/`

学习候选流。它是从项目执行到长期记忆之间的缓冲层。

目录职责：

- `candidates/`：Agent 或系统自动生成，尚未审核。
- `approved/`：用户确认值得跨项目复用。
- `rejected/`：确认只是项目特例或价值不足。

候选文件建议格式：

```md
# 学习候选：{标题}

来源项目：
来源环节：
类型：pattern_candidate / decision_candidate / domain_note / project_note

## 可能复用的内容

## 适用场景

## 不适用场景

## 建议处理
```

提升规则：

- 模式进入 `.codex-memory/patterns/`。
- 决策进入 `.codex-memory/decisions/`。
- 领域知识进入 `.codex-memory/domains/`。
- 项目特例进入 `.codex-memory/projects/`。

### `metrics/`

指标只服务判断，不服务炫耀。

第一版跟踪：

- 同类环节耗时是否下降。
- 可复用能力是否被实际复用。
- 优先级判断是否准确。
- Issue 是否持续打断路线图。

这些指标进入月度回顾和 Improve 阶段，不要在主 UI 首屏堆满图表。

## 后台事件流

### 新项目加入

```text
用户添加项目
  -> 选择项目类型
  -> 写 portfolio.csv
  -> 查询相似项目和 patterns
  -> 生成或更新 .solopreneur/roadmap.csv
  -> 首次 Agent 对话带入全局起点
```

### 路线图环节启动

```text
用户在环节输入
  -> 同步当前 roadmap.csv
  -> 读取 step-memory 完成标准
  -> 查询 Issue 上下文
  -> 查询 .codex-memory 相关经验
  -> 查询 .solomap-global 阻断/依赖
  -> 生成 context pack
  -> 启动 Agent
```

### 环节完成后

```text
Agent 运行结束
  -> 更新 execution log
  -> 更新 step-memory
  -> 判断是否产生学习候选
  -> 写 learning/candidates/
  -> 更新 portfolio next_action
  -> 必要时更新 capability-registry 或 dependencies
```

### 每周审核

```text
用户打开审核工作台
  -> 查看 learning candidates
  -> 批准 / 留在项目 / 忽略
  -> 批准项提升到 .codex-memory
  -> 更新 capability-registry
  -> 记录决策冲突处理结果
```

### Improve 阶段

```text
进入 Improve 环节
  -> 聚合 Issue 历史
  -> 聚合学习候选和复用指标
  -> 生成路线图调整建议
  -> 用户确认是否调整路线图
```

## 关键产品约束

1. 全局优先级只影响推荐，不阻止用户执行。  
   用户必须仍然可以打开任何项目、任何环节讨论或准备。

2. 后台事实不能变成前台负担。  
   如果某个概念只是为了路由、存储、聚合或审计存在，就不要放进用户表单。

3. Issue 是输入和决策链，不是任务系统。  
   Roadmap 负责计划，Solo 负责自由问题，Issue 负责现实声音。

4. 学习先进入候选，不直接污染长期记忆。  
   只有跨项目复用概率高、边界清楚的内容才进入 `.codex-memory`。

5. `.solomap-global` 使用 Git 友好格式。  
   全局低频事实用 CSV / Markdown；单项目高频执行日志继续留在 `.solopreneur/project_journal.db`。

6. 用户语言优先。  
   UI 表达“项目 A 等待项目 B 的某个能力”，不表达“dependency row 处于 blocked”。

## 分期落地

### 阶段 1：基础全局层

目标：让 SoloMap 能看见多个项目，并给出本周行动建议。

范围：

- 创建 `.solomap-global/README.md`。
- 创建和维护 `portfolio.csv`。
- 创建和维护 `dependencies.csv`。
- 侧边栏展示 P0 / P1 / 可顺手处理。
- 新项目初始化支持项目类型选择。
- 环节结束生成 `learning/candidates/`。

验收：

- 用户打开侧边栏能看到本周最该推进的项目。
- 新项目不从空白开始，而是按类型获得路线图起点。
- 一个完成环节能产生学习候选。

### 阶段 2：复用与现实输入

目标：让已做过的东西进入下个项目的起点。

范围：

- Agent 启动前自动查询 `.codex-memory`。
- Issue 上下文进入 context pack。
- 每周审核工作台。
- `capability-registry.csv` 初版。
- `decision-conflicts.csv` 初版。

验收：

- 新项目初始化时能显示相似项目和可复用经验数量。
- 路线图环节 Agent 能自动获得相关 Issue 和历史经验。
- 用户能把学习候选批准提升到 `.codex-memory`。

### 阶段 3：复利指标与自适应建议

目标：让系统能证明复利是否发生，并辅助调整路线图。

范围：

- `metrics/` 初版。
- Improve 阶段读取 Issue 与复用统计。
- 跨项目冲突自动提示。
- 依赖阻断自动提升优先级建议。

验收：

- 月度回顾能看到哪些项目因复用节省了时间。
- Improve 阶段能基于 Issue 历史建议路线图缓冲或调整。
- 决策冲突能在规划阶段被提前发现。

## 第一版实现切口

建议从最小闭环开始：

1. 生成 `.solomap-global/README.md`，解释目录用途和误删风险。
2. 增加 `portfolio.csv` 的读写。
3. 在侧边栏项目卡片上显示全局优先级和下一步。
4. 增加 `learning/candidates/` 写入。
5. 在环节结束后生成一条学习候选。

这条切口能先验证全局体系是否真的降低用户判断成本，再继续扩展 capability、decision 和 metrics。
