# 运行索引数据库层

## 目标

SoloMap 的运行数据分为两层：

- `project_journal.db` 负责结构化索引和高频查询。
- `.solopreneur/agent-runs/` 负责原始审计材料，保留完整命令、prompt、输出和工作区变更记录。

这个边界的目的不是把所有运行日志搬进数据库，而是让数据库承担它擅长的职责：快速回答“跑了什么、谁跑的、结果怎样、影响哪些文件、有哪些验证或失败信号”。

## 不变边界

- `.solopreneur/roadmap.csv` 仍是路线图节点的 Git 可读事实源。
- `execution_logs` 仍保存会话级摘要，用于最近对话、节点历史和生命周期展示。
- 完整 `output.log` 不进入数据库。数据库只保存输出路径、大小和有限尾部摘要。
- 原始运行目录仍是审计、复盘和深度排障入口。
- 数据库写入失败不得把一次已经完成的 Agent 运行改判失败；运行结果和索引健康是两个问题。

## 数据模型

第一阶段新增三张索引表：

- `run_records`：一条 Agent 运行的核心索引。
  - `executionLogId`
  - `nodeId`
  - `runKind`
  - `agentCli`
  - `status`
  - `startedAt`
  - `finishedAt`
  - `durationMs`
  - `outputPath`
  - `outputBytes`
  - `outputTail`
  - `commandPath`
  - `promptPath`
  - `changesPath`
  - `touchedFilesPath`
  - `updatedAt`
- `run_files`：运行触达的文件索引。
  - `executionLogId`
  - `filePath`
  - `role`
- `run_signals`：运行中的结构化信号。
  - `executionLogId`
  - `type`
  - `value`

## 第一阶段闭环

第一阶段完成的行为闭环：

1. 插件启动时确保旧数据库自动补齐运行索引表和索引。
2. Agent 运行结束时写入 `run_records`、`run_files`、`run_signals`。
3. Agent 贡献统计优先读取数据库索引。
4. 数据库没有索引数据时，继续回落到 `run-digests`；再没有时才读取 `.solopreneur/agent-runs/` 的轻量尾部信息。
5. 运行索引写入结果进入会话摘要，方便发现 DB 索引故障。

## 第二阶段闭环

第二阶段完成项目投资统计迁移：

- `projectAnalytics` 增加 DB 优先的异步统计入口。
- `projectPortfolio` 支持接收预加载的投资统计，保持原同步构建函数兼容。
- 侧边栏 portfolio enrichment 使用数据库索引统计刷新项目投资数据。
- 数据库没有运行索引时，仍回落到 `run-digests`；再没有时回落到轻量尾读原始运行目录。
- 初始 sidebar 占位、日报、策略塔等同步调用链继续使用原同步入口，避免为了 `sql.js` 异步初始化扩大风险面。

这意味着用户打开侧边栏时会先看到同步兜底数据，随后 enrichment 刷新为 DB 优先的投资统计；旧项目和无索引项目仍可正常显示。

## 后续阶段

第三阶段补齐治理和修复：

- 增加从 `run-digests` 回填 `run_records` 的显式修复动作。
- 在本地数据状态中展示运行索引健康度。
- 对异常索引写入提供可定位错误，而不是让用户理解 SQLite 表结构。
