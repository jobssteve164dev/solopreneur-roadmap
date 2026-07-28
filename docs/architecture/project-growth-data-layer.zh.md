# 项目生长数据层设计

## 这份文档解决什么判断

这份文档固定 SoloMap 在实现项目生长图之前，必须先补齐哪一层数据事实。

核心判断只有一句：**先建设项目生长数据层，再建设项目生长图 UI。**

没有稳定数据层，生长图只会变成漂亮的文件浏览器，不能解释项目如何长出来。

## 目标

项目生长数据层要让 SoloMap 能在本地稳定回答六类问题：

1. **结构**：项目由哪些模块、目录、入口和语言组成。
2. **职责**：这些结构服务哪些产品能力或用户动作。
3. **演化**：哪些区域最近在生长，哪些长期静止或反复返工。
4. **执行**：哪些 Agent 运行、路线图环节或 Solo 对话塑造了这些区域。
5. **证据**：哪些区域有验证、发布或失败信号。
6. **动作**：下一步应该推进、验证、修正、收口还是调整路线图。

## 不变边界

- `.solopreneur/roadmap.csv` 仍是路线图事实源。
- `execution_logs` 仍负责会话级历史。
- `run_records`、`run_files`、`run_signals` 仍负责 Agent 运行索引。
- `.solopreneur/agent-runs/` 仍保留原始审计材料。
- 项目生长数据层不替代 Git、测试、当前文件或用户输入。
- 项目生长图不替代路线图主入口，也不变成通用代码浏览器。

## 数据来源

项目生长数据层聚合五类事实源。

### 1. 文件系统

文件系统提供静态结构：

- 文件路径。
- 目录层级。
- 文件大小。
- 行数。
- 语言。
- 是否测试文件。
- 是否文档、配置、生成物或临时文件。

扫描时必须排除或降权：

- `node_modules/`
- `out/`
- `dist/`
- `build/`
- `.next/`
- `.solopreneur/agent-runs/`
- 数据库、日志、source map 等生成物。

这些文件可用于审计，但不应支配生长图面积。

### 2. Git

Git 提供演化事实：

- 最近提交时间。
- 最近变更次数。
- 当前工作区改动。
- 文件 churn。
- rename / delete 线索。
- commit 与文件关系。

Git 失败或项目不是 Git 仓库时，生长层仍应可用，只是演化信号降级。

### 3. Import / Dependency Graph

依赖扫描提供结构关系：

- JS/TS import / export。
- 相对路径依赖。
- package 边界。
- 入口文件。
- 被依赖热度。
- 可能的循环依赖。

第一版优先支持当前 SoloMap 技术栈中的 JS/TS。后续可按语言扩展。

依赖扫描不做完成判断。它只提供“代码结构如何连接”的证据。

### 4. SoloMap Run Index

运行索引提供执行事实：

- `run_records`：哪次运行、哪个 Agent、什么状态、耗时。
- `run_files`：哪次运行触碰了哪些文件。
- `run_signals`：验证、失败、可复用信号。
- Run Digest：用户意图、结果、handoff、建议文件和验证。
- Execution Graph：run 与文件、环节、状态、失败、命令之间的关系。

这些事实把代码结构从静态文件树变成“被项目推进塑造过的结构”。

### 5. Roadmap / Delivery / Feedback Signals

路线图和交付信号提供产品归属：

- 路线图阶段。
- 路线图环节状态。
- 完成标准。
- GitHub Issue / PR / Actions / Release。
- 安全、发布或反馈信号。

这些信号用于判断代码是否支撑真实项目推进，而不是只在仓库里存在。

## 存储模型

项目生长快照与分析轨迹进入独立的 `project_growth.db`，作为高频查询模型；路线图、Agent 对话和运行索引继续由 `project_journal.db` 提供。扫描时读取两者并在内存中融合，避免路线图同步或运行索引更新覆盖历史生长快照。UI 查询不依赖读取大量 JSON 文件。

运行时覆盖是独立的低频验证证据，不进入通用生长扫描主路径：

- 用户明确执行“运行验证分析”时，由打包的 `c8` 包裹项目现有 `npm test`。
- Istanbul JSON 原始报告和聚合缓存保存在 `.solopreneur/coverage/`。
- 普通页面加载只按文件修改时间读取小型聚合缓存，并在进程内复用；不启动测试、不解析原始 V8 数据。
- 新报告生成失败时保留上一份成功结果，并记录本次失败状态；静态 `tested_by` 关系只作为无运行时报告时的降级证据。
- 同一项目的并发分析请求合并为一个进程，避免重复运行完整测试。

建议新增五组表。

### `growth_snapshots`

记录一次项目生长扫描。

建议字段：

- `id`
- `createdAt`
- `projectPath`
- `gitHead`
- `scanReason`
- `status`
- `durationMs`
- `error`

### `growth_nodes`

记录文件、目录、模块和能力节点。

建议字段：

- `snapshotId`
- `nodeId`
- `parentId`
- `kind`：`file | directory | module | capability`
- `path`
- `label`
- `language`
- `bytes`
- `loc`
- `fileCount`
- `testFileCount`
- `generated`
- `excluded`
- `primaryRole`
- `confidence`

`module` 和 `capability` 不一定等同于目录。一个能力可以覆盖多个文件或目录。

### `growth_edges`

记录节点之间的关系。

建议字段：

- `snapshotId`
- `sourceId`
- `targetId`
- `kind`：`contains | imports | depends_on | implements | tested_by | shaped_by_run | belongs_to_step`
- `weight`
- `evidence`

### `growth_signals`

记录生长信号。

建议字段：

- `snapshotId`
- `nodeId`
- `type`：`activity | risk | verification | failure | delivery | ownership | recommendation`
- `level`：`info | watch | attention | blocked`
- `value`
- `source`
- `sourceRef`
- `createdAt`

### `growth_module_labels`

记录模块和能力归类。

建议字段：

- `nodeId`
- `label`
- `role`
- `source`：`rule | agent | user | import_graph | roadmap`
- `confidence`
- `updatedAt`

这张表允许 SoloMap 逐步从路径推断走向稳定产品能力映射。

## 扫描管线

项目生长数据层的扫描分为六步。

### 1. 结构扫描

读取文件树，计算目录、文件、语言、行数、大小和基础类型。

输出：

- 文件节点。
- 目录节点。
- `contains` 边。

### 2. 依赖扫描

解析 JS/TS import/export，建立文件到文件、模块到模块的依赖关系。

输出：

- `imports` 边。
- `depends_on` 边。
- 入口和被依赖热度信号。

### 3. 模块聚合

基于路径、package、入口、文件名、测试、文档和 import graph，把文件聚合为模块。

模块身份必须来自用户能核对的真实源码边界：优先使用源码子目录，其次使用同一目录中的文件名前缀族。Import graph 用于连接模块、判断主干和影响范围，不得直接把整个依赖连通分量当成一个模块；否则一个入口文件就会把大半个项目吞成含糊的大块。同一模块身份在一次扫描中只能出现一次，来自不同连通分量的同名文件族必须先合并，再计算体量、信号与关系。

项目运行数据、Agent 审计材料、依赖缓存、生成物和根目录锁文件不属于项目模块。它们可以作为证据源参与判断，但不得进入模块数量、面积或协同关系主图。

第一版规则示例：

- `src/db/**` -> 数据层。
- `src/*Webview.ts` -> Webview 界面层。
- `src/agent*.ts`、`src/run*.ts` -> Agent 执行与运行记录。
- `test/**` -> 验证层。
- `docs/**` -> 项目知识层。

规则只是起点。后续可用 Agent 归纳和用户确认修正模块标签。

### 4. 路线图和能力映射

把模块映射到产品能力或路线图环节。

来源：

- 文件被哪些 run 触碰。
- run 属于哪个 nodeId / runKind。
- Run Digest 的用户意图和 outcome。
- 文档和文件名中的能力线索。
- 已确认的 `growth_module_labels`。

输出：

- `implements` 边。
- `belongs_to_step` 边。
- 能力节点。

### 5. 执行与证据融合

把 `run_files`、`run_signals`、Run Digest、Execution Graph 聚合到模块和能力。

输出：

- Agent 触碰次数。
- 最近运行时间。
- 完成、失败、停止、待验证状态。
- 验证命令和失败摘要。
- `shaped_by_run` 边。

### 6. 风险和建议生成

基于结构、演化、执行和证据生成信号。

第一版规则：

- 大入口文件且被多模块依赖 -> `attention`
- 最近高 churn 且缺验证信号 -> `attention`
- 同一模块多次运行失败 -> `blocked`
- 有代码变更但无路线图归属 -> `watch`
- 主路径模块长期无验证 -> `watch`
- 测试文件覆盖缺口明显 -> `attention`
- 完成环节有对应代码和验证 -> `info`

这些信号用于指导用户下一步，不用于替代测试或代码审查。

## UI 查询模型

项目生长图 UI 不应直接理解所有底层表。数据层应提供聚合接口：

### 项目总览

回答：

- 主要能力数量。
- 主要模块数量。
- 正在生长的区域。
- 需要关注的区域。
- 缺验证的区域。

### 项目构成关系

默认阅读顺序固定为：

```text
产品能力 -> 实现模块 -> 模块调用/外部依赖 -> 验证模块
```

主图只消费聚合后的模块级关系。文件级 import、内部索引节点和扫描器对象只用于下钻与审计，不能直接占据默认关系图。

### Treemap 数据

每个节点提供：

- `id`
- `label`
- `kind`
- `path`
- `sizeWeight`
- `colorSignal`
- `status`
- `children`

面积默认由 `loc/fileCount/roleWeight` 综合决定，不应只用文件大小。

### 节点详情

点击节点后提供：

- 这块负责什么。
- 关联能力。
- 关联路线图环节。
- 最近 Agent 运行。
- 最近 Git 变化。
- 验证和失败信号。
- 下一步建议。

### 缺口列表

提供不依赖 treemap 的行动列表：

- 缺验证。
- 缺路线图归属。
- 反复失败。
- 入口过重。
- 长期未维护主路径。

这保证用户即使不研究图，也能知道下一步。

## 刷新策略

扫描不能阻塞用户主路径。

建议策略：

- 项目打开后先显示旧快照。
- 后台异步刷新结构和 Git 信号。
- Agent run 完成后增量刷新受影响文件和模块。
- 用户手动点击刷新时允许完整重扫。
- 大项目扫描应分阶段产出，先结构、后依赖、后风险。

扫描失败时：

- 保留上次快照。
- 明确显示“结构数据未刷新”。
- 不影响路线图、Solo 对话和 Agent 执行。

## 与 Harness Enhancement 的关系

已有“代码结构辅助”增强面向 Agent 执行效率。项目生长数据层面向 SoloMap 产品事实模型。

两者关系：

- 项目生长数据层是内置主数据层。
- CodeGraph 等增强可以补充 symbol、call graph 和影响半径。
- 增强失败时，项目生长层仍应通过文件系统、Git、import graph 和 run index 工作。
- 增强输出必须被转成 SoloMap 自己的节点、边和信号，不能把第三方内部模型直接暴露给用户。

## 与执行轨迹面板的关系

执行轨迹面板回答“某次目标如何被执行、验证和归因”。  
项目生长图回答“这些执行长期塑造了项目哪里”。

关系如下：

```text
执行轨迹
  -> run / loop / evidence
  -> 文件和模块
  -> 能力节点
  -> 项目生长图
```

用户可以从生长图下钻到执行轨迹，但生长图默认不展示原始循环列表。

## 数据质量要求

项目生长数据层必须显式区分事实和推断。

事实：

- 文件存在。
- Git 记录。
- run 触碰文件。
- 测试命令记录。
- 路线图状态。

推断：

- 模块职责。
- 能力归属。
- 风险等级。
- 下一步建议。

推断必须带 `source` 和 `confidence`。低置信推断可以展示为“可能属于”，不能伪装成已确认事实。

## 首版验收标准

首版数据层完成时，应能对任一当前项目输出：

1. 项目主要目录和模块的体量分布。
2. JS/TS 文件之间的基础依赖关系。
3. 最近 Agent 运行触碰的模块。
4. 路线图环节到模块的关联。
5. 模块级验证、失败和缺口信号。
6. 可供 UI 直接消费的 treemap 数据。
7. 可供用户行动的缺口列表。

如果只能输出文件树和大小，首版不算完成。

## 禁止项

- 禁止把项目生长图做成新的聊天中心。
- 禁止把原始日志、prompt 或终端输出放进默认 UI。
- 禁止让用户维护 schema、节点、边、digest 或索引。
- 禁止用第三方 CodeGraph 结果替代当前文件和测试。
- 禁止把文件大小当成重要性的唯一依据。
- 禁止让扫描失败阻断路线图、Solo 或 Agent 主路径。
- 禁止把低置信职责推断当成确定事实。
